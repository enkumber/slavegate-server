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
import { transitionWorkflowExecutionBinding } from "../workflow-segments/execution-lifecycle.service";
import { isDeviceOnline } from "../../transport/transport";
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
import {
  reconcileSupersededTaskIncidents,
  recordExhaustedTaskIncident,
} from "../incidents/incident.service";
import { evaluatePostconditionContract } from "../workflow-segments/postcondition";
import { shortKey } from "../workflow-segments/key-utils";
import {
  getConfiguredRetryStats,
  retryConfiguredTasks,
  transitionTask,
} from "../task-lifecycle/task-lifecycle.service";
import { transitionAgencyWorkflowRun } from "../workflows/agency-workflow-run-lifecycle.service";
import {
  getResourceLifecycleState,
  selectResourceLifecycleTransition,
} from "../lifecycle/lifecycle.service";
import { hydrateWorkflowNativePolicies } from "../dispatcher/dispatcher.service";
import { computeWorkflowSafetyArtifactFingerprint } from "../workflows/workflow-safety-admission.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenUsage {
  planner: { input: number; output: number };
  executor: { input: number; output: number; calls: number };
  verifier: { input: number; output: number; calls: number };
  total: number;
}

interface TaskResult {
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  failedStep?: number;
  failReason?: string;
  tokenUsage: TokenUsage;
  durationMs: number;
}

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
  status_dispatchable?: boolean;
  status_retryable?: boolean;
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
    status?: string;
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
      outcome: string;
      attempts: number;
      sourceCacheKeys: string[];
      repairedCacheKeys: string[];
      lastReason?: string;
    };
  };
}

interface RootFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
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
const GENERATED_WORKFLOW_LATE_TERMINAL_GRACE_MS = Number(
  process.env.GENERATED_WORKFLOW_LATE_TERMINAL_GRACE_MS ?? 30_000,
);
const EDGE_WORKFLOW_ACK_TIMEOUT_ERROR_PREFIX = "Edge workflow did not acknowledge WORKFLOW_START";

function zeroTokenUsage(): TaskResult["tokenUsage"] {
  return {
    planner: { input: 0, output: 0 },
    executor: { input: 0, output: 0, calls: 0 },
    verifier: { input: 0, output: 0, calls: 0 },
    total: 0,
  };
}

function rootFailureFromResult(result: TaskRunnerResult): RootFailure | null {
  if (result.success) return null;
  const code = result.generatedWorkflow?.failureCode
    ?? (result.generatedWorkflow?.cacheKey ? "GENERATED_WORKFLOW_EXECUTION_FAILED" : "TASK_EXECUTION_FAILED");
  return {
    code,
    message: result.failReason ?? "Unknown error",
    details: {
      workflowId: result.generatedWorkflow?.workflowId ?? null,
      cacheKey: result.generatedWorkflow?.cacheKey ?? null,
      requestKey: result.generatedWorkflow?.requestKey ?? null,
      failedStep: result.failedStep ?? null,
      stepsCompleted: result.stepsCompleted,
      totalSteps: result.totalSteps,
      selfHealing: result.generatedWorkflow?.selfHealing ?? null,
    },
  };
}

