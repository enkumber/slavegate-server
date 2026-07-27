/**
 * workflows/workflow.executor.ts
 * DAG execution engine — ONE BullMQ job per workflow.
 *
 * Design (per FORGE v3 §8 + clarification):
 * - Single long-running BullMQ job per workflow
 * - Internal loop: step → JOB_DISPATCH → await JOB_RESULT → checkpoint → HBE delay → next step
 * - Checkpoint per step in PostgreSQL (atomic BEGIN/UPDATE/COMMIT)
 * - On server crash: BullMQ retries → executor reads checkpoint → resumes from last step
 * - On device disconnect: step timeout → workflow paused → resumes at reconnect
 *
 * JOB_RESULT awaiting:
 *   pendingJobResults: Map<jobId, PendingResult>
 *   WsServer calls resolveJobResult(jobId, result) when JOB_RESULT arrives.
 *   Each step awaits a promise that resolves when the result arrives.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §8
 */

import { Queue, Worker } from "bullmq";
import { createHash } from "crypto";
import { getRedisConnectionOptions } from "../../redis/client";
import { workflowService } from "./workflow.service";
import {
  assertJobActionResultPolicy,
  dispatcherService,
} from "../dispatcher/dispatcher.service";
import {
  LEGACY_GENERATED_WORKFLOW_RESULT_GRACE_MS,
  sendDeviceExecutionJobToDevice,
  sendLegacyGeneratedWorkflowJobToDevice,
  isDeviceOnline,
} from "../../transport/transport";
import { deviceExecutionArbiter } from "../device-execution";
import { isDeviceExecutionEnforced } from "../device-execution/device-execution-authority";
import { scalabilityConfig } from "../../config/scalability.config";
import { getDb } from "../../db/client";
import type {
  WorkflowStatus,
  WorkflowStep,
  WorkflowTemplate,
  WorkflowCheckpoint,
  ActionStep,
  WaitStep,
  ConditionStep,
  LoopStep,
  VerificationStrategy,
  WorkflowExecutionStats,
} from "./types";
import { normal, logNormal, uniform, clamp } from "../hbe/distributions";
import {
  generatedWorkflowRecoveryAttempts,
  generatedWorkflowRecoveryBudgetExhausted,
} from "../observability/metrics";
import { llmJson } from "../../utils/llm";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";
import type { WorkflowRecord } from "./workflow.service";
import { recordJobExecutionEventDetached } from "../observability/job-execution-events";
import { getWorkflowQueueRuntimePolicy } from "./workflow-runtime-config";

// ─── Queue name ───────────────────────────────────────────────────────────────

export const WORKFLOW_QUEUE = scalabilityConfig.workflowQueueName;

type GeneratedChildDispatchResult =
  | Awaited<ReturnType<typeof sendDeviceExecutionJobToDevice>>
  | Awaited<ReturnType<typeof sendLegacyGeneratedWorkflowJobToDevice>>;

export function generatedChildResultTimeoutMs(executionTimeoutMs: number, queued = false): number {
  const graceTimeoutMs = executionTimeoutMs + LEGACY_GENERATED_WORKFLOW_RESULT_GRACE_MS;
  return queued
    ? Math.max(graceTimeoutMs, scalabilityConfig.jobResultTimeout)
    : graceTimeoutMs;
}

function defaultExecutionStats(mode: "edge" | "server" = "server"): WorkflowExecutionStats {
  return {
    compileLlmCalls: 0,
    recoveryLlmCalls: 0,
    creativeLlmCalls: 0,
    runtimeLlmCalls: 0,
    vlmCalls: 0,
    deterministicSteps: 0,
    batchedSteps: 0,
    failedSteps: 0,
    retriedSteps: 0,
    recoveryAttempts: 0,
    recoveryBudgetExhausted: 0,
    mode,
  };
}

function executionStats(checkpoint: WorkflowCheckpoint): WorkflowExecutionStats {
  checkpoint.executionStats ??= defaultExecutionStats("server");
  return checkpoint.executionStats;
}

export const RECOVERY_BUDGET_EXCEEDED = "RECOVERY_BUDGET_EXCEEDED";

export function shouldTerminallyFailWorkflowJob(
  attemptsMade: number,
  err: unknown,
  configuredAttempts = getWorkflowQueueRuntimePolicy().maxAttempts,
): boolean {
  const typed = err as { code?: unknown; message?: unknown } | null;
  return attemptsMade >= configuredAttempts ||
    typed?.code === RECOVERY_BUDGET_EXCEEDED ||
    typed?.message === RECOVERY_BUDGET_EXCEEDED;
}
const GENERATED_WORKFLOW_RECOVERY_ATTEMPTS_KEY = "_generatedWorkflowRecoveryAttemptsByStep";
const GENERATED_WORKFLOW_RECOVERY_TOTAL_ATTEMPTS_KEY = "_generatedWorkflowRecoveryTotalAttempts";
const GENERATED_WORKFLOW_RECOVERY_EVENTS_KEY = "_generatedWorkflowRecoveryEvents";

interface GeneratedWorkflowRuntimeRecoveryPolicy {
  autonomy: string | null;
  aiRecoveryEnabled: boolean;
  maxAttemptsPerStep: number;
  maxAttemptsPerWorkflow: number;
  maxRecoveryActionsPerAttempt: number;
  allowedRecoveryRequests: string[];
  requireStateVerification: boolean;
  learnFromFailure: boolean;
  plannerInstruction: string;
  executeDecisionKey: string;
  retryDecisionKey: string;
  abortDecisionKey: string;
  probeActionKey: string;
  probeTimeoutMs: number;
  plannerSystem: string;
  plannerMaxTokens: number;
  plannerTimeoutMs: number;
}

interface GeneratedWorkflowRecoveryPlan {
  decision: string;
  rationale?: string;
  expectedState?: string;
  steps?: WorkflowStep[];
}

function generatedWorkflowPlatform(template: WorkflowTemplate): string {
  const platform = template.platform.toLowerCase().trim();
  return platform && platform !== "*" ? platform : "unknown";
}

function isGeneratedWorkflowTemplate(template: WorkflowTemplate): boolean {
  return Boolean(template.intent || template.safetyClass || template.outputSchema || template.allowedRecoveryRequests);
}

function recoveryReasonFromError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Screen mismatch")) return "screen_mismatch";
  if (message.includes("Cascade tap failed")) return "cascade_failed";
  if (message.includes("JOB_RESULT timeout")) return "job_timeout";
  if (message.includes("failed")) return "action_failed";
  return "deterministic_failure";
}

function isJobResultTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("JOB_RESULT timeout");
}

