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
import { cancelPersistedWorkflowSafely } from "../workflows/workflow-cancellation.service";
import type { CompiledWorkflow } from "../workflow-compiler/types";
import { compiledWorkflowToEdgeTemplate } from "../workflow-compiler/edge-template.adapter";
import { recordExhaustedTaskIncident } from "../incidents/incident.service";

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
    selfHealing?: {
      status: "recovered" | "repair_unavailable" | "retry_failed" | "exhausted";
      attempts: number;
      sourceCacheKeys: string[];
      repairedCacheKeys: string[];
      lastReason?: string;
    };
  };
}

interface GeneratedWorkflowRepairCandidate {
  cacheKey: string;
  requestKey: string;
  workflowId: string;
  workflowVersion: string;
}

const DEFAULT_CONFIG: TaskRunnerConfig = {
  pollIntervalMs: 30_000,           // 30 seconds
  minGapBetweenTasksMs: 60_000,     // 1 minute gap between tasks on same device
  batchSize: 10,
  maxRetries: 3,                    // 3 retries: 5s, 15s, 45s (exponential backoff)
  retryBackoffMs: 5_000,            // Base backoff: 5 * 3^retry_count seconds
};

const COMPILED_WORKFLOW_ROUTINE = "compiled_workflow";

function publishGeneratedWorkflowTaskEvent(
  task: TaskRow,
  event: "task_running" | "task_completed" | "task_failed",
  details: Record<string, unknown> = {},
): void {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE && task.routine !== COMPILED_WORKFLOW_ROUTINE) return;
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
const GENERATED_WORKFLOW_ACTIVE_WARN_MS = 180_000;
const GENERATED_WORKFLOW_QUEUE_TIMEOUT_MS = Number(
  process.env.GENERATED_WORKFLOW_QUEUE_TIMEOUT_MS ?? GENERATED_WORKFLOW_ACTIVE_WARN_MS,
);

function zeroTokenUsage(): TaskResult["tokenUsage"] {
  return {
    planner: { input: 0, output: 0 },
    executor: { input: 0, output: 0, calls: 0 },
    verifier: { input: 0, output: 0, calls: 0 },
    total: 0,
  };
}

function isCompiledWorkflow(value: unknown): value is CompiledWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workflow = value as Partial<CompiledWorkflow>;
  return typeof workflow.id === "string"
    && typeof workflow.appId === "string"
    && Array.isArray(workflow.steps)
    && workflow.steps.length > 0
    && workflow.steps.every((step) => Boolean(step)
      && typeof step === "object"
      && typeof step.id === "string"
      && typeof step.action === "string"
      && typeof step.expectedPageHash === "string");
}

