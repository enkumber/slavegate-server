/**
 * task-runner/task-runner.service.ts
 * Task Runner — Polls tasks from DB, executes via orchestrator
 * 
 * Lifecycle:
 *   queued → running → completed/failed
 * 
 * Features:
 *   - Poll interval configurabil (default 30s)
 *   - Device lock (1 task per device simultan)
 *   - Rate limit respectat (min gap între tasks pe device)
 *   - Auto-retry cu backoff
 */

import { getDb } from "../../db/client";
import { agentOrchestrator } from "../agents/orchestrator";
import { isDeviceOnline } from "../../transport/transport";
import type { TaskResult } from "../agents/types";
import { llmJson } from "../../utils/llm";
import {
  generatedWorkflowCacheLookups,
  generatedWorkflowExecutions,
  generatedWorkflowLlmAvoided,
  generatedWorkflowTaskRunnerDispatches,
} from "../observability/metrics";
import { dispatchGeneratedWorkflowTemplate } from "../workflows/generated-workflow-execution.service";
import type { GeneratedWorkflowControlPlaneContext } from "../workflows/generated-workflow-execution.service";
import type { WorkflowTemplate } from "../workflows/types";
import {
  workflowService,
  type GeneratedWorkflowPlanCacheRecord,
  type WorkflowRecord,
} from "../workflows/workflow.service";
import { compileGeneratedWorkflowTemplate } from "../workflows/workflow-validator";
import { workflowEvents } from "../workflow-events";
import { assertHumanWorkflowMeaningful } from "../human-workflow/human-workflow-compiler.service";
import { normalizeCachedHumanWorkflowTemplate } from "../human-workflow/human-workflow-normalization";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  account_id: string | null;
  device_id: string;
  routine: string;
  params: Record<string, unknown>;
  scheduled_time: Date;
  status: string;
  started_at?: Date;
  completed_at?: Date;
  retry_count?: number;
  updated_at?: Date;
}

export interface TaskRunnerConfig {
  pollIntervalMs: number;
  minGapBetweenTasksMs: number;
  batchSize: number;
  maxRetries: number;
  retryBackoffMs: number;
}

interface TaskRunnerResult extends TaskResult {
  output?: Record<string, unknown>;
  generatedWorkflow?: {
    workflowId?: string;
    status?: "queued" | "running";
    mode?: "edge" | "server";
    templateId?: string;
    cacheKey?: string;
    requestKey?: string | null;
    canonicalWorkflowId?: string;
    canonicalWorkflowVersion?: string;
    compiledPlanHash?: string;
    llmBudget?: GeneratedWorkflowPlanCacheRecord["compiledPlan"]["llmBudget"];
    controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
    output?: Record<string, unknown>;
    failureCode?: string;
  };
}

const DEFAULT_CONFIG: TaskRunnerConfig = {
  pollIntervalMs: 30_000,           // 30 seconds
  minGapBetweenTasksMs: 60_000,     // 1 minute gap between tasks on same device
  batchSize: 10,
  maxRetries: 3,                    // 3 retries: 5s, 15s, 45s (exponential backoff)
  retryBackoffMs: 5_000,            // Base backoff: 5 * 3^retry_count seconds
};