export function shouldContinueAfterMissingJobResult(
  _action: string,
  _err: unknown,
  _deviceOnline: boolean,
): boolean {
  // Fail closed: never advances a workflow without a correlated JOB_RESULT.
  // A live socket proves only that HEARTBEAT/PING traffic is flowing. It does
  // not prove that Android received or executed this JOB. Advancing without a
  // correlated JOB_RESULT creates false success and corrupts the checkpoint.
  return false;
}

function generatedWorkflowRecoveryAttemptsByStep(checkpoint: WorkflowCheckpoint): Record<string, number> {
  const existing = checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_ATTEMPTS_KEY];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, number>;
  }

  const created: Record<string, number> = {};
  checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_ATTEMPTS_KEY] = created;
  return created;
}

function generatedWorkflowRecoveryTotalAttempts(checkpoint: WorkflowCheckpoint): number {
  const existing = checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_TOTAL_ATTEMPTS_KEY];
  return typeof existing === "number" && Number.isFinite(existing) && existing >= 0 ? existing : 0;
}

function setGeneratedWorkflowRecoveryTotalAttempts(checkpoint: WorkflowCheckpoint, attempts: number): void {
  checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_TOTAL_ATTEMPTS_KEY] = attempts;
}

function generatedWorkflowRuntimeRecoveryPolicy(template: WorkflowTemplate): GeneratedWorkflowRuntimeRecoveryPolicy {
  const explicit = template.recoveryPolicy;
  const requiredString = (value: unknown, field: string): string => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (explicit?.aiRecoveryEnabled === true && !normalized) {
      throw new Error(`AI recovery policy requires ${field}`);
    }
    return normalized;
  };
  const requiredPositiveInteger = (value: unknown, field: string): number => {
    if (explicit?.aiRecoveryEnabled === true && (!Number.isSafeInteger(value) || Number(value) <= 0)) {
      throw new Error(`AI recovery policy requires positive integer ${field}`);
    }
    return Number.isSafeInteger(value) ? Number(value) : 0;
  };
  const requiredNonnegativeInteger = (value: unknown, field: string): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`PostgreSQL recovery policy requires nonnegative integer ${field}`);
    }
    return Number(value);
  };

  return {
    autonomy: typeof explicit?.autonomy === "string" ? explicit.autonomy : null,
    aiRecoveryEnabled: explicit?.aiRecoveryEnabled === true,
    maxAttemptsPerStep: requiredNonnegativeInteger(explicit?.maxAttemptsPerStep, "maxAttemptsPerStep"),
    maxAttemptsPerWorkflow: requiredNonnegativeInteger(explicit?.maxAttemptsPerWorkflow, "maxAttemptsPerWorkflow"),
    maxRecoveryActionsPerAttempt: requiredNonnegativeInteger(
      explicit?.maxRecoveryActionsPerAttempt,
      "maxRecoveryActionsPerAttempt",
    ),
    allowedRecoveryRequests: explicit?.allowedRecoveryRequests?.length
      ? explicit.allowedRecoveryRequests
      : template.allowedRecoveryRequests?.length
        ? template.allowedRecoveryRequests
        : [],
    requireStateVerification: explicit?.requireStateVerification === true,
    learnFromFailure: explicit?.learnFromFailure === true,
    plannerInstruction: requiredString(explicit?.plannerInstruction, "plannerInstruction"),
    executeDecisionKey: requiredString(explicit?.executeDecisionKey, "executeDecisionKey"),
    retryDecisionKey: requiredString(explicit?.retryDecisionKey, "retryDecisionKey"),
    abortDecisionKey: requiredString(explicit?.abortDecisionKey, "abortDecisionKey"),
    probeActionKey: requiredString(explicit?.probeActionKey, "probeActionKey"),
    probeTimeoutMs: requiredPositiveInteger(explicit?.probeTimeoutMs, "probeTimeoutMs"),
    plannerSystem: requiredString(explicit?.plannerSystem, "plannerSystem"),
    plannerMaxTokens: requiredPositiveInteger(explicit?.plannerMaxTokens, "plannerMaxTokens"),
    plannerTimeoutMs: requiredPositiveInteger(explicit?.plannerTimeoutMs, "plannerTimeoutMs"),
  };
}

function recordGeneratedWorkflowRecoveryEvent(
  template: WorkflowTemplate,
  checkpoint: WorkflowCheckpoint,
  stepIndex: number,
  err: unknown,
  policy: GeneratedWorkflowRuntimeRecoveryPolicy,
  attempts: { stepAttempt: number; workflowAttempt: number },
): void {
  if (!policy.learnFromFailure) return;

  const existing = checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_EVENTS_KEY];
  const events = Array.isArray(existing) ? existing : [];
  events.push({
    at: new Date().toISOString(),
    platform: generatedWorkflowPlatform(template),
    safetyClass: template.safetyClass ?? null,
    autonomy: policy.autonomy,
    stepIndex,
    reason: recoveryReasonFromError(err),
    error: err instanceof Error ? err.message : String(err),
    stepAttempt: attempts.stepAttempt,
    workflowAttempt: attempts.workflowAttempt,
    maxAttemptsPerStep: policy.maxAttemptsPerStep,
    maxAttemptsPerWorkflow: policy.maxAttemptsPerWorkflow,
    maxRecoveryActionsPerAttempt: policy.maxRecoveryActionsPerAttempt,
    allowedRecoveryRequests: policy.allowedRecoveryRequests,
    requireStateVerification: policy.requireStateVerification,
  });
  checkpoint.variables[GENERATED_WORKFLOW_RECOVERY_EVENTS_KEY] = events.slice(-20);
}

function recordGeneratedWorkflowRecoveryFailure(
  template: WorkflowTemplate,
  checkpoint: WorkflowCheckpoint,
  stepIndex: number,
  err: unknown,
): Error | null {
  if (!isGeneratedWorkflowTemplate(template)) return null;

  const stats = executionStats(checkpoint);
  const policy = generatedWorkflowRuntimeRecoveryPolicy(template);
  const attemptsByStep = generatedWorkflowRecoveryAttemptsByStep(checkpoint);
  const key = String(stepIndex);
  const priorAttempts = attemptsByStep[key] ?? 0;
  const priorWorkflowAttempts = generatedWorkflowRecoveryTotalAttempts(checkpoint);
  const platform = generatedWorkflowPlatform(template);

  if (priorAttempts >= policy.maxAttemptsPerStep || priorWorkflowAttempts >= policy.maxAttemptsPerWorkflow) {
    stats.recoveryBudgetExhausted++;
    generatedWorkflowRecoveryBudgetExhausted?.labels(platform).inc();
    return Object.assign(new Error(RECOVERY_BUDGET_EXCEEDED), { code: RECOVERY_BUDGET_EXCEEDED });
  }

  attemptsByStep[key] = priorAttempts + 1;
  setGeneratedWorkflowRecoveryTotalAttempts(checkpoint, priorWorkflowAttempts + 1);
  stats.recoveryAttempts++;
  generatedWorkflowRecoveryAttempts?.labels(platform, recoveryReasonFromError(err)).inc();
  recordGeneratedWorkflowRecoveryEvent(template, checkpoint, stepIndex, err, policy, {
    stepAttempt: attemptsByStep[key],
    workflowAttempt: priorWorkflowAttempts + 1,
  });
  return null;
}