async function persistSuccessfulTaskResult(
  taskId: string,
  resultJson: Record<string, unknown>,
): Promise<void> {
  await transitionTask(taskId, {
    targetTerminal: true,
    targetRetryable: false,
    targetAdministrative: false,
    transitionMarkCompleted: true,
    transitionClearFailure: true,
  }, { result: resultJson });
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
  succeeded: boolean,
  result: Record<string, unknown>,
  error?: string,
): Promise<void> {
  const workflowRunId = typeof task.params?.workflowRunId === "string" ? task.params.workflowRunId : null;
  if (!workflowRunId || !UUID_RE.test(workflowRunId)) return;
  const db = getDb();
  const current = await db.query(
    `SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE`,
    [workflowRunId],
  );
  const currentStatus = current.rows[0]?.status;
  if (typeof currentStatus !== "string") return;
  const transition = await selectResourceLifecycleTransition(
    "workflow_runs",
    currentStatus,
    {
      targetTerminal: true,
      targetRetryable: !succeeded,
      targetAdministrative: false,
      transitionMarkCompleted: true,
    },
    "status",
    db,
  );
  if (!transition) {
    throw new Error("workflow run terminal transition is not configured");
  }
  await db.query(
    `UPDATE workflow_runs
        SET status = $2,
            result = $3,
            error = $4,
            started_at = COALESCE(started_at, NOW()),
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [workflowRunId, transition.toStatus, JSON.stringify(result), error ?? null],
  );
}

async function executeCompiledWorkflowTask(task: TaskRow): Promise<TaskRunnerResult> {
  const startedAt = Date.now();
  const workflow = task.params?.compiledWorkflow;
  if (!isCompiledWorkflow(workflow)) {
    await finalizeQueuedWorkflowRun(task, false, { phase: "edge_admission" }, "INVALID_COMPILED_WORKFLOW");
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
    const ok = finalWorkflow.lifecycleTerminal === true
      && finalWorkflow.lifecycleRetryable !== true
      && finalWorkflow.lifecycleAdministrative !== true;
    const output = {
      workflowId: dispatch.workflowId,
      status: finalWorkflow.status,
      mode: dispatch.mode,
      runtimeContract: template.runtimeContract,
      variables: finalVariables,
    };
    const failReason = ok ? undefined : finalWorkflow.error ?? `Compiled edge workflow ended with status ${finalWorkflow.status}`;
    await finalizeQueuedWorkflowRun(task, ok, output, failReason);
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
    await finalizeQueuedWorkflowRun(task, false, output, error);
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

function dashboardHumanOutputFailure(
  cached: GeneratedWorkflowPlanCacheRecord,
  output: Record<string, unknown>,
): string | null {
  if (
    cached.sourceMetadata?.source !== "dashboard_human"
    || cached.sourceMetadata?.outputContractVersion !== "required-v1"
  ) return null;

  const required = cached.workflow.outputSchema?.required ?? [];
  if (required.length === 0) {
    return "dashboard human workflow has no required output contract";
  }

  const missing = required.filter((key) => {
    const value = output[key];
    if (value === null || value === undefined) return true;
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    if (key === "error" && normalized === "") return false;
    return normalized === "" || normalized === "unknown" || normalized === "null";
  });

  return missing.length > 0
    ? `dashboard human workflow did not materialize required outputs: ${missing.join(", ")}`
    : null;
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
  let lateTerminalGraceStartedAt: number | null = null;
  let queueCancellationLostRace = false;
  let latest: WorkflowRecord | null = null;
  let queueTimeoutMs: number | null | undefined;

  while (true) {
    latest = await workflowService.get(workflowId);
    if (!latest) {
      throw new Error(`Generated workflow ${workflowId} not found after dispatch`);
    }
    if (latest.lifecycleTerminal === true && latest.lifecycleRetryable !== true) {
      return latest;
    }
    if (latest.lifecycleTerminal === true && latest.lifecycleRetryable === true) {
      const isProvisionalAckTimeout = latest.error?.startsWith(EDGE_WORKFLOW_ACK_TIMEOUT_ERROR_PREFIX) === true;
      if (!isProvisionalAckTimeout) return latest;

      lateTerminalGraceStartedAt ??= Date.now();
      if (Date.now() - lateTerminalGraceStartedAt >= GENERATED_WORKFLOW_LATE_TERMINAL_GRACE_MS) {
        return latest;
      }
      // A WORKFLOW_START receipt can be lost while the authenticated device is
      // already executing. Android terminal evidence is authoritative and may
      // arrive after the short ACK watchdog. Keep the task attached to this
      // workflow during a bounded grace period so a late completed checkpoint
      // cannot be misclassified as an artifact failure and quarantine good
      // knowledge.
      await sleep(GENERATED_WORKFLOW_FINAL_POLL_INTERVAL_MS);
      continue;
    }

    if (latest.lifecycleDispatchable === true && !queueCancellationLostRace) {
      if (queueTimeoutMs === undefined) {
        const lifecycleState = await getResourceLifecycleState("workflows", latest.status);
        queueTimeoutMs = lifecycleState?.staleAfterMs ?? null;
        if (queueTimeoutMs === null) {
          throw new Error("queued workflow lifecycle has no stale timeout configured");
        }
      }
      if (queueTimeoutMs !== null && Date.now() - queuedAt >= queueTimeoutMs) {
        try {
          await cancelPersistedWorkflowSafely(workflowId);
          const cancelled = await workflowService.get(workflowId);
          if (cancelled?.lifecycleTerminal === true && cancelled.lifecycleAdministrative === true) return cancelled;
          throw new Error(`Generated workflow ${workflowId} cancellation completed without an administrative terminal row`);
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
  await transitionAgencyWorkflowRun(runId, {
    targetTerminal: false,
    targetAdministrative: false,
    transitionMarkStarted: true,
  });
}

async function completeAgencyWorkflowRun(task: TaskRow, result: TaskRunnerResult): Promise<void> {
  const runId = agencyWorkflowRunIdFromTask(task);
  if (!runId) return;
  const generatedWorkflow = result.generatedWorkflow ?? {};
  const output = result.output ?? generatedWorkflow.output ?? {};
  const rootFailure = rootFailureFromResult(result);
  await transitionAgencyWorkflowRun(runId, result.success ? {
    targetTerminal: true,
    targetRetryable: false,
    targetAdministrative: false,
    transitionMarkCompleted: true,
    transitionClearFailure: true,
  } : {
    targetTerminal: true,
    targetRetryable: true,
    targetAdministrative: false,
    transitionMarkCompleted: true,
    transitionClearFailure: false,
  }, {
    workflowId: generatedWorkflow.workflowId ?? null,
    output,
    tokenUsage: result.tokenUsage ?? zeroTokenUsage(),
    recoveryRequests: 0,
    error: result.success ? null : result.failReason ?? "Unknown error",
    rootErrorCode: rootFailure?.code ?? null,
    rootErrorMessage: rootFailure?.message ?? null,
    rootErrorDetails: rootFailure?.details ?? {},
  });
}

async function recordGeneratedWorkflowLearning(task: TaskRow, result: TaskRunnerResult): Promise<void> {
  if (task.routine !== GENERATED_WORKFLOW_ROUTINE) return;
  const cacheKey = result.generatedWorkflow?.cacheKey;
  if (!cacheKey) return;
  try {
    const statePath = Array.isArray(result.output?.statePath)
      ? result.output.statePath
      : Array.isArray(result.output?._statePath)
        ? result.output._statePath
        : [];
    const branchKey = statePath.length > 0
      ? statePath.map((item: unknown) => {
          const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
          return String(value.state ?? "unknown");
        }).join(">")
      : String(task.params?.branchKey ?? "default");
    await workflowService.recordGeneratedPlanCacheOutcome({
      cacheKey,
      success: result.success,
      reason: result.success ? null : result.failReason ?? result.generatedWorkflow?.failureCode ?? "Unknown error",
      taskId: task.id,
      workflowId: result.generatedWorkflow?.workflowId ?? null,
      agencyWorkflowRunId: agencyWorkflowRunIdFromTask(task),
      stepsCompleted: result.stepsCompleted ?? null,
      totalSteps: result.totalSteps ?? null,
      deviceId: task.device_id,
      branchKey,
      appVersion: typeof task.params?.appVersion === "string" ? task.params.appVersion : null,
      androidVersion: typeof task.params?.androidVersion === "string" ? task.params.androidVersion : null,
      recoveryCount: Number(result.generatedWorkflow?.selfHealing?.attempts ?? 0),
      postconditionVerified: result.success,
    });
  } catch (err) {
    console.error("[task-runner] generated workflow learning update failed:", err);
  }
  const executionKey = typeof task.params?.executionKey === "string" ? task.params.executionKey : null;
  const executionRequestKey = typeof task.params?.executionRequestKey === "string"
    ? task.params.executionRequestKey
    : null;
  if (
    executionKey
    && executionRequestKey
    && /^[a-f0-9]{24}$/.test(executionKey)
    && /^[a-f0-9]{24}$/.test(executionRequestKey)
  ) {
    try {
      await transitionWorkflowExecutionBinding(
        executionRequestKey,
        {
          targetTerminal: true,
          targetRetryable: !result.success,
          targetAdministrative: false,
          transitionAutomatic: true,
        },
        {
          postconditionVerified: result.success,
          resultEvidence: {
            taskId: task.id,
            workflowId: result.generatedWorkflow?.workflowId ?? null,
            success: result.success,
            failureCode: result.generatedWorkflow?.failureCode ?? null,
            executionKey,
          },
        },
      );
    } catch (err) {
      console.error("[task-runner] workflow execution binding update failed:", err);
    }
  }
  const segmentRefs = Array.isArray(task.params?.segmentRefs)
    ? task.params.segmentRefs.filter((item): item is { segmentKey: string; segmentVersion: string } => (
        !!item
        && typeof item === "object"
        && typeof (item as Record<string, unknown>).segmentKey === "string"
        && typeof (item as Record<string, unknown>).segmentVersion === "string"
      ))
    : [];
  if (segmentRefs.length === 0) return;
  try {
    const rawInputs = task.params?.variables
      && typeof task.params.variables === "object"
      && !Array.isArray(task.params.variables)
      && (task.params.variables as Record<string, unknown>).inputs
      && typeof (task.params.variables as Record<string, unknown>).inputs === "object"
      ? (task.params.variables as Record<string, unknown>).inputs as Record<string, unknown>
      : {};
    const inputClass = shortKey("workflow-segment-input-class-v1", Object.fromEntries(
      Object.entries(rawInputs).map(([key, value]) => [
        key,
        typeof value === "string" && /^https?:\/\//i.test(value)
          ? "string:uri"
          : Array.isArray(value)
            ? "array"
            : value === null
              ? "null"
              : typeof value,
      ]),
    ));
    const generatedWorkflowEvidence = result.generatedWorkflow as (typeof result.generatedWorkflow & {
      failureSegmentKey?: string;
    });
    const failureSegmentKey = typeof generatedWorkflowEvidence?.failureSegmentKey === "string"
      ? generatedWorkflowEvidence.failureSegmentKey
      : null;
    for (const segment of segmentRefs) {
      const attributedFailure = !result.success && failureSegmentKey === segment.segmentKey;
      await getDb().query(
        `INSERT INTO workflow_segment_coverage (
           segment_key, segment_version, device_id, app_version, android_version, input_class,
           success_count, failure_count, recovery_count, postcondition_verified, last_evidence
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (segment_key, segment_version, device_id, app_version, android_version, input_class)
         DO UPDATE SET
           success_count = workflow_segment_coverage.success_count + EXCLUDED.success_count,
           failure_count = workflow_segment_coverage.failure_count + EXCLUDED.failure_count,
           recovery_count = workflow_segment_coverage.recovery_count + EXCLUDED.recovery_count,
           postcondition_verified = workflow_segment_coverage.postcondition_verified OR EXCLUDED.postcondition_verified,
           last_evidence = EXCLUDED.last_evidence,
           updated_at = NOW()`,
        [
          segment.segmentKey,
          segment.segmentVersion,
          task.device_id,
          typeof task.params?.appVersion === "string" ? task.params.appVersion : "",
          typeof task.params?.androidVersion === "string" ? task.params.androidVersion : "",
          inputClass,
          result.success ? 1 : 0,
          attributedFailure ? 1 : 0,
          result.success ? Number(result.generatedWorkflow?.selfHealing?.attempts ?? 0) : 0,
          result.success,
          JSON.stringify({
            taskId: task.id,
            workflowId: result.generatedWorkflow?.workflowId ?? null,
            success: result.success,
            attributedFailure,
            failureCode: result.generatedWorkflow?.failureCode ?? null,
          }),
        ],
      );
    }
  } catch (err) {
    console.error("[task-runner] workflow segment coverage update failed:", err);
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
    safetyClass: typeof record.safetyClass === "string"
      && /^[a-z0-9][a-z0-9._/-]{0,199}$/.test(record.safetyClass)
      ? record.safetyClass
      : base.safetyClass,
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
  const repairPolicy = cached.sourceMetadata?.repairPolicy as Record<string, unknown> | undefined;
  if (typeof repair?.candidateGeneratedAt === "string" && repair?.sourceCacheKey === cacheKey) return null;
  const maximumFailureCount = Number(repairPolicy?.maximumFailureCount);
  if (!Number.isFinite(maximumFailureCount) || maximumFailureCount < 0) return null;
  if (typeof learning?.failureCount === "number" && learning.failureCount > maximumFailureCount) return null;

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
    await workflowService.saveCandidateExecutableGeneratedPlanCache(repaired, compiledPlan, cached.requestKey, {
        ...cached.sourceMetadata,
        source: "llm_repair",
        repairOfCacheKey: cached.cacheKey,
        repairOfWorkflowId: cached.workflow.id,
        workflowRepair: {
          candidateGeneratedAt: new Date().toISOString(),
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
          nextAction: "retry_task_with_repaired_candidate",
        },
    }, false);
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
        outcome: "recovered",
        attempts: attempt,
        sourceCacheKeys,
        repairedCacheKeys,
      });
    }

    if (result.generatedWorkflow?.cacheKey) sourceCacheKeys.push(result.generatedWorkflow.cacheKey);
    await recordGeneratedWorkflowLearning(currentTask, result);

    if (attempt >= maxSelfHealingAttempts) {
      return withGeneratedWorkflowSelfHealingMetadata(result, {
        outcome: "exhausted",
        attempts: attempt,
        sourceCacheKeys,
        repairedCacheKeys,
        lastReason: result.failReason,
      });
    }

    const repaired = await attemptGeneratedWorkflowRepair(currentTask, result);
    if (!repaired) {
      return withGeneratedWorkflowSelfHealingMetadata(result, {
        outcome: "repair_unavailable",
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
    outcome: "retry_failed",
    attempts: maxSelfHealingAttempts,
    sourceCacheKeys,
    repairedCacheKeys,
    lastReason: lastResult?.failReason,
  });
}

async function failAgencyWorkflowRunWithError(task: TaskRow, error: Error): Promise<void> {
  const runId = agencyWorkflowRunIdFromTask(task);
  if (!runId) return;
  await transitionAgencyWorkflowRun(runId, {
    targetTerminal: true,
    targetRetryable: true,
    targetAdministrative: false,
    transitionMarkCompleted: true,
    transitionClearFailure: false,
  }, {
    error: error.message,
    rootErrorCode: (error as Error & { code?: string }).code ?? "UNHANDLED_TASK_EXCEPTION",
    rootErrorMessage: error.message,
    rootErrorDetails: { stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? null },
  });
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
  
  // Fetch dispatchable tasks + retryable tasks eligible for retry
  // Exponential backoff: 5 * 3^retry_count seconds (5s, 15s, 45s)
  const result = await db.query<TaskRow>(`
    SELECT tasks.id, tasks.account_id, tasks.device_id, tasks.routine, tasks.params,
           tasks.scheduled_time, tasks.status, tasks.retry_count, tasks.updated_at,
           status_def.dispatchable AS status_dispatchable,
           status_def.retryable AS status_retryable
    FROM tasks
    JOIN lifecycle_state_definitions status_def
      ON status_def.lifecycle_key = tasks.lifecycle_key
     AND status_def.status = tasks.status
    WHERE
      (status_def.dispatchable AND tasks.scheduled_time <= NOW())
      OR (
        status_def.retryable
        AND COALESCE(tasks.retry_count, 0) < $2
        AND tasks.updated_at < NOW() - (INTERVAL '1 second' * (5 * POWER(3, COALESCE(tasks.retry_count, 0))))
      )
    ORDER BY
      status_def.sort_order,
      tasks.scheduled_time ASC
    LIMIT $1
  `, [config.batchSize, config.maxRetries]);
  
  if (result.rows.length === 0) {
    return; // Nothing to do
  }
  
  const dispatchableCount = result.rows.filter((t) => t.status_dispatchable === true).length;
  const retryCount = result.rows.filter((t) => t.status_retryable === true).length;
  console.log(`[task-runner] Found ${dispatchableCount} dispatchable + ${retryCount} retry-eligible tasks`);
  
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
    const started = await transitionTask(taskId, {
      targetTerminal: false,
      targetAdministrative: false,
      targetDispatchable: false,
      transitionMarkStarted: true,
      transitionMarkCompleted: false,
    });
    if (!started) {
      console.warn(`[task-runner] Skipping task ${taskId.slice(0, 8)} — DB lifecycle rejected transition to running`);
      return;
    }
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
      rootFailure: rootFailureFromResult(result),
    };
    
    // Update task status
    if (result.success) {
      await persistSuccessfulTaskResult(taskId, resultJson);
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
      // A deterministic generated-workflow failure invalidates/quarantines the
      // exact artifact. Re-running the same task can only hide the root cause
      // behind a later cache miss. Recovery must create a new explicit run.
      const disableRetry = task.params?.disableTaskRetry === true
        || task.routine === GENERATED_WORKFLOW_ROUTINE;
      const newRetryCount = disableRetry
        ? config.maxRetries
        : currentRetryCount + 1;
      const rootFailure = rootFailureFromResult(result);
      
      await transitionTask(taskId, {
        targetTerminal: true,
        targetRetryable: true,
        targetAdministrative: false,
        transitionMarkCompleted: true,
        transitionClearFailure: false,
      }, {
        result: resultJson,
        error: result.failReason || "Unknown error",
        retryCount: newRetryCount,
        rootErrorCode: rootFailure?.code ?? null,
        rootErrorMessage: rootFailure?.message ?? null,
        rootErrorDetails: rootFailure?.details ?? {},
      });
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
        await recordExhaustedTaskIncident(task, result, {
          taskRetryAttempts: newRetryCount,
          recoveryBudget: config.maxRetries,
        });
      }
    }
    
  } catch (err) {
    // Mark as failed on exception, increment retry_count
    const currentRetryCount = task.retry_count ?? 0;
    const newRetryCount = task.params?.disableTaskRetry === true
      || task.routine === GENERATED_WORKFLOW_ROUTINE
      ? config.maxRetries
      : currentRetryCount + 1;
    const error = err as Error;
    
    await transitionTask(taskId, {
      targetTerminal: true,
      targetRetryable: true,
      targetAdministrative: false,
      transitionMarkCompleted: true,
      transitionClearFailure: false,
    }, {
      error: error.message,
      retryCount: newRetryCount,
      rootErrorCode: (error as Error & { code?: string }).code ?? "UNHANDLED_TASK_EXCEPTION",
      rootErrorMessage: error.message,
      rootErrorDetails: { stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? null },
    });
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
      await recordExhaustedTaskIncident(task, { failReason: error.message }, {
        taskRetryAttempts: newRetryCount,
        recoveryBudget: config.maxRetries,
      });
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
    safetyAdmissionId?: unknown;
    safetyAdmissionContext?: unknown;
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
    const requestedIntent = typeof params.intent === "string" ? params.intent.trim() : "";
    const artifactIntent = typeof cached.sourceMetadata.intent === "string" ? cached.sourceMetadata.intent.trim() : "";
    if (requestedIntent && artifactIntent && requestedIntent !== artifactIntent) {
      generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
      return generatedWorkflowTaskFailure(
        "HUMAN_WORKFLOW_INTENT_MISMATCH",
        "cached workflow intent does not match the requested command",
        startedAt,
        cached,
      );
    }
    const intent = artifactIntent;
    try {
      const cachedWorkflow = normalizeCachedHumanWorkflowTemplate(cached.workflow, cached.sourceMetadata);
      assertHumanWorkflowMeaningful(cachedWorkflow, intent);
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
      ...(typeof params.safetyAdmissionId === "string"
        ? { safetyAdmissionId: params.safetyAdmissionId }
        : {}),
      ...(typeof params.safetyAdmissionId === "string"
        ? {
            safetyArtifactFingerprint: computeWorkflowSafetyArtifactFingerprint(
              cached.compiledPlanHash,
              suppliedVariables ?? {},
            ),
          }
        : {}),
      ...(params.safetyAdmissionContext
        && typeof params.safetyAdmissionContext === "object"
        && !Array.isArray(params.safetyAdmissionContext)
        ? {
            safetyAdmissionContext: params.safetyAdmissionContext as GeneratedWorkflowControlPlaneContext["safetyAdmissionContext"],
          }
        : {}),
    };
    const cachedWorkflow = normalizeCachedHumanWorkflowTemplate(cached.workflow, cached.sourceMetadata);
    const executableWorkflow = await hydrateWorkflowNativePolicies(
      cachedWorkflow as unknown as Record<string, unknown>,
    ) as unknown as WorkflowTemplate;
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

    if (
      finalWorkflow.lifecycleTerminal !== true
      || finalWorkflow.lifecycleRetryable === true
      || finalWorkflow.lifecycleAdministrative === true
    ) {
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

    const outputFailure = dashboardHumanOutputFailure(cached, finalOutput);
    if (outputFailure) {
      generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "output_invalid").inc();
      return {
        success: false,
        stepsCompleted: finalWorkflow.currentStep,
        totalSteps: finalWorkflow.totalSteps ?? cached.workflow.steps.length,
        output: finalOutput,
        tokenUsage: zeroTokenUsage(),
        durationMs: Date.now() - startedAt,
        failReason: `HUMAN_WORKFLOW_OUTPUT_INVALID: ${outputFailure}`,
        generatedWorkflow: {
          ...generatedWorkflowResult,
          failureCode: "HUMAN_WORKFLOW_OUTPUT_INVALID",
        },
      };
    }

    if (executableWorkflow.postconditionContract) {
      const postcondition = evaluatePostconditionContract(executableWorkflow.postconditionContract, {
        outputs: finalOutput,
        inputs: suppliedVariables?.inputs ?? {},
        variables: finalVariables,
      });
      if (!postcondition.ok) {
        generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "output_invalid").inc();
        return {
          success: false,
          stepsCompleted: finalWorkflow.currentStep,
          totalSteps: finalWorkflow.totalSteps ?? cached.workflow.steps.length,
          output: finalOutput,
          tokenUsage: zeroTokenUsage(),
          durationMs: Date.now() - startedAt,
          failReason: `HUMAN_WORKFLOW_POSTCONDITION_FAILED: ${postcondition.failures.join("; ")}`,
          generatedWorkflow: {
            ...generatedWorkflowResult,
            failureCode: "HUMAN_WORKFLOW_POSTCONDITION_FAILED",
          },
        };
      }
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
    const started = await transitionTask(taskId, {
      targetTerminal: false,
      targetAdministrative: false,
      targetDispatchable: false,
      transitionMarkStarted: true,
      transitionMarkCompleted: false,
    });
    if (!started) {
      return { success: false, error: "Task status cannot transition to running" };
    }
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
    
    const rootFailure = rootFailureFromResult(taskResult);
    const resultJson = {
      stepsCompleted: taskResult.stepsCompleted,
      totalSteps: taskResult.totalSteps,
      tokenUsage: taskResult.tokenUsage,
      durationMs: taskResult.durationMs,
      failedStep: taskResult.failedStep,
      output: taskResult.output,
      generatedWorkflow: taskResult.generatedWorkflow,
      rootFailure,
    };
    if (taskResult.success) {
      await persistSuccessfulTaskResult(taskId, resultJson);
    } else {
      await transitionTask(taskId, {
        targetTerminal: true,
        targetRetryable: true,
        targetAdministrative: false,
        transitionMarkCompleted: true,
        transitionClearFailure: false,
      }, {
        result: resultJson,
        error: taskResult.failReason ?? "Unknown error",
        rootErrorCode: rootFailure?.code ?? null,
        rootErrorMessage: rootFailure?.message ?? null,
        rootErrorDetails: rootFailure?.details ?? {},
      });
    }
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

    if (taskResult.success) {
      await reconcileSupersededTaskIncidents(task, taskResult);
    } else {
      await recordExhaustedTaskIncident(task, taskResult, {
        taskRetryAttempts: task.retry_count ?? 0,
        recoveryBudget: config.maxRetries,
      });
    }

    return taskResult;
  } catch (err) {
    await failAgencyWorkflowRunWithError(task, err as Error);
    publishGeneratedWorkflowTaskEvent(task, "task_failed", { error: (err as Error).message });
    await recordExhaustedTaskIncident(task, { failReason: (err as Error).message }, {
      taskRetryAttempts: task.retry_count ?? 0,
      recoveryBudget: config.maxRetries,
    });
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
  const resetCount = await retryConfiguredTasks();
  
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
  return getConfiguredRetryStats(config.maxRetries);
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