async function finalizeQueuedWorkflowRun(
  task: TaskRow,
  status: "completed" | "failed",
  result: Record<string, unknown>,
  error?: string,
): Promise<void> {
  const workflowRunId = typeof task.params?.workflowRunId === "string" ? task.params.workflowRunId : null;
  if (!workflowRunId || !UUID_RE.test(workflowRunId)) return;
  await getDb().query(
    `UPDATE workflow_runs
        SET status = $2,
            result = $3,
            error = $4,
            started_at = COALESCE(started_at, NOW()),
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [workflowRunId, status, JSON.stringify(result), error ?? null],
  );
}

async function executeCompiledWorkflowTask(task: TaskRow): Promise<TaskRunnerResult> {
  const startedAt = Date.now();
  const workflow = task.params?.compiledWorkflow;
  if (!isCompiledWorkflow(workflow)) {
    await finalizeQueuedWorkflowRun(task, "failed", { phase: "edge_admission" }, "INVALID_COMPILED_WORKFLOW");
    return {
      success: false,
      stepsCompleted: 0,
      totalSteps: 0,
      failReason: "INVALID_COMPILED_WORKFLOW: queued task has no valid compiledWorkflow",
      tokenUsage: zeroTokenUsage(),
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const template = await compiledWorkflowToEdgeTemplate(workflow);
    // The durable workflow row references workflow_templates(id).  Compiled
    // edge workflows are created dynamically, so persist the complete template
    // before dispatch instead of relying on a pre-existing cache artifact.
    await workflowService.saveTemplate(template);
    const dispatch = await dispatchGeneratedWorkflowTemplate({
    templateId: template.id,
    template,
    deviceId: task.device_id,
    variables: {
      taskId: task.id,
      compiledWorkflowId: workflow.id,
      compileLlmCalls: typeof task.params?.compileLlmCalls === "number"
        ? Math.max(0, Math.floor(task.params.compileLlmCalls))
        : 0,
    },
    controlPlaneContext: {
      source: "task_runner",
      routine: COMPILED_WORKFLOW_ROUTINE,
      taskId: task.id,
      deviceId: task.device_id,
      platform: template.platform,
    },
    logPrefix: "task-runner-compiled-edge",
    });
    const finalWorkflow = await waitForGeneratedWorkflowFinal(dispatch.workflowId);
    const finalVariables = checkpointVariables(finalWorkflow);
    const ok = finalWorkflow.status === "completed";
    const output = {
      workflowId: dispatch.workflowId,
      status: finalWorkflow.status,
      mode: dispatch.mode,
      runtimeContract: template.runtimeContract,
      variables: finalVariables,
    };
    const failReason = ok ? undefined : finalWorkflow.error ?? `Compiled edge workflow ended with status ${finalWorkflow.status}`;
    await finalizeQueuedWorkflowRun(task, ok ? "completed" : "failed", output, failReason);
    return {
      success: ok,
      stepsCompleted: finalWorkflow.currentStep,
      totalSteps: finalWorkflow.totalSteps ?? template.steps.length,
      failReason,
      tokenUsage: zeroTokenUsage(),
      durationMs: Date.now() - startedAt,
      output,
    };
  } catch (err) {
    const error = (err as Error).message;
    const output = { phase: "edge_dispatch", runtimeContract: "edge-workflow/v2", error };
    await finalizeQueuedWorkflowRun(task, "failed", output, error);
    return {
      success: false,
      stepsCompleted: 0,
      totalSteps: workflow.steps.length,
      failReason: error,
      tokenUsage: zeroTokenUsage(),
      durationMs: Date.now() - startedAt,
      output,
    };
  }
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
  const queuedAt = Date.now();
  let runningAt: number | null = null;
  let queueCancellationLostRace = false;
  let latest: WorkflowRecord | null = null;

  while (true) {
    latest = await workflowService.get(workflowId);
    if (!latest) {
      throw new Error(`Generated workflow ${workflowId} not found after dispatch`);
    }
    if (latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled") {
      return latest;
    }

    if (latest.status === "queued" && !queueCancellationLostRace) {
      if (Date.now() - queuedAt >= GENERATED_WORKFLOW_QUEUE_TIMEOUT_MS) {
        try {
          await cancelPersistedWorkflowSafely(workflowId);
          const cancelled = await workflowService.get(workflowId);
          if (cancelled?.status === "cancelled") return cancelled;
          throw new Error(`Generated workflow ${workflowId} cancellation completed without a cancelled workflow row`);
        } catch (err) {
          const code = (err as Error & { code?: string }).code;
          if (code !== "CANCELLATION_UNSUPPORTED_IN_FLIGHT") throw err;
          // The queue pump won the exact timeout race. It has already sent the
          // workflow, so switching to the execution deadline avoids a second
          // dispatch while the first one is in flight.
          queueCancellationLostRace = true;
          runningAt = Date.now();
        }
      }
    } else {
      runningAt ??= Date.now();
      if (Date.now() - runningAt >= GENERATED_WORKFLOW_ACTIVE_WARN_MS) {
        // The workflow worker owns the durable execution lifecycle.  Do not
        // fail the task on a shorter observer deadline: that makes the task
        // runner retry and dispatch a second workflow while the original root
        // is still active.  Keep the task attached to the original workflow
        // until the worker persists a terminal state.
        console.warn(
          `[task-runner] Generated workflow ${workflowId} is still ${latest.status} after ` +
          `${GENERATED_WORKFLOW_ACTIVE_WARN_MS}ms; continuing to await the original execution`,
        );
        runningAt = Date.now();
      }
    }
    await sleep(GENERATED_WORKFLOW_FINAL_POLL_INTERVAL_MS);
  }
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

async function attemptGeneratedWorkflowRepair(task: TaskRow, result: TaskRunnerResult): Promise<GeneratedWorkflowRepairCandidate | null> {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE || result.success) return null;
  const cacheKey = result.generatedWorkflow?.cacheKey;
  if (!cacheKey) return null;

  let cached: GeneratedWorkflowPlanCacheRecord | null = null;
  try {
    cached = await workflowService.getGeneratedPlanCacheForRepair(cacheKey);
  } catch (err) {
    console.error("[task-runner] generated workflow repair lookup failed:", err);
    return null;
  }
  if (!cached?.requestKey) return null;

  const learning = cached.sourceMetadata?.workflowLearning as Record<string, unknown> | undefined;
  const repair = cached.sourceMetadata?.workflowRepair as Record<string, unknown> | undefined;
  if (repair?.status === "candidate_generated" && repair?.sourceCacheKey === cacheKey) return null;
  if (typeof learning?.failureCount === "number" && learning.failureCount > 3) return null;

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
    return {
      cacheKey: compiledPlan.cacheKey,
      requestKey: cached.requestKey,
      workflowId: repaired.id,
      workflowVersion: repaired.version,
    };
  } catch (err) {
    console.error("[task-runner] generated workflow repair failed:", (err as Error).message);
    return null;
  }
}

function generatedWorkflowSelfHealingLimit(task: TaskRow): number {
  const value = task.params?.maxSelfHealingAttempts;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function withGeneratedWorkflowSelfHealingMetadata(
  result: TaskRunnerResult,
  selfHealing: NonNullable<NonNullable<TaskRunnerResult["generatedWorkflow"]>["selfHealing"]>,
): TaskRunnerResult {
  return {
    ...result,
    generatedWorkflow: {
      ...(result.generatedWorkflow ?? {}),
      selfHealing,
    },
  };
}

async function executeGeneratedWorkflowTaskWithSelfHealing(
  task: TaskRow,
  platform: string,
  accountClientId?: string | null,
): Promise<TaskRunnerResult> {
  const maxSelfHealingAttempts = generatedWorkflowSelfHealingLimit(task);
  const sourceCacheKeys: string[] = [];
  const repairedCacheKeys: string[] = [];
  let currentTask = task;
  let lastResult: TaskRunnerResult | null = null;

  for (let attempt = 0; attempt <= maxSelfHealingAttempts; attempt++) {
    const result = await executeGeneratedWorkflowTask(currentTask, platform, accountClientId);
    lastResult = result;

    if (result.success) {
      await recordGeneratedWorkflowLearning(currentTask, result);
      if (attempt === 0) return result;
      return withGeneratedWorkflowSelfHealingMetadata(result, {
        status: "recovered",
        attempts: attempt,
        sourceCacheKeys,
        repairedCacheKeys,
      });
    }

    if (result.generatedWorkflow?.cacheKey) sourceCacheKeys.push(result.generatedWorkflow.cacheKey);
    await recordGeneratedWorkflowLearning(currentTask, result);

    if (attempt >= maxSelfHealingAttempts) {
      return withGeneratedWorkflowSelfHealingMetadata(result, {
        status: "exhausted",
        attempts: attempt,
        sourceCacheKeys,
        repairedCacheKeys,
        lastReason: result.failReason,
      });
    }

    const repaired = await attemptGeneratedWorkflowRepair(currentTask, result);
    if (!repaired) {
      return withGeneratedWorkflowSelfHealingMetadata(result, {
        status: "repair_unavailable",
        attempts: attempt,
        sourceCacheKeys,
        repairedCacheKeys,
        lastReason: result.failReason,
      });
    }

    repairedCacheKeys.push(repaired.cacheKey);
    currentTask = {
      ...task,
      params: {
        ...task.params,
        cacheKey: repaired.cacheKey,
        requestKey: undefined,
        allowCandidateArtifact: true,
        source: task.params?.source ?? "dashboard_human",
        selfHealingAttempt: attempt + 1,
        selfHealingRepairOfCacheKey: result.generatedWorkflow?.cacheKey ?? null,
      },
    };
  }

  return withGeneratedWorkflowSelfHealingMetadata(lastResult ?? generatedWorkflowTaskFailure(
    "SELF_HEALING_NO_RESULT",
    "self-healing loop did not execute",
    Date.now(),
  ), {
    status: "retry_failed",
    attempts: maxSelfHealingAttempts,
    sourceCacheKeys,
    repairedCacheKeys,
    lastReason: lastResult?.failReason,
  });
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
    const platform = taskPlatform || accountResult.rows[0]?.platform || "android";
    const accountClientId = accountResult.rows[0]?.client_id ?? null;
    
    // Route by task type
    let result: TaskRunnerResult;
    
    switch (task.routine) {
      case "generated_workflow":
        result = await executeGeneratedWorkflowTaskWithSelfHealing(task, platform, accountClientId);
        break;
      case "compiled_workflow":
        result = await executeCompiledWorkflowTask(task);
        break;
      default:
        result = legacyRoutineRequiresWorkflow(task);
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
      if (task.routine !== GENERATED_WORKFLOW_ROUTINE) {
        await recordGeneratedWorkflowLearning(task, result);
      }
      publishGeneratedWorkflowTaskEvent(task, "task_completed", {
        workflowId: result.generatedWorkflow?.workflowId,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
        mode: result.generatedWorkflow?.mode,
      });
      
      console.log(`[task-runner] Task ${taskId.slice(0, 8)} completed ✓ (${result.stepsCompleted}/${result.totalSteps} steps)`);
    } else {
      const currentRetryCount = task.retry_count ?? 0;
      const newRetryCount = task.params?.disableTaskRetry === true
        ? config.maxRetries
        : currentRetryCount + 1;
      
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
      if (task.routine !== GENERATED_WORKFLOW_ROUTINE) {
        await recordGeneratedWorkflowLearning(task, result);
        await attemptGeneratedWorkflowRepair(task, result);
      }
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
        await recordExhaustedTaskIncident(task, result, newRetryCount);
      }
    }
    
  } catch (err) {
    // Mark as failed on exception, increment retry_count
    const currentRetryCount = task.retry_count ?? 0;
    const newRetryCount = task.params?.disableTaskRetry === true
      ? config.maxRetries
      : currentRetryCount + 1;
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
      await recordExhaustedTaskIncident(task, { failReason: error.message }, newRetryCount);
    }
    
  } finally {
    // Unlock device & update last task time
    deviceLocks.set(deviceId, false);
    deviceLastTaskTime.set(deviceId, Date.now());
  }
}

// ─── Task Type Handlers ───────────────────────────────────────────────────────

function legacyRoutineRequiresWorkflow(task: TaskRow): TaskRunnerResult {
  return {
    success: false,
    stepsCompleted: 0,
    totalSteps: 0,
    failReason: `LEGACY_ROUTINE_REQUIRES_DB_WORKFLOW: ${task.routine}`,
    tokenUsage: zeroTokenUsage(),
    durationMs: 0,
    output: {
      code: "LEGACY_ROUTINE_REQUIRES_DB_WORKFLOW",
      routine: task.routine,
      requiredExecution: "edge-workflow/v2",
    },
  };
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
    selfHealingAttempt?: unknown;
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
  const isSelfHealingRetry = typeof params.selfHealingAttempt === "number";
  const allowCandidateArtifact = params.allowCandidateArtifact === true
    && agencyWorkflowRunIdFromTask(task) !== null
    && (task.params?.source === "dashboard_human" || isSelfHealingRetry);

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
  const platform = taskPlatform || accountResult.rows[0]?.platform || "android";
  const accountClientId = accountResult.rows[0]?.client_id ?? null;
  
  deviceLocks.set(task.device_id, true);

  try {
    await db.query(`UPDATE tasks SET status = 'running', started_at = NOW() WHERE id = $1`, [taskId]);
    await markAgencyWorkflowRunStarted(task);
    publishGeneratedWorkflowTaskEvent(task, "task_running");
    
    let taskResult: TaskRunnerResult;
    switch (task.routine) {
      case "generated_workflow":
        taskResult = await executeGeneratedWorkflowTaskWithSelfHealing(task, platform, accountClientId);
        break;
      case "compiled_workflow":
        taskResult = await executeCompiledWorkflowTask(task);
        break;
      default:
        taskResult = legacyRoutineRequiresWorkflow(task);
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
    if (task.routine !== GENERATED_WORKFLOW_ROUTINE) {
      await recordGeneratedWorkflowLearning(task, taskResult);
      await attemptGeneratedWorkflowRepair(task, taskResult);
    }
    publishGeneratedWorkflowTaskEvent(task, taskResult.success ? "task_completed" : "task_failed", {
      workflowId: taskResult.generatedWorkflow?.workflowId,
      stepsCompleted: taskResult.stepsCompleted,
      totalSteps: taskResult.totalSteps,
      error: taskResult.failReason,
      failureCode: taskResult.generatedWorkflow?.failureCode,
    });

    if (!taskResult.success) {
      await recordExhaustedTaskIncident(task, taskResult, config.maxRetries);
    }

    return taskResult;
  } catch (err) {
    await failAgencyWorkflowRunWithError(task, err as Error);
    publishGeneratedWorkflowTaskEvent(task, "task_failed", { error: (err as Error).message });
    await recordExhaustedTaskIncident(task, { failReason: (err as Error).message }, config.maxRetries);
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