async function dispatchGeneratedWorkflowProbe(
  workflowId: string,
  deviceId: string,
  stepIndex: number,
  type: string,
  timeoutMs: number,
): Promise<JobStepResult | null> {
  try {
    const {
      jobId,
      nativeOpcode,
      observationOnly,
      verificationOpcode,
      params,
    } = await dispatcherService.dispatchLegacyGeneratedWorkflow({
      deviceId,
      type,
      params: {},
      timeoutMs,
      workflowId,
      stepIndex,
    });
    const resultTimeoutMs = Math.max(generatedChildResultTimeoutMs(timeoutMs), scalabilityConfig.jobResultTimeout);
    const prepared = prepareGeneratedChildJobResult(jobId, resultTimeoutMs);
    let dispatch: GeneratedChildDispatchResult;
    try {
      dispatch = await sendLegacyGeneratedWorkflowJobToDevice(
        deviceId,
        { jobId, type, nativeOpcode, observationOnly, verificationOpcode, params, timeoutMs },
        { resultTimeoutMs },
      );
    } catch (err) {
      prepared.cancel();
      throw err;
    }
    if (!dispatch.sent && !dispatch.queued) {
      prepared.cancel();
      return null;
    }
    return await awaitGeneratedChildJobResult(workflowId, jobId, dispatch, resultTimeoutMs, prepared);
  } catch {
    return null;
  }
}

function summarizeRecoveryOutput(output: unknown, maxLength = 5000): string {
  if (output === null || output === undefined) return "not available";
  try {
    return JSON.stringify(output).slice(0, maxLength);
  } catch {
    return String(output).slice(0, maxLength);
  }
}

function buildGeneratedWorkflowRecoveryPrompt(input: {
  template: WorkflowTemplate;
  step: WorkflowStep;
  stepIndex: number;
  err: unknown;
  policy: GeneratedWorkflowRuntimeRecoveryPolicy;
  uiState: string;
}): string {
  return `${input.policy.plannerInstruction}\n\n${JSON.stringify({
    workflow: {
      id: input.template.id,
      platform: input.template.platform,
      safetyClass: input.template.safetyClass ?? null,
      intent: input.template.intent ?? null,
    },
    failedStep: input.step,
    stepIndex: input.stepIndex,
    failure: input.err instanceof Error ? input.err.message : String(input.err),
    currentUiState: input.uiState,
    policy: {
      autonomy: input.policy.autonomy,
      maxRecoveryActionsPerAttempt: input.policy.maxRecoveryActionsPerAttempt,
      allowedRecoveryRequests: input.policy.allowedRecoveryRequests,
      requireStateVerification: input.policy.requireStateVerification,
      decisionKeys: {
        execute: input.policy.executeDecisionKey,
        retry: input.policy.retryDecisionKey,
        abort: input.policy.abortDecisionKey,
      },
    },
  })}`;
}

function normalizeGeneratedWorkflowRecoveryPlan(
  raw: unknown,
  policy: GeneratedWorkflowRuntimeRecoveryPolicy,
): GeneratedWorkflowRecoveryPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { decision: policy.retryDecisionKey };
  const candidate = raw as Record<string, unknown>;
  const allowed = new Set([policy.executeDecisionKey, policy.retryDecisionKey, policy.abortDecisionKey]);
  const decision = typeof candidate.decision === "string" && allowed.has(candidate.decision)
    ? candidate.decision
    : policy.retryDecisionKey;
  return {
    decision,
    rationale: typeof candidate.rationale === "string" ? candidate.rationale.slice(0, 1000) : undefined,
    expectedState: typeof candidate.expectedState === "string" ? candidate.expectedState.slice(0, 1000) : undefined,
    steps: Array.isArray(candidate.steps) ? candidate.steps as WorkflowStep[] : undefined,
  };
}

function normalizeGeneratedWorkflowRecoveryStep(step: WorkflowStep, index: number): WorkflowStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  return {
    id: (step as { id?: string }).id ?? `ai_recovery_step_${index + 1}`,
    ...step,
  } as WorkflowStep;
}

function validateGeneratedWorkflowRecoverySteps(
  template: WorkflowTemplate,
  policy: GeneratedWorkflowRuntimeRecoveryPolicy,
  steps: WorkflowStep[],
): { ok: true; steps: WorkflowStep[] } | { ok: false; error: string } {
  const bounded = steps
    .slice(0, policy.maxRecoveryActionsPerAttempt)
    .map((step, index) => normalizeGeneratedWorkflowRecoveryStep(step, index));
  const candidate: WorkflowTemplate = {
    id: `${template.id}_ai_recovery_plan`,
    name: `${template.name} AI recovery plan`,
    platform: template.platform,
    description: "Bounded AI-generated recovery workflow",
    version: template.version,
    safetyClass: template.safetyClass,
    recoveryPolicy: { ...template.recoveryPolicy, aiRecoveryEnabled: false, maxAttemptsPerStep: 0, maxAttemptsPerWorkflow: 0 },
    steps: bounded,
    defaultVerificationStrategy: template.defaultVerificationStrategy,
    dataRetentionDays: template.dataRetentionDays,
  };
  const validation = validateGeneratedWorkflowTemplate(candidate);
  if (!validation.ok) return { ok: false, error: validation.errors.join("; ") };
  return { ok: true, steps: bounded };
}