function publishGeneratedWorkflowTaskEvent(
  task: TaskRow,
  event: "task_running" | "task_completed" | "task_failed",
  details: Record<string, unknown> = {},
): void {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE) return;
  const clientId = typeof task.params?.clientId === "string" ? task.params.clientId : undefined;
  const agencyWorkflowRunId = agencyWorkflowRunIdFromTask(task) ?? undefined;
  workflowEvents.publish({
    source: "task_runner",
    event,
    workflowId: typeof details.workflowId === "string" ? details.workflowId : undefined,
    taskId: task.id,
    agencyWorkflowRunId,
    clientId,
    ...(task.account_id ? { accountId: task.account_id } : {}),
    deviceId: task.device_id,
    status: event.replace("task_", ""),
    details: {
      routine: task.routine,
      ...details,
    },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_WORKFLOW_ROUTINE = "generated_workflow";
const GENERATED_WORKFLOW_FINAL_POLL_INTERVAL_MS = 2_000;
const GENERATED_WORKFLOW_FINAL_TIMEOUT_MS = 180_000;

function zeroTokenUsage(): TaskResult["tokenUsage"] {
  return {
    planner: { input: 0, output: 0 },
    executor: { input: 0, output: 0, calls: 0 },
    verifier: { input: 0, output: 0, calls: 0 },
    total: 0,
  };
}

function generatedWorkflowTaskSource(cacheKey?: string, requestKey?: string): "cache_key" | "request_key" {
  return cacheKey ? "cache_key" : requestKey ? "request_key" : "request_key";
}

function generatedWorkflowTaskCacheResult(cacheKey?: string, requestKey?: string): "cache_hit" | "canonical_hit" {
  return requestKey && !cacheKey ? "canonical_hit" : "cache_hit";
}

function generatedWorkflowTaskFailure(
  code: string,
  reason: string,
  startedAt: number,
  cached?: GeneratedWorkflowPlanCacheRecord | null,
): TaskRunnerResult {
  return {
    success: false,
    stepsCompleted: 0,
    totalSteps: cached?.workflow.steps.length ?? 0,
    failReason: `${code}: ${reason}`,
    tokenUsage: zeroTokenUsage(),
    durationMs: Date.now() - startedAt,
    generatedWorkflow: {
      failureCode: code,
      cacheKey: cached?.cacheKey,
      requestKey: cached?.requestKey,
      canonicalWorkflowId: cached?.canonicalWorkflowId,
      canonicalWorkflowVersion: cached?.canonicalWorkflowVersion,
      compiledPlanHash: cached?.compiledPlanHash,
      llmBudget: cached?.compiledPlan.llmBudget,
    },
  };
}

function generatedWorkflowOutputDefaults(cached: GeneratedWorkflowPlanCacheRecord): Record<string, unknown> {
  const schema = cached.workflow.outputSchema;
  if (!schema) return {};

  const defaults: Record<string, unknown> = {};
  for (const key of schema.required) {
    if (key === "error" || key === "observedUsername") {
      defaults[key] = "";
    } else {
      defaults[key] = "unknown";
    }
  }
  return defaults;
}

function generatedWorkflowOutput(cached: GeneratedWorkflowPlanCacheRecord, variables: Record<string, unknown>): Record<string, unknown> {
  const schema = cached.workflow.outputSchema;
  if (!schema) return {};

  const output: Record<string, unknown> = {};
  for (const key of schema.required) {
    output[key] = Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : null;
  }
  return output;
}

function sourceMetadataValue(cached: GeneratedWorkflowPlanCacheRecord, key: string): unknown {
  return cached.sourceMetadata && typeof cached.sourceMetadata === "object"
    ? cached.sourceMetadata[key]
    : undefined;
}

function extractUiTreeEvidence(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const uiTree = record.uiTree ?? record.tree ?? record.nodes;
  if (typeof uiTree === "string") return uiTree;
  if (uiTree && typeof uiTree === "object") return JSON.stringify(uiTree);
  return JSON.stringify(record);
}

function humanIntentRequestsComments(intent: string, cached: GeneratedWorkflowPlanCacheRecord): boolean {
  if (/\bcomments?\b|comentarii|sectiunea de comentarii|secțiunea de comentarii/i.test(intent)) return true;
  return cached.workflow.steps.some((step) =>
    step.type === "action" &&
    step.action === "semantic_tap" &&
    step.params &&
    (step.params as Record<string, unknown>).target === "reddit.first_visible_post.open_comments"
  );
}

function uiTreeLooksLikeRedditComments(uiTreeText: string): boolean {
  const normalized = uiTreeText.toLowerCase();
  if (!normalized.includes("com.reddit.frontpage")) return false;
  if (normalized.includes("inbox_screen") || normalized.includes("activity_title") || normalized.includes("notificationsscreen")) {
    return false;
  }
  return (
    normalized.includes("comment_list") ||
    normalized.includes("comments_list") ||
    normalized.includes("comment_layout") ||
    normalized.includes("comment_header") ||
    normalized.includes("search comments") ||
    normalized.includes("sort comments") ||
    normalized.includes("add a comment") ||
    normalized.includes("join the conversation") ||
    normalized.includes("/comments/")
  );
}

function humanIntentRequestsAppInstall(intent: string): boolean {
  return /\b(instaleaza|instalează|instalez|instalare|install|download|descarca|descarcă|actualizeaza|actualizează|update)\b/.test(intent) &&
    /\b(reddit|com\.reddit\.frontpage)\b/.test(intent);
}

function validateRedditInstallEvidence(uiTreeText: string): string | null {
  const normalized = uiTreeText.toLowerCase();
  if (!normalized) {
    return "HUMAN_WORKFLOW_APP_INSTALL_NOT_VERIFIED: final install evidence was empty";
  }
  if (
    normalized.includes("sign in") ||
    normalized.includes("signin") ||
    normalized.includes("add account") ||
    normalized.includes("google account") ||
    normalized.includes("choose an account") ||
    normalized.includes("not signed in") ||
    normalized.includes("conectează-te") ||
    normalized.includes("conecteaza-te") ||
    normalized.includes("adaugă un cont") ||
    normalized.includes("adauga un cont")
  ) {
    return "HUMAN_WORKFLOW_APP_INSTALL_BLOCKED: Google Play requires a signed-in Google account";
  }
  if (normalized.includes("com.reddit.frontpage")) return null;
  if (!normalized.includes("com.android.vending")) {
    return "HUMAN_WORKFLOW_APP_INSTALL_NOT_VERIFIED: Play Store or Reddit was not visible in final evidence";
  }
  const hasOpen = /\bopen\b|\bdeschide\b/.test(normalized);
  const hasUninstall = /\buninstall\b|\bdezinstalează\b|\bdezinstaleaza\b/.test(normalized);
  const stillInstallable = /\binstall\b|\binstalează\b|\binstaleaza\b/.test(normalized);
  const updatingOrPending =
    /\bupdate\b|\bactualizează\b|\bactualizeaza\b|\bpending\b|\bwaiting\b|\binstalling\b|\bse instalează\b|\bse instaleaza\b/.test(normalized);
  if (hasOpen || hasUninstall) return null;
  if (stillInstallable) {
    return "HUMAN_WORKFLOW_APP_INSTALL_NOT_COMPLETED: Reddit is still installable in Play Store";
  }
  if (updatingOrPending) {
    return "HUMAN_WORKFLOW_APP_INSTALL_NOT_COMPLETED: Reddit install did not finish before final verification";
  }
  return "HUMAN_WORKFLOW_APP_INSTALL_NOT_VERIFIED: Reddit install success was not visible in final evidence";
}

function validateHumanWorkflowFinalEvidence(
  cached: GeneratedWorkflowPlanCacheRecord,
  variables: Record<string, unknown>,
): string | null {
  if (sourceMetadataValue(cached, "source") !== "dashboard_human") return null;
  const intent = String(sourceMetadataValue(cached, "intent") ?? "").toLowerCase();
  if (!intent) return null;

  const needsUiEvidence = cached.workflow.steps.some((step) =>
    step.type === "action" &&
    step.params &&
    typeof step.params.outputVariable === "string"
  );
  if (needsUiEvidence && !variables._finalUiTree) {
    return "HUMAN_WORKFLOW_FINAL_EVIDENCE_MISSING: final UI evidence was not captured";
  }

  if (intent.includes("askreddit") || intent.includes("/askreddit")) {
    const uiTreeText = extractUiTreeEvidence(variables._finalUiTree).toLowerCase();
    if (!uiTreeText.includes("com.reddit.frontpage")) {
      return "HUMAN_WORKFLOW_TARGET_NOT_REACHED: Reddit was not visible in final UI evidence";
    }
    if (!uiTreeText.includes("askreddit") && !uiTreeText.includes("r/askreddit")) {
      return "HUMAN_WORKFLOW_TARGET_NOT_REACHED: AskReddit was not visible in final UI evidence";
    }
  }

  if (humanIntentRequestsComments(intent, cached)) {
    const uiTreeText = extractUiTreeEvidence(variables._finalUiTree);
    if (!uiTreeLooksLikeRedditComments(uiTreeText)) {
      return "HUMAN_WORKFLOW_TARGET_NOT_REACHED: Reddit comments were not visible in final UI evidence";
    }
  }

  if (humanIntentRequestsAppInstall(intent)) {
    const uiTreeText = extractUiTreeEvidence(variables._finalUiTree);
    const installFailure = validateRedditInstallEvidence(uiTreeText);
    if (installFailure) return installFailure;
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkpointVariables(workflow: WorkflowRecord | null): Record<string, unknown> {
  if (!workflow?.checkpoint) return {};
  const checkpoint = workflow.checkpoint as unknown as {
    variables?: unknown;
    result?: { variables?: unknown };
  };

  const variables = checkpoint.variables && typeof checkpoint.variables === "object" && !Array.isArray(checkpoint.variables)
    ? checkpoint.variables as Record<string, unknown>
    : {};
  const resultVariables = checkpoint.result?.variables && typeof checkpoint.result.variables === "object" && !Array.isArray(checkpoint.result.variables)
    ? checkpoint.result.variables as Record<string, unknown>
    : {};

  return { ...variables, ...resultVariables };
}

async function waitForGeneratedWorkflowFinal(workflowId: string): Promise<WorkflowRecord> {
  const startedAt = Date.now();
  let latest: WorkflowRecord | null = null;

  while (Date.now() - startedAt < GENERATED_WORKFLOW_FINAL_TIMEOUT_MS) {
    latest = await workflowService.get(workflowId);
    if (!latest) {
      throw new Error(`Generated workflow ${workflowId} not found after dispatch`);
    }
    if (latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled") {
      return latest;
    }
    await sleep(GENERATED_WORKFLOW_FINAL_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Generated workflow ${workflowId} did not reach a final status within ${GENERATED_WORKFLOW_FINAL_TIMEOUT_MS}ms; latest=${latest?.status ?? "missing"}`,
  );
}

function agencyWorkflowRunIdFromTask(task: TaskRow): string | null {
  const value = task.params?.agencyWorkflowRunId ?? task.params?.workflowRunId;
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

async function markAgencyWorkflowRunStarted(task: TaskRow): Promise<void> {
  const runId = agencyWorkflowRunIdFromTask(task);
  if (!runId) return;
  const db = getDb();
  await db.query(
    `UPDATE agency_workflow_runs
     SET status = 'running', started_at = COALESCE(started_at, NOW())
     WHERE id = $1`,
    [runId],
  );
}

async function completeAgencyWorkflowRun(task: TaskRow, result: TaskRunnerResult): Promise<void> {
  const runId = agencyWorkflowRunIdFromTask(task);
  if (!runId) return;
  const db = getDb();
  const generatedWorkflow = result.generatedWorkflow ?? {};
  const output = result.output ?? generatedWorkflow.output ?? {};
  await db.query(
    `UPDATE agency_workflow_runs
     SET status = $2,
         workflow_id = COALESCE($3, workflow_id),
         output = $4,
         token_usage = $5,
         recovery_requests = $6,
         error = $7,
         completed_at = NOW()
     WHERE id = $1`,
    [
      runId,
      result.success ? "completed" : "failed",
      generatedWorkflow.workflowId ?? null,
      JSON.stringify(output),
      JSON.stringify(result.tokenUsage ?? zeroTokenUsage()),
      0,
      result.success ? null : result.failReason ?? "Unknown error",
    ],
  );
}

async function recordGeneratedWorkflowLearning(task: TaskRow, result: TaskRunnerResult): Promise<void> {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE) return;
  const cacheKey = result.generatedWorkflow?.cacheKey;
  if (!cacheKey) return;
  try {
    await workflowService.recordGeneratedPlanCacheOutcome({
      cacheKey,
      success: result.success,
      reason: result.success ? null : result.failReason ?? result.generatedWorkflow?.failureCode ?? "Unknown error",
      taskId: task.id,
      workflowId: result.generatedWorkflow?.workflowId ?? null,
      agencyWorkflowRunId: agencyWorkflowRunIdFromTask(task),
      stepsCompleted: result.stepsCompleted ?? null,
      totalSteps: result.totalSteps ?? null,
    });
  } catch (err) {
    console.error("[task-runner] generated workflow learning update failed:", err);
  }
}

type WorkflowRepairResponse = {
  workflow?: WorkflowTemplate;
  rationale?: string;
  expectedFix?: string;
  confidence?: number;
};

function compactWorkflowForRepair(workflow: WorkflowTemplate): Record<string, unknown> {
  return {
    id: workflow.id,
    name: workflow.name,
    platform: workflow.platform,
    description: workflow.description,
    version: workflow.version,
    intent: workflow.intent,
    safetyClass: workflow.safetyClass,
    outputSchema: workflow.outputSchema,
    allowedRecoveryRequests: workflow.allowedRecoveryRequests,
    recoveryPolicy: workflow.recoveryPolicy,
    defaultVerificationStrategy: workflow.defaultVerificationStrategy,
    dataRetentionDays: workflow.dataRetentionDays,
    compatibleAppVersions: workflow.compatibleAppVersions,
    steps: workflow.steps,
  };
}

function normalizeRepairedWorkflow(candidate: unknown, base: WorkflowTemplate): WorkflowTemplate | null {
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Partial<WorkflowTemplate>;
  const versionParts = String(base.version || "1.0.0").split(".");
  const major = Number(versionParts[0] ?? 1) || 1;
  const minor = Number(versionParts[1] ?? 0) || 0;
  const patch = (Number(versionParts[2] ?? 0) || 0) + 1;
  const repairedId = typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : `${base.id}_repair_${Date.now()}`;
  const repairedVersion = typeof record.version === "string" && record.version.trim()
    ? record.version.trim()
    : `${major}.${minor}.${patch}`;
  return {
    ...base,
    ...record,
    id: repairedId,
    name: typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : `${base.name} repaired`,
    platform: typeof record.platform === "string" && record.platform.trim() ? record.platform.trim() : base.platform,
    description: typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : `${base.description} Repaired after failed execution.`,
    version: repairedId === base.id && repairedVersion === base.version ? `${major}.${minor}.${patch}` : repairedVersion,
    intent: typeof record.intent === "string" ? record.intent : base.intent,
    safetyClass: record.safetyClass === "read_only" || record.safetyClass === "standard" ? record.safetyClass : base.safetyClass,
    outputSchema: record.outputSchema ?? base.outputSchema,
    allowedRecoveryRequests: Array.isArray(record.allowedRecoveryRequests)
      ? record.allowedRecoveryRequests
      : base.allowedRecoveryRequests,
    recoveryPolicy: record.recoveryPolicy ?? base.recoveryPolicy,
    defaultVerificationStrategy: record.defaultVerificationStrategy ?? base.defaultVerificationStrategy,
    dataRetentionDays: typeof record.dataRetentionDays === "number" ? record.dataRetentionDays : base.dataRetentionDays,
    compatibleAppVersions: Array.isArray(record.compatibleAppVersions)
      ? record.compatibleAppVersions
      : base.compatibleAppVersions,
    steps: Array.isArray(record.steps) ? record.steps : base.steps,
  };
}

function buildWorkflowRepairPrompt(
  cached: GeneratedWorkflowPlanCacheRecord,
  task: TaskRow,
  result: TaskRunnerResult,
): string {
  const failure = {
    failReason: result.failReason ?? "Unknown error",
    failedStep: result.failedStep ?? null,
    stepsCompleted: result.stepsCompleted ?? null,
    totalSteps: result.totalSteps ?? null,
    output: result.output ?? result.generatedWorkflow?.output ?? {},
    taskParams: task.params,
  };
  return [
    "A generated Android workflow failed. Create a repaired workflow artifact that can be retried deterministically.",
    "",
    "Hard requirements:",
    "- Return ONLY JSON.",
    "- JSON shape: {\"workflow\": WorkflowTemplate, \"rationale\": string, \"expectedFix\": string, \"confidence\": number}.",
    "- Preserve the user's original intent and output schema.",
    "- Happy path must remain deterministic: no LLM/VLM actions in workflow steps.",
    "- Use only safe generated workflow actions already present in the existing workflow DSL.",
    "- Prefer UI tree observation, app open, wait, navigation, retryable taps, and checkpoint steps.",
    "- Do not post, submit, send messages, purchase, delete, change password, or perform irreversible social actions unless the original workflow already required it.",
    "- Add verification/evidence steps near the failure point when needed.",
    "",
    `Original source metadata: ${JSON.stringify(cached.sourceMetadata)}`,
    `Failure: ${JSON.stringify(failure)}`,
    `Current workflow: ${JSON.stringify(compactWorkflowForRepair(cached.workflow))}`,
  ].join("\n");
}

async function attemptGeneratedWorkflowRepair(task: TaskRow, result: TaskRunnerResult): Promise<void> {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE || result.success) return;
  const cacheKey = result.generatedWorkflow?.cacheKey;
  if (!cacheKey) return;

  let cached: GeneratedWorkflowPlanCacheRecord | null = null;
  try {
    cached = await workflowService.getGeneratedPlanCacheForRepair(cacheKey);
  } catch (err) {
    console.error("[task-runner] generated workflow repair lookup failed:", err);
    return;
  }
  if (!cached?.requestKey) return;

  const learning = cached.sourceMetadata?.workflowLearning as Record<string, unknown> | undefined;
  const repair = cached.sourceMetadata?.workflowRepair as Record<string, unknown> | undefined;
  if (repair?.status === "candidate_generated" && repair?.sourceCacheKey === cacheKey) return;
  if (typeof learning?.failureCount === "number" && learning.failureCount > 3) return;

  try {
    const response = await llmJson<WorkflowRepairResponse>(
      buildWorkflowRepairPrompt(cached, task, result),
      undefined,
      {
        max_tokens: 4096,
        timeoutMs: 90_000,
        temperature: 0.1,
        system: "You repair failed Android generated workflow templates. Respond only with valid JSON.",
      },
    );
    const repaired = normalizeRepairedWorkflow(response.workflow ?? response, cached.workflow);
    if (!repaired) {
      throw new Error("repair response did not include a workflow object");
    }
    const compiledPlan = compileGeneratedWorkflowTemplate(repaired);
    await workflowService.saveTemplate(repaired);
    await workflowService.saveGeneratedPlanCache(repaired, compiledPlan, cached.requestKey, {
      artifactState: "candidate",
      replaceRequestKeyArtifacts: false,
      sourceMetadata: {
        ...cached.sourceMetadata,
        source: "llm_repair",
        repairOfCacheKey: cached.cacheKey,
        repairOfWorkflowId: cached.workflow.id,
        workflowRepair: {
          status: "candidate_generated",
          sourceCacheKey: cached.cacheKey,
          sourceWorkflowId: cached.workflow.id,
          sourceWorkflowVersion: cached.workflow.version,
          repairedWorkflowId: repaired.id,
          repairedWorkflowVersion: repaired.version,
          repairedCacheKey: compiledPlan.cacheKey,
          reason: result.failReason ?? result.generatedWorkflow?.failureCode ?? "Unknown error",
          taskId: task.id,
          workflowId: result.generatedWorkflow?.workflowId ?? null,
          agencyWorkflowRunId: agencyWorkflowRunIdFromTask(task),
          rationale: response.rationale ?? null,
          expectedFix: response.expectedFix ?? null,
          confidence: typeof response.confidence === "number" ? response.confidence : null,
          generatedAt: new Date().toISOString(),
          nextAction: "retry_task_with_repaired_candidate",
        },
      },
    });
    console.log(`[task-runner] Generated repaired workflow candidate ${compiledPlan.cacheKey} for failed cache ${cacheKey}`);
  } catch (err) {
    console.error("[task-runner] generated workflow repair failed:", (err as Error).message);
  }
}

async function failAgencyWorkflowRunWithError(task: TaskRow, error: Error): Promise<void> {
  const runId = agencyWorkflowRunIdFromTask(task);
  if (!runId) return;
  const db = getDb();
  await db.query(
    `UPDATE agency_workflow_runs
     SET status = 'failed',
         error = $2,
         completed_at = NOW()
     WHERE id = $1`,
    [runId, error.message],
  );
}

// ─── Task Runner State ────────────────────────────────────────────────────────

// Device locks: deviceId → true if busy
const deviceLocks = new Map<string, boolean>();

// Last task completion time per device (for rate limiting)
const deviceLastTaskTime = new Map<string, number>();

// Runner state
let isRunning = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let config: TaskRunnerConfig = { ...DEFAULT_CONFIG };

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * Start the task runner with optional config overrides.
 */
export function startTaskRunner(overrides: Partial<TaskRunnerConfig> = {}): void {
  if (isRunning) {
    console.log("[task-runner] Already running");
    return;
  }
  
  config = { ...DEFAULT_CONFIG, ...overrides };
  isRunning = true;
  
  console.log(`[task-runner] Starting (poll=${config.pollIntervalMs}ms, gap=${config.minGapBetweenTasksMs}ms)`);
  
  // Run immediately, then on interval
  runPollCycle().catch(err => console.error("[task-runner] Initial poll error:", err));
  
  pollInterval = setInterval(() => {
    runPollCycle().catch(err => console.error("[task-runner] Poll error:", err));
  }, config.pollIntervalMs);
}

/**
 * Stop the task runner.
 */
export function stopTaskRunner(): void {
  if (!isRunning) {
    console.log("[task-runner] Not running");
    return;
  }
  
  isRunning = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  
  console.log("[task-runner] Stopped");
}

/**
 * Get runner status.
 */
export function getTaskRunnerStatus(): {
  running: boolean;
  config: TaskRunnerConfig;
  lockedDevices: string[];
  deviceGaps: Record<string, number>;
} {
  const now = Date.now();
  const deviceGaps: Record<string, number> = {};
  
  for (const [deviceId, lastTime] of deviceLastTaskTime) {
    const elapsed = now - lastTime;
    const remaining = Math.max(0, config.minGapBetweenTasksMs - elapsed);
    if (remaining > 0) {
      deviceGaps[deviceId] = remaining;
    }
  }
  
  return {
    running: isRunning,
    config,
    lockedDevices: Array.from(deviceLocks.entries())
      .filter(([_, locked]) => locked)
      .map(([id]) => id),
    deviceGaps,
  };
}

export async function pollTaskRunnerNow(): Promise<void> {
  await runPollCycle();
}

// ─── Poll Cycle ───────────────────────────────────────────────────────────────

async function runPollCycle(): Promise<void> {
  if (!isRunning) return;
  
  const db = getDb();
  
  // Fetch queued tasks + failed tasks eligible for retry
  // Exponential backoff: 5 * 3^retry_count seconds (5s, 15s, 45s)
  const result = await db.query<TaskRow>(`
    SELECT id, account_id, device_id, routine, params, scheduled_time, status, retry_count, updated_at
    FROM tasks
    WHERE 
      (status = 'queued' AND scheduled_time <= NOW())
      OR (
        status = 'failed' 
        AND COALESCE(retry_count, 0) < $2
        AND updated_at < NOW() - (INTERVAL '1 second' * (5 * POWER(3, COALESCE(retry_count, 0))))
      )
    ORDER BY 
      CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
      scheduled_time ASC
    LIMIT $1
  `, [config.batchSize, config.maxRetries]);
  
  if (result.rows.length === 0) {
    return; // Nothing to do
  }
  
  const queuedCount = result.rows.filter(t => t.status === 'queued').length;
  const retryCount = result.rows.filter(t => t.status === 'failed').length;
  console.log(`[task-runner] Found ${queuedCount} queued + ${retryCount} retry-eligible tasks`);
  
  // Process each task (respecting device locks)
  for (const task of result.rows) {
    if (!isRunning) break;
    
    // Skip if device is locked (another task running)
    if (deviceLocks.get(task.device_id)) {
      console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device ${task.device_id.slice(0, 8)} busy`);
      continue;
    }
    
    // Skip if device rate limited (min gap not elapsed)
    const lastTaskTime = deviceLastTaskTime.get(task.device_id);
    if (lastTaskTime) {
      const elapsed = Date.now() - lastTaskTime;
      if (elapsed < config.minGapBetweenTasksMs) {
        console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device rate limited (${Math.ceil((config.minGapBetweenTasksMs - elapsed) / 1000)}s remaining)`);
        continue;
      }
    }
    
    // Skip if device is offline
    if (!isDeviceOnline(task.device_id)) {
      console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device ${task.device_id.slice(0, 8)} offline`);
      continue;
    }
    
    // Execute task (don't await — parallel execution per device)
    executeTask(task).catch(err => {
      console.error(`[task-runner] Task ${task.id.slice(0, 8)} error:`, err);
    });
  }
}

// ─── Task Execution ───────────────────────────────────────────────────────────

async function executeTask(task: TaskRow): Promise<void> {
  const db = getDb();
  const taskId = task.id;
  const deviceId = task.device_id;
  
  // Lock device
  deviceLocks.set(deviceId, true);
  
  try {
    // Update status to running
    await db.query(`
      UPDATE tasks SET status = 'running', started_at = NOW()
      WHERE id = $1
    `, [taskId]);
    await markAgencyWorkflowRunStarted(task);
    publishGeneratedWorkflowTaskEvent(task, "task_running");
    
    console.log(`[task-runner] Executing task ${taskId.slice(0, 8)} (${task.routine}) on device ${deviceId.slice(0, 8)}`);
    
    // Accountless device-management tasks carry their platform in params.
    const accountResult = task.account_id
      ? await db.query<{ platform: string; client_id: string | null }>(
          "SELECT platform, client_id FROM accounts WHERE id = $1",
          [task.account_id],
        )
      : { rows: [] };
    const taskPlatform = typeof task.params?.platform === "string" ? task.params.platform : null;
    const platform = task.routine === GENERATED_WORKFLOW_ROUTINE
      ? taskPlatform || accountResult.rows[0]?.platform || "instagram"
      : accountResult.rows[0]?.platform || taskPlatform || "instagram";
    const accountClientId = accountResult.rows[0]?.client_id ?? null;
    
    // Route by task type
    let result: TaskRunnerResult;
    
    switch (task.routine) {
      case "generated_workflow":
        result = await executeGeneratedWorkflowTask(task, platform, accountClientId);
        break;
      case "engage_session":
        result = await executeEngageSession(task, platform);
        break;
      case "engage_feed":
        result = await executeEngageFeed(task, platform);
        break;
      case "follow_users":
        result = await executeFollowUsers(task, platform);
        break;
      case "post_photo":
      case "post_reel":
      case "post_story":
        result = await executePost(task, platform);
        break;
      default:
        // Generic orchestrator execution
        result = await executeGenericTask(task, platform);
    }
    
    // Prepare result JSON
    const resultJson = {
      stepsCompleted: result.stepsCompleted,
      totalSteps: result.totalSteps,
      tokenUsage: result.tokenUsage,
      durationMs: result.durationMs,
      failedStep: result.failedStep,
      output: result.output,
      generatedWorkflow: result.generatedWorkflow,
    };
    
    // Update task status
    if (result.success) {
      await db.query(`
        UPDATE tasks 
        SET status = 'completed', completed_at = NOW(), result = $2
        WHERE id = $1
      `, [taskId, JSON.stringify(resultJson)]);
      await completeAgencyWorkflowRun(task, result);
      await recordGeneratedWorkflowLearning(task, result);
      publishGeneratedWorkflowTaskEvent(task, "task_completed", {
        workflowId: result.generatedWorkflow?.workflowId,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
        mode: result.generatedWorkflow?.mode,
      });
      
      console.log(`[task-runner] Task ${taskId.slice(0, 8)} completed ✓ (${result.stepsCompleted}/${result.totalSteps} steps)`);
    } else {
      const currentRetryCount = task.retry_count ?? 0;
      const newRetryCount = currentRetryCount + 1;
      
      await db.query(`
        UPDATE tasks 
        SET status = 'failed', 
            completed_at = NOW(), 
            updated_at = NOW(),
            result = $2, 
            error = $3,
            retry_count = $4
        WHERE id = $1
      `, [taskId, JSON.stringify(resultJson), result.failReason || "Unknown error", newRetryCount]);
      await completeAgencyWorkflowRun(task, result);
      await recordGeneratedWorkflowLearning(task, result);
      await attemptGeneratedWorkflowRepair(task, result);
      publishGeneratedWorkflowTaskEvent(task, "task_failed", {
        workflowId: result.generatedWorkflow?.workflowId,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
        error: result.failReason,
        failureCode: result.generatedWorkflow?.failureCode,
      });
      
      // Also log to execution_logs for detailed debugging
      await db.query(`
        INSERT INTO execution_logs (task_id, device_id, log_data)
        VALUES ($1, $2, $3)
      `, [taskId, deviceId, JSON.stringify({
        error: result.failReason,
        failedStep: result.failedStep,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
        tokenUsage: result.tokenUsage,
        durationMs: result.durationMs,
        retryCount: newRetryCount,
      })]);
      
      if (newRetryCount < config.maxRetries) {
        const nextRetryDelay = 5 * Math.pow(3, newRetryCount);
        console.error(`[task-runner] Task ${taskId.slice(0, 8)} failed (retry ${newRetryCount}/${config.maxRetries}, next in ${nextRetryDelay}s): ${result.failReason}`);
      } else {
        console.error(`[task-runner] Task ${taskId.slice(0, 8)} failed permanently (${newRetryCount} retries exhausted): ${result.failReason}`);
      }
    }
    
  } catch (err) {
    // Mark as failed on exception, increment retry_count
    const currentRetryCount = task.retry_count ?? 0;
    const newRetryCount = currentRetryCount + 1;
    const error = err as Error;
    
    await db.query(`
      UPDATE tasks 
      SET status = 'failed', 
          completed_at = NOW(), 
          updated_at = NOW(),
          error = $2,
          retry_count = $3
      WHERE id = $1
    `, [taskId, error.message, newRetryCount]);
    await failAgencyWorkflowRunWithError(task, error);
    publishGeneratedWorkflowTaskEvent(task, "task_failed", { error: error.message });
    
    await db.query(`
      INSERT INTO execution_logs (task_id, device_id, log_data)
      VALUES ($1, $2, $3)
    `, [taskId, deviceId, JSON.stringify({
      error: error.message,
      stack: error.stack,
      retryCount: newRetryCount,
    })]);
    
    if (newRetryCount < config.maxRetries) {
      const nextRetryDelay = 5 * Math.pow(3, newRetryCount);
      console.error(`[task-runner] Task ${taskId.slice(0, 8)} exception (retry ${newRetryCount}/${config.maxRetries}, next in ${nextRetryDelay}s):`, err);
    } else {
      console.error(`[task-runner] Task ${taskId.slice(0, 8)} exception (${newRetryCount} retries exhausted):`, err);
    }
    
  } finally {
    // Unlock device & update last task time
    deviceLocks.set(deviceId, false);
    deviceLastTaskTime.set(deviceId, Date.now());
  }
}

// ─── Task Type Handlers ───────────────────────────────────────────────────────

/**
 * engage_session: Combined session with likes, comments, follows
 * Uses params.actions and params.duration_minutes
 */
async function executeEngageSession(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    session_index: number;
    total_sessions: number;
    duration_minutes: number;
    actions: { likes: number; comments: number; follows?: number };
    target: string;
  };
  
  const { actions, duration_minutes, target } = params;
  
  // Build task description for orchestrator
  const parts: string[] = [];
  
  if (actions.likes > 0) {
    parts.push(`like ${actions.likes} posts`);
  }
  if (actions.comments > 0) {
    parts.push(`comment on ${actions.comments} posts`);
  }
  if (actions.follows && actions.follows > 0) {
    parts.push(`follow ${actions.follows} users`);
  }
  
  const targetDesc = target.startsWith("hashtag:")
    ? `from ${target.replace("hashtag:", "#")}`
    : `from ${target}`;
  
  const taskDescription = `Open Instagram, browse ${targetDesc}, and ${parts.join(", ")}. Take about ${duration_minutes} minutes with natural pauses.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * engage_feed: Legacy engagement task
 */
async function executeEngageFeed(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    actions: { likes: number; comments: number };
    target: string;
    duration_minutes: number;
  };
  
  const taskDescription = `Open Instagram, go to ${params.target}, and like ${params.actions.likes} posts and comment on ${params.actions.comments} posts over ${params.duration_minutes} minutes.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * follow_users: Follow task
 */
async function executeFollowUsers(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    count: number;
    target: string;
    unfollow_after_days?: number;
  };
  
  const taskDescription = `Open Instagram, explore ${params.target}, and follow ${params.count} interesting users who might follow back.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * post_photo/post_reel/post_story: Posting tasks
 */
async function executePost(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    post_id: string;
    material_url: string;
    caption: string;
    hashtags: string[];
  };
  
  const postType = task.routine.replace("post_", "");
  const fullCaption = params.caption + (params.hashtags.length > 0 ? "\n\n" + params.hashtags.join(" ") : "");
  
  const taskDescription = `Open Instagram, create a new ${postType} using the image/video at ${params.material_url}, and post it with caption: "${fullCaption}"`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * generated_workflow: Dispatch a cached generated workflow by canonical requestKey or cacheKey.
 * The task payload is a pointer only; workflow bodies are rejected to keep execution deterministic.
 */
async function executeGeneratedWorkflowTask(
  task: TaskRow,
  platform: string,
  accountClientId?: string | null,
): Promise<TaskRunnerResult> {
  const startedAt = Date.now();
  const routine = GENERATED_WORKFLOW_ROUTINE;
  const params = (task.params ?? {}) as {
    cacheKey?: unknown;
    requestKey?: unknown;
    deviceId?: unknown;
    clientId?: unknown;
    campaignId?: unknown;
    intent?: unknown;
    workflow?: unknown;
    variables?: unknown;
    allowCandidateArtifact?: unknown;
  };

  if (Object.prototype.hasOwnProperty.call(params, "workflow")) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "WORKFLOW_PAYLOAD_NOT_ALLOWED",
      "generated_workflow tasks must use cacheKey or requestKey only",
      startedAt,
    );
  }

  const cacheKey = typeof params.cacheKey === "string" ? params.cacheKey : undefined;
  const requestKey = typeof params.requestKey === "string" ? params.requestKey : undefined;
  const taskParamDeviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
  const clientId = accountClientId ?? (typeof params.clientId === "string" ? params.clientId : undefined);
  const campaignId = typeof params.campaignId === "string" ? params.campaignId : undefined;
  const source = generatedWorkflowTaskSource(cacheKey, requestKey);
  const allowCandidateArtifact = params.allowCandidateArtifact === true
    && agencyWorkflowRunIdFromTask(task) !== null
    && task.params?.source === "dashboard_human";

  if (!cacheKey && !requestKey) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_KEY_REQUIRED",
      "cacheKey or requestKey is required",
      startedAt,
    );
  }

  if (cacheKey && requestKey) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_EXACTLY_ONE_KEY_REQUIRED",
      "generated_workflow tasks must use exactly one of cacheKey or requestKey",
      startedAt,
    );
  }

  if (cacheKey && !/^[a-f0-9]{24}$/.test(cacheKey)) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure("INVALID_CACHE_KEY", "cacheKey must be a 24-character lowercase hex string", startedAt);
  }

  if (requestKey && !/^[a-f0-9]{24}$/.test(requestKey)) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure("INVALID_REQUEST_KEY", "requestKey must be a 24-character lowercase hex string", startedAt);
  }

  if (!UUID_RE.test(task.device_id) || (taskParamDeviceId && !UUID_RE.test(taskParamDeviceId))) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "DEVICE_ID_INVALID_OR_AMBIGUOUS",
      "generated_workflow tasks require a full task device UUID",
      startedAt,
    );
  }

  if (taskParamDeviceId && taskParamDeviceId !== task.device_id) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "DEVICE_ID_MISMATCH",
      "params.deviceId must match the task device_id",
      startedAt,
    );
  }

  const cached = cacheKey
    ? await workflowService.getGeneratedPlanCache(cacheKey, { includeCandidate: allowCandidateArtifact })
    : await workflowService.getGeneratedPlanCacheByRequestKey(requestKey!, { includeCandidate: allowCandidateArtifact });

  if (!cached) {
    generatedWorkflowCacheLookups?.labels("task_runner", "miss").inc();
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "miss").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_CACHE_MISS",
      "canonical generated workflow artifact not found",
      startedAt,
    );
  }

  generatedWorkflowCacheLookups?.labels("task_runner", generatedWorkflowTaskCacheResult(cacheKey, requestKey)).inc();

  if (cached.sourceMetadata?.source === "dashboard_human") {
    const intent = typeof cached.sourceMetadata.intent === "string" ? cached.sourceMetadata.intent : String(params.intent ?? requestKey ?? cacheKey);
    try {
      assertHumanWorkflowMeaningful(cached.workflow, intent);
    } catch (err) {
      const typed = err as Error & { code?: string };
      generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
      return generatedWorkflowTaskFailure(
        typed.code ?? "HUMAN_WORKFLOW_UNDERCOMPILED",
        typed.message,
        startedAt,
        cached,
      );
    }
  }

  if (cached.compiledPlan.llmBudget.happyPathRequests !== 0) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_LLM_BUDGET_NOT_CACHE_SAFE",
      "compiled plan happy path must not require LLM calls",
      startedAt,
      cached,
    );
  }

  try {
    const suppliedVariables = params.variables && typeof params.variables === "object" && !Array.isArray(params.variables)
      ? params.variables as Record<string, unknown>
      : undefined;
    const variables: Record<string, unknown> = {
      ...generatedWorkflowOutputDefaults(cached),
      ...(suppliedVariables ?? {}),
      taskId: task.id,
      generatedWorkflow: true,
      generatedWorkflowId: cached.workflow.id,
      generatedWorkflowCacheKey: cached.cacheKey,
      generatedWorkflowRequestKey: cached.requestKey,
      canonicalWorkflowId: cached.canonicalWorkflowId,
      canonicalWorkflowVersion: cached.canonicalWorkflowVersion,
      compiledPlanHash: cached.compiledPlanHash,
    };
    const controlPlaneContext: GeneratedWorkflowControlPlaneContext = {
      source: "task_runner",
      routine,
      taskId: task.id,
      ...(task.account_id ? { accountId: task.account_id } : {}),
      deviceId: task.device_id,
      platform,
      ...(agencyWorkflowRunIdFromTask(task) ? { agencyWorkflowRunId: agencyWorkflowRunIdFromTask(task)! } : {}),
      ...(clientId ? { clientId } : {}),
      ...(campaignId ? { campaignId } : {}),
    };
    const executableWorkflow = normalizeCachedHumanWorkflowTemplate(cached.workflow, cached.sourceMetadata);
    const dispatch = await dispatchGeneratedWorkflowTemplate({
      templateId: executableWorkflow.id,
      template: executableWorkflow,
      deviceId: task.device_id,
      ...(task.account_id ? { accountId: task.account_id } : {}),
      variables,
      controlPlaneContext,
      logPrefix: "task-runner",
    });
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "accepted").inc();
    generatedWorkflowExecutions?.labels(cached.platform, "true", `task_runner_${source}`).inc();
    generatedWorkflowLlmAvoided?.labels(cached.platform, "task_runner_cache_hit").inc();
    const finalWorkflow = await waitForGeneratedWorkflowFinal(dispatch.workflowId);
    const finalVariables = checkpointVariables(finalWorkflow);
    const finalOutput = generatedWorkflowOutput(cached, finalVariables);

    const generatedWorkflowResult = {
      workflowId: dispatch.workflowId,
      status: dispatch.status,
      mode: dispatch.mode,
      templateId: dispatch.templateId,
      cacheKey: cached.cacheKey,
      requestKey: cached.requestKey,
      canonicalWorkflowId: cached.canonicalWorkflowId,
      canonicalWorkflowVersion: cached.canonicalWorkflowVersion,
      compiledPlanHash: cached.compiledPlanHash,
      llmBudget: cached.compiledPlan.llmBudget,
      controlPlaneContext,
      output: finalOutput,
    };

    if (finalWorkflow.status !== "completed") {
      return {
        success: false,
        stepsCompleted: finalWorkflow.currentStep,
        totalSteps: finalWorkflow.totalSteps ?? cached.workflow.steps.length,
        output: finalOutput,
        tokenUsage: zeroTokenUsage(),
        durationMs: Date.now() - startedAt,
        failReason: finalWorkflow.error ?? `Generated workflow ended with status ${finalWorkflow.status}`,
        generatedWorkflow: generatedWorkflowResult,
      };
    }

    const humanEvidenceError = validateHumanWorkflowFinalEvidence(cached, finalVariables);
    if (humanEvidenceError) {
      return {
        success: false,
        stepsCompleted: finalWorkflow.currentStep,
        totalSteps: finalWorkflow.totalSteps ?? cached.workflow.steps.length,
        output: finalOutput,
        tokenUsage: zeroTokenUsage(),
        durationMs: Date.now() - startedAt,
        failReason: humanEvidenceError,
        generatedWorkflow: {
          ...generatedWorkflowResult,
          failureCode: humanEvidenceError.split(":")[0],
        },
      };
    }

    return {
      success: true,
      stepsCompleted: finalWorkflow.currentStep,
      totalSteps: finalWorkflow.totalSteps ?? cached.workflow.steps.length,
      output: finalOutput,
      tokenUsage: zeroTokenUsage(),
      durationMs: Date.now() - startedAt,
      generatedWorkflow: generatedWorkflowResult,
    };
  } catch (err) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      (err as Error & { code?: string }).code ?? "GENERATED_WORKFLOW_DISPATCH_FAILED",
      (err as Error).message,
      startedAt,
      cached,
    );
  }
}

/**
 * Generic task: Pass routine as task description
 */
async function executeGenericTask(task: TaskRow, platform: string): Promise<TaskResult> {
  const taskDescription = `${task.routine}: ${JSON.stringify(task.params)}`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

// ─── Manual Task Execution ────────────────────────────────────────────────────

/**
 * Execute a specific task immediately (bypass queue).
 * Useful for testing or priority execution.
 */
export async function executeTaskNow(taskId: string): Promise<TaskResult | { success: false; error: string }> {
  const db = getDb();
  
  const result = await db.query<TaskRow>(`
    SELECT id, account_id, device_id, routine, params, scheduled_time, status
    FROM tasks
    WHERE id = $1
  `, [taskId]);
  
  if (result.rows.length === 0) {
    return { success: false, error: "Task not found" };
  }
  
  const task = result.rows[0];
  
  if (deviceLocks.get(task.device_id)) {
    return { success: false, error: "Device is busy with another task" };
  }
  
  if (!isDeviceOnline(task.device_id)) {
    return { success: false, error: "Device is offline" };
  }
  
  // Execute synchronously
  const accountResult = task.account_id
    ? await db.query<{ platform: string; client_id: string | null }>(
    "SELECT platform, client_id FROM accounts WHERE id = $1",
    [task.account_id]
      )
    : { rows: [] };
  const taskPlatform = typeof task.params?.platform === "string" ? task.params.platform : null;
  const platform = task.routine === GENERATED_WORKFLOW_ROUTINE
    ? taskPlatform || accountResult.rows[0]?.platform || "instagram"
    : accountResult.rows[0]?.platform || taskPlatform || "instagram";
  const accountClientId = accountResult.rows[0]?.client_id ?? null;
  
  deviceLocks.set(task.device_id, true);

  try {
    await db.query(`UPDATE tasks SET status = 'running', started_at = NOW() WHERE id = $1`, [taskId]);
    await markAgencyWorkflowRunStarted(task);
    publishGeneratedWorkflowTaskEvent(task, "task_running");
    
    let taskResult: TaskRunnerResult;
    switch (task.routine) {
      case "generated_workflow":
        taskResult = await executeGeneratedWorkflowTask(task, platform, accountClientId);
        break;
      case "engage_session":
        taskResult = await executeEngageSession(task, platform);
        break;
      case "engage_feed":
        taskResult = await executeEngageFeed(task, platform);
        break;
      case "follow_users":
        taskResult = await executeFollowUsers(task, platform);
        break;
      case "post_photo":
      case "post_reel":
      case "post_story":
        taskResult = await executePost(task, platform);
        break;
      default:
        taskResult = await executeGenericTask(task, platform);
    }
    
    const status = taskResult.success ? "completed" : "failed";
    await db.query(
      `UPDATE tasks SET status = $1, completed_at = NOW(), result = $2, error = $3 WHERE id = $4`,
      [
        status,
        JSON.stringify({
          stepsCompleted: taskResult.stepsCompleted,
          totalSteps: taskResult.totalSteps,
          tokenUsage: taskResult.tokenUsage,
          durationMs: taskResult.durationMs,
          failedStep: taskResult.failedStep,
          output: taskResult.output,
          generatedWorkflow: taskResult.generatedWorkflow,
        }),
        taskResult.success ? null : taskResult.failReason ?? "Unknown error",
        taskId,
      ]
    );
    await completeAgencyWorkflowRun(task, taskResult);
    await recordGeneratedWorkflowLearning(task, taskResult);
    await attemptGeneratedWorkflowRepair(task, taskResult);
    publishGeneratedWorkflowTaskEvent(task, taskResult.success ? "task_completed" : "task_failed", {
      workflowId: taskResult.generatedWorkflow?.workflowId,
      stepsCompleted: taskResult.stepsCompleted,
      totalSteps: taskResult.totalSteps,
      error: taskResult.failReason,
      failureCode: taskResult.generatedWorkflow?.failureCode,
    });

    return taskResult;
  } catch (err) {
    await failAgencyWorkflowRunWithError(task, err as Error);
    publishGeneratedWorkflowTaskEvent(task, "task_failed", { error: (err as Error).message });
    throw err;
  } finally {
    deviceLocks.set(task.device_id, false);
    deviceLastTaskTime.set(task.device_id, Date.now());
  }
}

// ─── Retry Failed Tasks ───────────────────────────────────────────────────────

/**
 * Reset all failed tasks to queued state for immediate retry.
 * Returns the number of tasks reset.
 */
export async function retryFailedTasks(): Promise<{ resetCount: number }> {
  const db = getDb();
  
  const result = await db.query(`
    UPDATE tasks 
    SET status = 'queued', 
        retry_count = 0,
        error = NULL,
        updated_at = NOW()
    WHERE status = 'failed'
    RETURNING id
  `);
  
  const resetCount = result.rowCount ?? 0;
  
  if (resetCount > 0) {
    console.log(`[task-runner] Reset ${resetCount} failed tasks to queued`);
  }
  
  return { resetCount };
}

/**
 * Get failed tasks count and details.
 */
export async function getFailedTasksStats(): Promise<{
  totalFailed: number;
  retryableCount: number;
  exhaustedCount: number;
}> {
  const db = getDb();
  
  const result = await db.query<{ retry_count: number; count: string }>(`
    SELECT COALESCE(retry_count, 0) as retry_count, COUNT(*) as count
    FROM tasks
    WHERE status = 'failed'
    GROUP BY COALESCE(retry_count, 0)
  `);
  
  let totalFailed = 0;
  let retryableCount = 0;
  let exhaustedCount = 0;
  
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    totalFailed += count;
    
    if (row.retry_count < config.maxRetries) {
      retryableCount += count;
    } else {
      exhaustedCount += count;
    }
  }
  
  return { totalFailed, retryableCount, exhaustedCount };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const taskRunnerService = {
  start: startTaskRunner,
  stop: stopTaskRunner,
  status: getTaskRunnerStatus,
  pollNow: pollTaskRunnerNow,
  executeNow: executeTaskNow,
  retryFailed: retryFailedTasks,
  getFailedStats: getFailedTasksStats,
};