async function attemptGeneratedWorkflowAiRecovery(
  workflowId: string,
  deviceId: string,
  template: WorkflowTemplate,
  failedStep: WorkflowStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex: number,
  err: unknown,
  job?: import("bullmq").Job,
): Promise<boolean> {
  const policy = generatedWorkflowRuntimeRecoveryPolicy(template);
  if (!policy.aiRecoveryEnabled) {
    return true;
  }

  const stats = executionStats(checkpoint);
  stats.recoveryLlmCalls++;
  stats.runtimeLlmCalls++;

  const uiDump = await dispatchGeneratedWorkflowProbe(
    workflowId,
    deviceId,
    stepIndex,
    policy.probeActionKey,
    policy.probeTimeoutMs,
  );
  const uiState = summarizeRecoveryOutput(uiDump?.output, 6000);
  const prompt = buildGeneratedWorkflowRecoveryPrompt({ template, step: failedStep, stepIndex, err, policy, uiState });

  let plan: GeneratedWorkflowRecoveryPlan;
  try {
    plan = normalizeGeneratedWorkflowRecoveryPlan(await llmJson<GeneratedWorkflowRecoveryPlan>(prompt, undefined, {
      max_tokens: policy.plannerMaxTokens,
      timeoutMs: policy.plannerTimeoutMs,
      temperature: 0,
      system: policy.plannerSystem,
    }), policy);
  } catch (plannerErr) {
    console.warn(`[workflow] ${workflowId} AI recovery planner failed at step ${stepIndex}: ${(plannerErr as Error).message}`);
    checkpoint.variables._lastAiRecoveryPlannerError = (plannerErr as Error).message;
    return true;
  }

  checkpoint.variables._lastAiRecoveryPlan = {
    at: new Date().toISOString(),
    stepIndex,
    decision: plan.decision,
    rationale: plan.rationale ?? null,
    expectedState: plan.expectedState ?? null,
    stepCount: plan.steps?.length ?? 0,
  };

  if (plan.decision === policy.abortDecisionKey) {
    checkpoint.variables._lastAiRecoveryAbort = plan.rationale ?? "AI recovery planner aborted";
    return false;
  }
  if (plan.decision === policy.retryDecisionKey) {
    return true;
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const validated = validateGeneratedWorkflowRecoverySteps(template, policy, steps);
  if (!validated.ok) {
    checkpoint.variables._lastAiRecoveryValidationError = validated.error;
    console.warn(`[workflow] ${workflowId} AI recovery plan rejected: ${validated.error}`);
    return true;
  }

  try {
    console.log(`[workflow] ${workflowId} executing AI recovery plan (${validated.steps.length} steps) before retrying step ${stepIndex}`);
    await executeSteps(workflowId, deviceId, template, validated.steps, checkpoint, 0, job, true);
    if (policy.requireStateVerification) {
      await dispatchGeneratedWorkflowProbe(
        workflowId,
        deviceId,
        stepIndex,
        policy.probeActionKey,
        policy.probeTimeoutMs,
      );
    }
    return true;
  } catch (recoveryErr) {
    checkpoint.variables._lastAiRecoveryExecutionError = (recoveryErr as Error).message;
    console.warn(`[workflow] ${workflowId} AI recovery execution failed at step ${stepIndex}: ${(recoveryErr as Error).message}`);
    return false;
  }
}

// ─── Pending job result registry ─────────────────────────────────────────────
// Workflow executor suspends at each action step, waiting for JOB_RESULT.
// WsServer calls resolveJobResult() when the device responds.

interface PendingResult {
  resolve: (result: JobStepResult) => void;
  reject:  (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface PreparedGeneratedChildJobResult {
  promise: Promise<JobStepResult>;
  armTimeout: (timeoutMs: number) => void;
  cancel: () => void;
}

export interface JobStepResult {
  successful:   boolean;
  output?:      unknown;
  error?:       string;
  durationMs:   number;
  verification?: unknown;
}

function materializeScreenshotArtifact(
  checkpoint: WorkflowCheckpoint,
  jobId: string,
  result: JobStepResult,
): void {
  const output = result.output as Record<string, unknown> | undefined;
  const imageBase64 = typeof output?.image_base64 === "string" ? output.image_base64 : null;

  const artifact = {
    jobId,
    jobEndpoint: `/api/jobs/${jobId}`,
    capturedAt: new Date().toISOString(),
    hasImage: Boolean(imageBase64),
    width: typeof output?.width === "number" ? output.width : null,
    height: typeof output?.height === "number" ? output.height : null,
    originalWidth: typeof output?.original_width === "number" ? output.original_width : null,
    originalHeight: typeof output?.original_height === "number" ? output.original_height : null,
    format: typeof output?.format === "string" ? output.format : null,
    bytes: imageBase64 ? Buffer.byteLength(imageBase64, "base64") : 0,
    sha256: imageBase64
      ? createHash("sha256").update(Buffer.from(imageBase64, "base64")).digest("hex")
      : null,
  };

  checkpoint.variables.lastScreenshotArtifact = artifact;
  const existing = checkpoint.variables.screenshotArtifacts;
  const artifacts = Array.isArray(existing) ? existing : [];
  artifacts.push(artifact);
  checkpoint.variables.screenshotArtifacts = artifacts.slice(-5);
}

const pendingJobResults = new Map<string, PendingResult>();

/**
 * Called by WsServer when JOB_RESULT arrives from a device.
 * Resolves the awaiting executor step.
 */
export function resolveJobResult(jobId: string, result: JobStepResult): boolean {
  // Try workflow executor first
  const pending = pendingJobResults.get(jobId);
  if (pending) {
    clearTimeout(pending.timeoutHandle);
    pendingJobResults.delete(jobId);
    pending.resolve(result);
    return true;
  }
  
  return false;
}

/**
 * Wait for device to respond with JOB_RESULT.
 * Rejects with timeout error if device doesn't respond within timeoutMs.
 */
function awaitJobResult(jobId: string, timeoutMs: number): Promise<JobStepResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingJobResults.delete(jobId);
      reject(new Error(`JOB_RESULT timeout after ${timeoutMs}ms (jobId=${jobId})`));
    }, timeoutMs);

    pendingJobResults.set(jobId, { resolve, reject, timeoutHandle });
  });
}

/**
 * Register the workflow executor waiter before the JOB frame can reach the
 * device. Fast observation actions (notably ui_tree_dump) may return their
 * JOB_RESULT synchronously with the transport send; registering afterwards
 * loses that result even though the DirectWS/PNQ waiter accepted it.
 */
export function prepareGeneratedChildJobResult(
  jobId: string,
  initialTimeoutMs: number,
): PreparedGeneratedChildJobResult {
  let pending!: PendingResult;
  const promise = new Promise<JobStepResult>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (pendingJobResults.get(jobId) !== pending) return;
      pendingJobResults.delete(jobId);
      reject(new Error(`JOB_RESULT timeout after ${initialTimeoutMs}ms (jobId=${jobId})`));
    }, initialTimeoutMs);
    pending = { resolve, reject, timeoutHandle };
    pendingJobResults.set(jobId, pending);
  });
  // The transport admission call is awaited before the caller awaits this
  // promise. Attach a handler immediately so a transport stall cannot surface
  // a transient unhandled rejection; the original promise still rejects for
  // the workflow executor.
  void promise.catch(() => undefined);

  return {
    promise,
    armTimeout(timeoutMs: number) {
      if (pendingJobResults.get(jobId) !== pending) return;
      clearTimeout(pending.timeoutHandle);
      pending.timeoutHandle = setTimeout(() => {
        if (pendingJobResults.get(jobId) !== pending) return;
        pendingJobResults.delete(jobId);
        pending.reject(new Error(`JOB_RESULT timeout after ${timeoutMs}ms (jobId=${jobId})`));
      }, timeoutMs);
    },
    cancel() {
      if (pendingJobResults.get(jobId) !== pending) return;
      clearTimeout(pending.timeoutHandle);
      pendingJobResults.delete(jobId);
    },
  };
}

export function awaitGeneratedChildJobResult(
  workflowId: string,
  jobId: string,
  dispatch: GeneratedChildDispatchResult,
  resultTimeoutMs: number,
  prepared?: PreparedGeneratedChildJobResult,
): Promise<JobStepResult> {
  if (!dispatch.sent && !dispatch.queued) {
    prepared?.cancel();
    throw new Error(`Failed to send job to device: ${dispatch.reason ?? dispatch.decision}`);
  }

  // A server-mode workflow can be admitted behind another device root. Its
  // first child JOB is then persisted by PNQ and replayed by the queue pump
  // after the active root finishes. `would_wait` is therefore an accepted
  // dispatch state, not a device/recovery failure.
  if (dispatch.queued) {
    console.log(
      `[workflow] ${workflowId} child job ${jobId.slice(0, 8)} queued behind the active device root; awaiting PNQ replay`,
    );
  }
  if (prepared) {
    prepared.armTimeout(resultTimeoutMs);
    return prepared.promise;
  }
  return awaitJobResult(jobId, resultTimeoutMs);
}

// ─── Queue ────────────────────────────────────────────────────────────────────

let workflowQueue: Queue | null = null;

export function getWorkflowQueue(): Queue {
  if (!workflowQueue) {
    workflowQueue = new Queue(WORKFLOW_QUEUE, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: {
        // timeout removed — BullMQ v5 removed this option; use worker-level timeout instead
        removeOnComplete: true,
        removeOnFail:     false,      // Keep for debugging
      },
    });
  }
  return workflowQueue;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let workflowWorker: Worker | null = null;

export function startWorkflowWorker(): Worker {
  if (workflowWorker) return workflowWorker;
  const worker = new Worker(
    scalabilityConfig.workflowQueueName,
    async (job) => {
      const { workflowId } = job.data as { workflowId: string };
      await runWorkflow(workflowId, job);
    },
    {
      connection:    getRedisConnectionOptions(),
      concurrency:   scalabilityConfig.workerConcurrency,
      lockDuration:  scalabilityConfig.workerLockDuration,
      stalledInterval: scalabilityConfig.workerStalledInterval,
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { workflowId } = job.data as { workflowId: string };
    const configuredAttempts = typeof job.opts.attempts === "number"
      ? job.opts.attempts
      : getWorkflowQueueRuntimePolicy().maxAttempts;
    if (shouldTerminallyFailWorkflowJob(job.attemptsMade, err, configuredAttempts)) {
      console.error(`[workflow] terminal failure: ${workflowId} after ${job.attemptsMade} attempts: ${err.message}`);
      await workflowService.markFailed(workflowId, err.message);
      const workflow = await workflowService.get(workflowId);
      if (workflow?.deviceId) {
        await deviceExecutionArbiter.finishServerWorkflowRoot({
          deviceId: workflow.deviceId,
          workflowId,
          successful: false,
          actor: "workflow_worker",
          reason: err.message,
        });
      }
    } else {
      console.warn(`[workflow] ${workflowId} attempt ${job.attemptsMade} failed — retrying from checkpoint: ${err.message}`);
    }
  });

  console.log("[workflow] Worker started");
  workflowWorker = worker;
  return workflowWorker;
}

// ─── Core execution loop ──────────────────────────────────────────────────────

async function reconcileTerminalWorkflowRoot(
  workflow: WorkflowRecord,
  actor: string,
): Promise<void> {
  if (!workflow.deviceId || !workflow.lifecycleTerminal) return;
  await deviceExecutionArbiter.finishServerWorkflowRoot({
    deviceId: workflow.deviceId,
    workflowId: workflow.id,
    successful: !workflow.lifecycleRetryable && !workflow.lifecycleAdministrative,
    actor,
    reason: `persisted_workflow_already_${workflow.status}`,
  });
}

export async function runWorkflow(workflowId: string, job: import("bullmq").Job): Promise<void> {
  const wf = await workflowService.get(workflowId);
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);

  if (wf.lifecycleTerminal) {
    await reconcileTerminalWorkflowRoot(wf, "workflow_executor.retry_reconcile");
    return;
  }

  if (!wf.templateId) throw new Error(`Workflow ${workflowId} has no template`);
  const persistedTemplate = await workflowService.getTemplate(wf.templateId);
  if (!persistedTemplate) throw new Error(`Template ${wf.templateId} not found`);
  const template = await dispatcherService.hydrateWorkflowNativePolicies(
    persistedTemplate as unknown as Record<string, unknown>,
  ) as unknown as WorkflowTemplate;

  if (!wf.deviceId) throw new Error(`Workflow ${workflowId} has no deviceId`);

  // Admit the durable server-workflow root before changing the workflow row
  // to running. If another root owns the device, keep the row queued while
  // the first child operation is persisted behind that owner. This preserves
  // the task-runner's queued-only cancellation CAS until PNQ grants the turn.
  let admissionDecision: string | null = null;
  if (wf.lifecycleInitial) {
    const admission = await deviceExecutionArbiter.observeAdmission({
      deviceId: wf.deviceId,
      rootKind: "server_workflow",
      externalId: workflowId,
      requestKey: workflowId,
      actor: "workflow_executor",
      metadata: { observeSource: "workflowExecutor.runWorkflow" },
    });
    admissionDecision = admission.decision;
    if (!["admitted", "duplicate", "would_wait"].includes(admission.decision)) {
      throw new Error(`Workflow ${workflowId} PNQ admission failed: ${admission.reason ?? admission.decision}`);
    }
  }

  // A failed BullMQ attempt leaves the durable workflow row in `running` so
  // the next attempt can resume from its checkpoint. Only claim rows that are
  // not already running; treating a failed claim as success can strand the
  // server_workflow PNQ root forever.
  if (wf.lifecycleInitial && (!isDeviceExecutionEnforced() || admissionDecision !== "would_wait")) {
    const started = await workflowService.markRunning(workflowId);
    if (!started) {
      const latest = await workflowService.get(workflowId);
      if (!latest) throw new Error(`Workflow ${workflowId} disappeared while transitioning to running`);
      if (latest.lifecycleTerminal) {
        await reconcileTerminalWorkflowRoot(latest, "workflow_executor.transition_reconcile");
        return;
      }
      throw new Error(
        `Workflow ${workflowId} could not transition to running; persisted status=${latest.status}`,
      );
    }
  }

  // Start from checkpoint (resume after crash/pause)
  const startStep = wf.checkpoint.stepIndex ?? 0;
  const checkpoint: WorkflowCheckpoint = {
    ...wf.checkpoint,
    loopStack:  wf.checkpoint.loopStack ?? [],   // Ensure loopStack always exists (old checkpoints)
  };

  console.log(`[workflow] ${workflowId} starting at step ${startStep}/${template.steps.length}`);

  await executeSteps(
    workflowId,
    wf.deviceId,
    template,
    template.steps,
    checkpoint,
    startStep,
    job
  );

  await workflowService.markCompleted(workflowId);
  await deviceExecutionArbiter.finishServerWorkflowRoot({
    deviceId: wf.deviceId,
    workflowId,
    successful: true,
    actor: "workflow_executor",
  });
  console.log(`[workflow] ${workflowId} completed`);
}

// ─── DAG traversal ────────────────────────────────────────────────────────────

async function executeSteps(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  steps:      WorkflowStep[],
  checkpoint: WorkflowCheckpoint,
  startIndex: number = 0,
  job?: import("bullmq").Job,
  isNested: boolean = false  // true when called from loop/condition (skip checkpoint)
): Promise<void> {
  for (let segIdx = startIndex; segIdx < steps.length; segIdx++) {
    const step = steps[segIdx];
    const current = await withTimeout(
      workflowService.get(workflowId),
      scalabilityConfig.cancelCheckTimeout,
      `workflowService.get(${workflowId}) timeout at step ${segIdx}`,
    );
    if (current?.lifecycleTerminal) return;
    if (current?.lifecycleAdministrative && !current.lifecycleTerminal) {
      throw new Error(`Workflow paused at step ${segIdx}`);
    }

    try {
      await executeStep(workflowId, deviceId, template, step, checkpoint, segIdx, job);
      executionStats(checkpoint).deterministicSteps++;
    } catch (err) {
      executionStats(checkpoint).failedSteps++;
      if (isNested) throw err;

      const budgetErr = recordGeneratedWorkflowRecoveryFailure(template, checkpoint, segIdx, err);
      await workflowService.saveCheckpoint(
        workflowId,
        { ...checkpoint, checkpointAt: new Date().toISOString() },
        segIdx,
        segIdx,
      );
      if (budgetErr) throw budgetErr;

      const recovered = await attemptGeneratedWorkflowAiRecovery(
        workflowId,
        deviceId,
        template,
        step,
        checkpoint,
        segIdx,
        err,
        job,
      );
      if (!recovered) throw err;

      try {
        executionStats(checkpoint).retriedSteps++;
        await executeStep(workflowId, deviceId, template, step, checkpoint, segIdx, job);
        executionStats(checkpoint).deterministicSteps++;
      } catch (retryErr) {
        await workflowService.saveCheckpoint(
          workflowId,
          { ...checkpoint, checkpointAt: new Date().toISOString() },
          segIdx,
          segIdx,
        );
        throw retryErr;
      }
    }

    if (job) {
      try {
        await job.extendLock(job.token!, 60000);
      } catch (lockErr) {
        console.warn(`[workflow] ${workflowId} failed to extend lock at step ${segIdx}: ${lockErr}`);
      }
    }

    if (!isNested) {
      const saved = await workflowService.saveCheckpoint(
        workflowId,
        { ...checkpoint, stepIndex: segIdx + 1, checkpointAt: new Date().toISOString() },
        segIdx + 1,
        segIdx,
      );
      if (!saved) throw new Error(`Checkpoint conflict at step ${segIdx} — aborting`);
      checkpoint.stepIndex = segIdx + 1;
    }
  }
}

// ─── Single step dispatch ─────────────────────────────────────────────────────

async function executeStep(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  step:       WorkflowStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex:  number,
  job?: import("bullmq").Job
): Promise<void> {
  const stepId = (step as { id?: string }).id ?? step.type;
  const stepAction = (step as ActionStep).action ?? '';
  console.log(`[workflow] ${workflowId} step ${stepIndex} executing: type=${step.type}${stepAction ? ' action='+stepAction : ''}${stepId !== step.type ? ' id='+stepId : ''}`);

  switch (step.type) {

    case "action": {
      await executeActionStep(workflowId, deviceId, template, step, checkpoint, stepIndex);
      break;
    }

    case "wait": {
      const delayMs = resolveWaitDuration(step);
      if (delayMs > 0) {
        console.log(`[workflow] ${workflowId} step ${stepIndex} wait ${delayMs}ms`);
        await sleep(delayMs);
      }
      break;
    }

    case "condition": {
      const taken = evaluateCondition(step, checkpoint);
      const branch = taken ? step.if_true : (step.if_false ?? []);
      if (branch.length > 0) {
        await executeSteps(workflowId, deviceId, template, branch, checkpoint, 0, job, true);
      }
      break;
    }

    case "loop": {
      const count = resolveLoopCount(step);
      console.log(`[workflow] ${workflowId} step ${stepIndex} loop ×${count}`);

      // Find or create loopStack entry for this step
      const stackEntry = checkpoint.loopStack.find(e => e.stepIndex === stepIndex);
      const startIter  = stackEntry?.currentIteration ?? 0;  // Resume from here on restart

      if (startIter > 0) {
        console.log(`[workflow] ${workflowId} loop step ${stepIndex}: resuming from iteration ${startIter}/${count}`);
      }

      for (let iter = startIter; iter < count; iter++) {
        // Update loopStack BEFORE executing — so a mid-iteration crash records correct state
        const existingIdx = checkpoint.loopStack.findIndex(e => e.stepIndex === stepIndex);
        const entry = { stepIndex, currentIteration: iter, totalIterations: count };
        if (existingIdx >= 0) {
          checkpoint.loopStack[existingIdx] = entry;
        } else {
          checkpoint.loopStack.push(entry);
        }
        await workflowService.saveCheckpoint(workflowId, checkpoint, stepIndex, stepIndex);

        await executeSteps(workflowId, deviceId, template, step.steps, checkpoint, 0, job, true);
        // Reset inner step index after each loop iteration
        checkpoint.stepIndex = stepIndex;

        // Mark this iteration as completed (next resume starts at iter+1)
        const doneIdx = checkpoint.loopStack.findIndex(e => e.stepIndex === stepIndex);
        if (doneIdx >= 0) {
          checkpoint.loopStack[doneIdx] = { stepIndex, currentIteration: iter + 1, totalIterations: count };
        }
      }

      // Loop complete — remove its entry from stack
      checkpoint.loopStack = checkpoint.loopStack.filter(e => e.stepIndex !== stepIndex);
      break;
    }

    case "checkpoint": {
      // Explicit checkpoint — already handled by outer loop after every step.
      // Nothing extra to do here; logging for observability.
      console.log(`[workflow] ${workflowId} explicit checkpoint: ${step.id}`);
      break;
    }
  }
}

// ─── Action step (core: dispatch → await result) ──────────────────────────────

async function executeActionStep(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  step:       ActionStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex:  number
): Promise<void> {
  if (!isDeviceOnline(deviceId)) {
    // Device offline — pause and let BullMQ retry on reconnect
    await workflowService.markPaused(workflowId);
    throw new Error(`Device ${deviceId} offline at step ${stepIndex}`);
  }

  const strategy = (step.verification ?? template.defaultVerificationStrategy) as VerificationStrategy;
  let finalParams: Record<string, unknown> = { ...(step.params ?? {}) };

  if (!Number.isSafeInteger(step.timeoutMs) || Number(step.timeoutMs) < 1) {
    throw new Error(`Step ${stepIndex} is missing its PostgreSQL-hydrated timeoutMs`);
  }
  const timeoutMs = Number(step.timeoutMs);

  // ═══════════════════════════════════════════════════════════════════════════
  // CASCADE TAP: If this is a tap action with a target element, use skill system
  // ═══════════════════════════════════════════════════════════════════════════
  const jobType = step.action as import("../../../shared/protocol/messages").JobType;

  const {
    jobId,
    timeoutMs: dispatchedTimeoutMs,
    requiresRoot,
    nativeOpcode,
    observationOnly,
    verificationOpcode,
    executionPolicy,
    params: dispatchedParams,
  } = await dispatcherService.dispatchLegacyGeneratedWorkflow({
    deviceId,
    type:        jobType,
    params:      finalParams as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
    confirmRoot: true,
    workflowId,
    stepIndex,
    verificationStrategy: strategy,
  });

  finalParams = { ...dispatchedParams };
  applyWorkflowParameterBindings(finalParams, checkpoint.variables, executionPolicy);

  // Write audit log entry at dispatch
  const db = getDb();
  await db.query(
    `INSERT INTO command_log (device_id, job_id, command_type, command_raw, command_params)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [deviceId, jobId, step.action, `workflow:${workflowId} step:${stepIndex} ${step.action}`, JSON.stringify(finalParams)]
  );

  // Send to device via DirectWS transport
  // Keep the executor clock aligned with the dispatcher clock. The previous
  // minimum of scalabilityConfig.jobResultTimeout (5 minutes) left workflows
  // waiting long after the jobs table had already marked the child timed out.
  const resultTimeoutMs = generatedChildResultTimeoutMs(dispatchedTimeoutMs);
  const prepared = prepareGeneratedChildJobResult(jobId, resultTimeoutMs);
  recordJobExecutionEventDetached({
    jobId,
    deviceId,
    workflowId,
    source: "workflow_executor",
    eventType: "result_wait_registered",
    details: { jobType, stepIndex, executionTimeoutMs: dispatchedTimeoutMs, resultTimeoutMs },
  });
  let dispatch: GeneratedChildDispatchResult;
  try {
    dispatch = await sendLegacyGeneratedWorkflowJobToDevice(deviceId, {
      jobId,
      type:     jobType,
      nativeOpcode,
      observationOnly,
      verificationOpcode,
      params:   finalParams as import("../../../shared/protocol/messages").JobParams,
      timeoutMs: dispatchedTimeoutMs,
      requiresRoot,
    }, { resultTimeoutMs });
  } catch (err) {
    prepared.cancel();
    recordJobExecutionEventDetached({
      jobId,
      deviceId,
      workflowId,
      source: "workflow_executor",
      eventType: "dispatch_failed",
      details: { jobType, stepIndex, error: (err as Error).message },
    });
    throw err;
  }
  recordJobExecutionEventDetached({
    jobId,
    deviceId,
    workflowId,
    source: "workflow_executor",
    eventType: dispatch.sent ? "dispatch_sent" : dispatch.queued ? "dispatch_queued" : "dispatch_rejected",
    details: { jobType, stepIndex, decision: dispatch.decision, reason: dispatch.reason ?? null },
  });
  const resultPromise = awaitGeneratedChildJobResult(
    workflowId,
    jobId,
    dispatch,
    resultTimeoutMs,
    prepared,
  );

  console.log(
    `[workflow] ${workflowId} step ${stepIndex} ${dispatch.sent ? "dispatched" : "queued"} ${step.action} → jobId=${jobId}`,
  );

  // ── Await JOB_RESULT from device ──
  // resolveJobResult() will be called by WsServer when JOB_RESULT arrives.
  let result: JobStepResult;
  try {
    result = await resultPromise;
  } catch (err) {
    recordJobExecutionEventDetached({
      jobId,
      deviceId,
      workflowId,
      source: "workflow_executor",
      eventType: isJobResultTimeoutError(err) ? "result_wait_timeout" : "result_wait_failed",
      details: { jobType, stepIndex, error: (err as Error).message, deviceOnline: isDeviceOnline(deviceId) },
    });
    throw err;
  }
  recordJobExecutionEventDetached({
    jobId,
    deviceId,
    workflowId,
    source: "workflow_executor",
    eventType: "result_accepted",
    details: { jobType, stepIndex, successful: result.successful, durationMs: result.durationMs },
  });

  if (!result.successful) {
    const retries = step.retries ?? 0;
    if (retries > 0) {
      console.warn(`[workflow] ${workflowId} step ${stepIndex} failed — retrying (${retries} retries left)`);
      // Modify step retries for recursive retry (crude but effective for Phase 2)
      await executeActionStep(workflowId, deviceId, template, { ...step, retries: retries - 1 }, checkpoint, stepIndex);
      return;
    }
    throw new Error(`Step ${stepIndex} (${step.action}) failed: ${result.error ?? "device reported failure"}`);
  }

  assertJobActionResultPolicy(result, executionPolicy, `Step ${stepIndex}`);
  if (result.output && typeof result.output === "object"
    && typeof (result.output as Record<string, unknown>).image_base64 === "string") {
    materializeScreenshotArtifact(checkpoint, jobId, result);
  }

  const outputVariable = typeof finalParams.outputVariable === "string" ? finalParams.outputVariable.trim() : "";
  if (outputVariable) {
    checkpoint.variables[outputVariable] = result.output ?? null;
  }

  if (!Number.isSafeInteger(step.delayAfterMs) || Number(step.delayAfterMs) < 0) {
    throw new Error(`Step ${stepIndex} is missing its PostgreSQL-hydrated delayAfterMs`);
  }
  if (Number(step.delayAfterMs) > 0) {
    await sleep(Number(step.delayAfterMs));
  }

}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new workflow execution.
 * Called from routes.ts POST /workflows.
 *
 * Uses a 5s timeout on queue.add() to prevent indefinite blocking
 * if Redis is slow or unresponsive.
 */
export async function startWorkflow(workflowId: string): Promise<void> {
  const queue = getWorkflowQueue();
  const queuePolicy = getWorkflowQueueRuntimePolicy();
  const addPromise = queue.add("execute-workflow", { workflowId }, {
    jobId: workflowId,  // Unic per workflow - previne duplicate jobs
    attempts: queuePolicy.maxAttempts,
    backoff: {
      type: queuePolicy.backoffType,
      delay: queuePolicy.backoffDelayMs,
    },
    removeOnComplete: true,
    removeOnFail: false  // Keep for debugging
  });

  // Timeout — don't block the caller if Redis is slow
  const result = await Promise.race([
    addPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`queue.add() timeout for ${workflowId}`)), scalabilityConfig.enqueueTimeout)
    ),
  ]);

  console.log(`[workflow] ${workflowId} enqueued`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readObjectPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function applyWorkflowParameterBindings(
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
  policy: Record<string, unknown>,
): void {
  const bindings = Array.isArray(policy.parameterBindings) ? policy.parameterBindings : [];
  for (const raw of bindings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const binding = raw as Record<string, unknown>;
    const sourceParam = typeof binding.sourceParam === "string" ? binding.sourceParam : "";
    const targetParam = typeof binding.targetParam === "string" ? binding.targetParam : "";
    if (!sourceParam || !targetParam || params[targetParam] !== undefined) continue;
    const variableName = params[sourceParam];
    if (typeof variableName !== "string") continue;
    const resolved = readObjectPath(variables, variableName);
    if (resolved === undefined && binding.required === true) {
      throw new Error(`Required workflow variable '${variableName}' is unavailable`);
    }
    params[targetParam] = resolved ?? binding.defaultValue ?? null;
    if (binding.removeSource !== false) delete params[sourceParam];
  }
  const fallbacks = Array.isArray(policy.parameterFallbacks) ? policy.parameterFallbacks : [];
  for (const raw of fallbacks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const fallback = raw as Record<string, unknown>;
    const targetParam = typeof fallback.targetParam === "string" ? fallback.targetParam : "";
    const variablePath = typeof fallback.variablePath === "string" ? fallback.variablePath : "";
    if (!targetParam || !variablePath || params[targetParam] !== undefined) continue;
    const resolved = readObjectPath(variables, variablePath);
    if (resolved === undefined && fallback.required === true) {
      throw new Error(`Required workflow variable '${variablePath}' is unavailable`);
    }
    if (resolved !== undefined) params[targetParam] = resolved;
  }
}

function resolveWaitDuration(step: WaitStep): number {
  if (!step.duration) return 0;
  const { min, max, distributionOpcode, mean } = step.duration;
  const baseMean = mean ?? (min + max) / 2;
  switch (distributionOpcode) {
    case 0: return uniform(min, max);
    case 1: return clamp(logNormal(baseMean, 0.4), min, max);
    case 2: return clamp(normal(baseMean, (max - min) / 6), min, max);
    default: throw new Error(`Unknown PostgreSQL distribution opcode: ${String(distributionOpcode)}`);
  }
}

function resolveLoopCount(step: LoopStep): number {
  const { min, max, distributionOpcode } = step.count;
  switch (distributionOpcode) {
    case 0: return Math.round(uniform(min, max));
    case 2: return Math.round(clamp(normal((min + max) / 2, (max - min) / 6), min, max));
    default: throw new Error(`Unknown PostgreSQL loop distribution opcode: ${String(distributionOpcode)}`);
  }
}

function evaluateCondition(step: ConditionStep, checkpoint: WorkflowCheckpoint): boolean {
  switch (step.checkOpcode) {
    case 0:
      if (typeof step.probability !== "number") {
        throw new Error("PostgreSQL-hydrated probability is missing");
      }
      return Math.random() < step.probability;
    case 1:
      if (typeof step.expression !== "string" || !step.expression.trim()) {
        throw new Error("PostgreSQL condition opcode requires an expression");
      }
      return evaluateWorkflowExpression(step.expression, checkpoint.variables);
    default:
      throw new Error(`Unknown PostgreSQL condition opcode: ${String(step.checkOpcode)}`);
  }
}

function evaluateWorkflowExpression(expression: string, variables: Record<string, unknown>): boolean {
  const source = expression.trim();
  const orParts = source.split(/\s+\|\|\s+/);
  if (orParts.length > 1) return orParts.some((part) => evaluateWorkflowExpression(part, variables));
  const andParts = source.split(/\s+&&\s+/);
  if (andParts.length > 1) return andParts.every((part) => evaluateWorkflowExpression(part, variables));
  const comparison = source.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*?)$/);
  if (!comparison) return isTruthy(resolveWorkflowExpressionValue(source, variables));
  const [, leftRaw, operator, rightRaw] = comparison;
  const left = resolveWorkflowExpressionValue(leftRaw, variables);
  const right = resolveWorkflowExpressionValue(rightRaw, variables);
  if (operator === "==") return left === right;
  if (operator === "!=") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  if (operator === ">") return left > right;
  if (operator === "<") return left < right;
  if (operator === ">=") return left >= right;
  return left <= right;
}

function resolveWorkflowExpressionValue(source: string, variables: Record<string, unknown>): unknown {
  const value = source.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const numeric = Number(value);
  if (value !== "" && Number.isFinite(numeric)) return numeric;
  const path = value.replace(/^\$/, "").split(".").filter(Boolean);
  let current: unknown = variables;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return value !== null && value !== undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout. Rejects with the given message if the
 * promise doesn't settle within `ms` milliseconds.
 * Used to prevent DB/Redis operations from hanging indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
