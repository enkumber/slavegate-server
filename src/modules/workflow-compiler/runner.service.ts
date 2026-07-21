/**
 * workflow-compiler/runner.service.ts
 * Nivel 1: Deterministic Execution of compiled workflows.
 *
 * Per-step flow:
 *   1. Capture UI tree → compute fingerprint
 *   2. Verify fingerprint matches step.expectedPageHash
 *   3. Execute action (tap/type/swipe/press_key/wait/open_app)
 *   4. Post-action screen verification
 *   5. On mismatch → invoke recovery.service
 *   6. Update progress in DB
 *
 * Integrations:
 *   - page-fingerprint.ts → computePageSignature, isSamePage
 *   - skill.cascade.ts    → executeCascadeTap for element targeting
 *   - screen-verifier.ts  → verifyScreenAfterStep for post-action checks
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "../../db/client";
import { sendServerWorkflowBatchChildToDevice, sendDeviceExecutionJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import type { BATCH_RESULT, BatchStep } from "../../protocol/batch-types";
import { computePageSignature, isSamePage } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import {
  generatedWorkflowRecoveryAttempts,
  generatedWorkflowRecoveryBudgetExhausted,
} from "../observability/metrics";
import { workflowEvents } from "../workflow-events";
import { deviceExecutionArbiter } from "../device-execution";
import { createRunnerUiGraphSession, type RunnerResolvedTarget } from "../ui-graph/runner-bridge";
import { observeUiGraphAction } from "../ui-graph/telemetry";
import { observeLearningCandidate } from "../ui-graph/telemetry";
import { uiGraphRepository } from "../ui-graph/repository";
import { uiGraphLearningLoop, type CandidateObservation } from "../ui-graph/learning-loop";
import type { StateResolution, TargetResolutionMethod } from "../ui-graph/types";
import { GraphRuntimeEngine } from "../ui-graph/graph-runtime";
import type { UiTransitionDefinition } from "../ui-graph/types";
import { normalizeUiTreeOutput } from "./ui-tree-output";

// Import types from canonical types.ts (re-exported via planner for backward compat)
import type { CompiledWorkflow, CompiledStep } from "./types";
import { updateWorkflowStatus } from "./planner.service";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RunCompiledRequest {
  deviceId: string;
  workflow: CompiledWorkflow;
  /** Resume from this step index (for recovery) */
  startStepIndex?: number;
  /** LLM calls already spent compiling this workflow for the current request. */
  compileLlmCalls?: number;
  /** Canonical PNQ server-workflow identity. Defaults to workflow.id. */
  workflowRootExternalId?: string;
}

export interface StepExecutionResult {
  stepIndex: number;
  stepId: string;
  success: boolean;
  fingerprintMatch: boolean;
  postActionVerified: boolean;
  error?: string;
  latencyMs: number;
}

export interface RunCompiledResult {
  ok: boolean;
  workflowId: string;
  status: "completed" | "failed" | "aborted";
  stepsCompleted: number;
  stepsTotal: number;
  recoveryCount: number;
  counters: WorkflowExecutionCounters;
  results: StepExecutionResult[];
  error?: string;
  totalLatencyMs: number;
}

export interface WorkflowExecutionCounters {
  compileLlmCalls: number;
  recoveryLlmCalls: number;
  creativeLlmCalls: number;
  runtimeLlmCalls: number;
  vlmCalls: number;
  deterministicSteps: number;
  batchedSteps: number;
  failedSteps: number;
  retriedSteps: number;
  recoveryAttempts: number;
  recoveryBudgetExhausted: number;
}

export interface RunnerContext {
  deviceId: string;
  workflowRootExternalId: string;
  workflow: CompiledWorkflow;
  stepsCompleted: number;
  recoveryCount: number;
  recoveryAttemptsByStep?: Record<number, number>;
  maxRecoveryAttemptsPerStep?: number;
  maxTotalRecoveryAttempts?: number;
  aiRecoveryEnabled?: boolean;
  /** Recovery evidence staged until the adapted action and postcondition pass. */
  pendingRecoveryLearning?: CandidateObservation;
  results: StepExecutionResult[];
  /** Callback for recovery — injected to avoid circular deps */
  onRecoveryNeeded: (ctx: RunnerContext, stepIndex: number, reason: string) => Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

const STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_AFTER_ACTION_MS = 800;
const MIN_COMPILED_BATCH_SIZE = 2;
const DEFAULT_RECOVERY_ATTEMPTS_PER_STEP = 1;
const MAX_TOTAL_RECOVERY_ATTEMPTS = 10;
const RECOVERY_READINESS_TIMEOUT_MS = 10_000;
export const RECOVERY_BUDGET_EXCEEDED = "RECOVERY_BUDGET_EXCEEDED";
export const AI_RECOVERY_DISABLED = "AI_RECOVERY_DISABLED";

/**
 * Recovery reasoning may outlast a device's screen-off timeout. Restore only
 * generic readiness before replay so a valid adapted selector is not executed
 * against System UI instead of the foreground application.
 */
async function ensureDeviceReadyForRecoveryReplay(
  deviceId: string,
  workflowRootExternalId: string,
): Promise<{ success: boolean; error?: string }> {
  for (const type of ["screen_wake", "unlock"] as const) {
    const jobId = uuidv4();
    const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
      jobId,
      type,
      params: {},
      timeoutMs: RECOVERY_READINESS_TIMEOUT_MS,
    }, {
      boundary: "generated_child",
      rootExternalId: workflowRootExternalId,
      actor: "workflow_runner",
      metadata: { observeSource: "runner.recoveryReplayReadiness", readinessAction: type },
    });
    if (!dispatch.sent) {
      return {
        success: false,
        error: `Recovery readiness ${type} dispatch ${dispatch.decision}${dispatch.reason ? `: ${dispatch.reason}` : ""}`,
      };
    }
    try {
      const result = await waitForResult(jobId, RECOVERY_READINESS_TIMEOUT_MS + 5_000);
      if (!result || result.status !== "completed") {
        return { success: false, error: result?.error || `Recovery readiness ${type} failed` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
  return { success: true };
}

export function reconcileFingerprintWithResolvedState(input: {
  rawFingerprintMatch: boolean;
  enforced: boolean;
  expectedPage: string;
  resolution: StateResolution | null;
}): boolean {
  if (!input.enforced) return input.rawFingerprintMatch;
  if (!input.resolution) return false;
  return input.resolution.stateKey === input.expectedPage && input.resolution.confidence >= 0.85;
}

function recoveryPlatform(workflow: CompiledWorkflow): string {
  const source = `${workflow.appId ?? ""} ${workflow.source ?? ""}`.toLowerCase();
  if (source.includes("reddit")) return "reddit";
  if (source.includes("instagram")) return "instagram";
  if (source.includes("tiktok")) return "tiktok";
  if (source.includes("youtube")) return "youtube";
  if (source.includes("x.com") || source.includes("twitter")) return "twitter";
  return "unknown";
}

function recoveryReason(reason: string): string {
  if (reason.startsWith("fingerprint_mismatch")) return "fingerprint_mismatch";
  if (reason.startsWith("post_action_mismatch")) return "post_action_mismatch";
  if (reason.startsWith("action_failed")) return "action_failed";
  if (reason.startsWith("batch_failed")) return "batch_failed";
  return "deterministic_failure";
}

async function attemptBoundedRecovery(
  ctx: RunnerContext,
  counters: WorkflowExecutionCounters,
  stepIndex: number,
  reason: string
): Promise<{ recovered: boolean; error?: string }> {
  const platform = recoveryPlatform(ctx.workflow);
  const stepAttempts = ctx.recoveryAttemptsByStep?.[stepIndex] ?? 0;

  if (ctx.aiRecoveryEnabled === false) {
    return { recovered: false, error: AI_RECOVERY_DISABLED };
  }

  const perStepBudget = ctx.maxRecoveryAttemptsPerStep ?? DEFAULT_RECOVERY_ATTEMPTS_PER_STEP;
  const totalBudget = ctx.maxTotalRecoveryAttempts ?? MAX_TOTAL_RECOVERY_ATTEMPTS;
  if (stepAttempts >= perStepBudget || ctx.recoveryCount >= totalBudget) {
    counters.recoveryBudgetExhausted++;
    generatedWorkflowRecoveryBudgetExhausted?.labels(platform).inc();
    return { recovered: false, error: RECOVERY_BUDGET_EXCEEDED };
  }

  ctx.recoveryAttemptsByStep ??= {};
  ctx.recoveryAttemptsByStep[stepIndex] = stepAttempts + 1;
  ctx.recoveryCount++;
  counters.recoveryAttempts++;
  counters.recoveryLlmCalls++;
  counters.runtimeLlmCalls++;
  generatedWorkflowRecoveryAttempts?.labels(platform, recoveryReason(reason)).inc();

  workflowEvents.publish({
    source: "workflow_compiler",
    event: "recovery_started",
    workflowId: ctx.workflow.id,
    deviceId: ctx.deviceId,
    currentStep: ctx.stepsCompleted,
    stepIndex,
    totalSteps: ctx.workflow.steps.length,
    details: {
      reason,
      attempt: ctx.recoveryAttemptsByStep[stepIndex],
      recoveryCount: ctx.recoveryCount,
      platform,
    },
  });

  const recovered = await ctx.onRecoveryNeeded(ctx, stepIndex, reason);
  workflowEvents.publish({
    source: "workflow_compiler",
    event: recovered ? "recovery_succeeded" : "recovery_failed",
    workflowId: ctx.workflow.id,
    deviceId: ctx.deviceId,
    currentStep: ctx.stepsCompleted,
    stepIndex,
    totalSteps: ctx.workflow.steps.length,
    status: recovered ? "recovered" : "failed",
    details: {
      reason,
      recovered,
      recoveryCount: ctx.recoveryCount,
      platform,
    },
  });
  return { recovered };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI TREE CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════

async function captureUiTree(deviceId: string, workflowRootExternalId: string, timeoutMs = 10_000): Promise<UiTreeNode[]> {
  const jobId = uuidv4();
  const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
    jobId,
    type: "ui_tree_dump",
    params: {},
    timeoutMs,
  }, {
    boundary: "generated_child",
    rootExternalId: workflowRootExternalId,
    actor: "workflow_runner",
    metadata: { observeSource: "runner.captureUiTree" },
  });

  if (!dispatch.sent) {
    throw new Error(`Device ${deviceId} offline or unreachable`);
  }

  const result = await waitForResult(jobId, timeoutMs);
  if (!result || result.status !== "completed") {
    throw new Error(`UI tree dump failed: ${result?.error || "timeout"}`);
  }

  return normalizeUiTreeOutput(result.output);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINGERPRINT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyFingerprint(
  deviceId: string,
  expectedHash: string,
  workflowRootExternalId: string,
): Promise<{ match: boolean; actualHash: string; uiTree: UiTreeNode[] }> {
  const uiTree = await captureUiTree(deviceId, workflowRootExternalId);
  const actualHash = computePageSignature(uiTree);
  const match = isSamePage(actualHash, expectedHash);

  return { match, actualHash, uiTree };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function executeStepAction(
  deviceId: string,
  step: CompiledStep,
  workflowRootExternalId: string,
  graphTarget?: RunnerResolvedTarget | null,
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!isDeviceOnline(deviceId)) {
    return { success: false, error: `Device ${deviceId} offline` };
  }

  const jobId = uuidv4();

  const dispatchStepJob = async (
    type: Parameters<typeof sendDeviceExecutionJobToDevice>[1]["type"],
    params: Parameters<typeof sendDeviceExecutionJobToDevice>[1]["params"],
    timeoutMs: number,
  ): Promise<boolean> => {
    const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
      jobId,
      type,
      params,
      timeoutMs,
    }, {
      boundary: "generated_child",
      rootExternalId: workflowRootExternalId,
      actor: "workflow_runner",
      metadata: { observeSource: "runner.executeStepAction", stepAction: step.action },
    });
    return dispatch.sent;
  };

  const tryA11ySelector = async (
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; jobId: string; error?: string }> => {
    const attemptJobId = uuidv4();
    const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
      jobId: attemptJobId,
      type: "a11y_find_tap",
      params,
      timeoutMs: STEP_TIMEOUT_MS,
    }, {
      boundary: "generated_child",
      rootExternalId: workflowRootExternalId,
      actor: "workflow_runner",
      metadata: { observeSource: "runner.executeStepAction.a11yCascade", stepAction: step.action },
    });
    if (!dispatch.sent) {
      return {
        success: false,
        jobId: attemptJobId,
        error: `Accessibility dispatch ${dispatch.decision}${dispatch.reason ? `: ${dispatch.reason}` : ""}`,
      };
    }
    try {
      const result = await waitForResult(attemptJobId, STEP_TIMEOUT_MS + 5_000);
      if (!result || result.status !== "completed") {
        return { success: false, jobId: attemptJobId, error: result?.error || "Action timed out or failed" };
      }
      if (result.output?.found !== true) {
        return {
          success: false,
          jobId: attemptJobId,
          error: String(result.output?.error ?? "Accessibility selector was not found"),
        };
      }
      return { success: true, jobId: attemptJobId };
    } catch (error) {
      return { success: false, jobId: attemptJobId, error: (error as Error).message };
    }
  };

  switch (step.action) {
    case "tap": {
      const target = step.target;
      const selectorAttempts: Record<string, unknown>[] = [];
      const selectorKeys = new Set<string>();
      const addSelector = (params: Record<string, unknown> | undefined) => {
        if (!params || Object.keys(params).length === 0) return;
        const key = JSON.stringify(params);
        if (!selectorKeys.has(key)) {
          selectorKeys.add(key);
          selectorAttempts.push(params);
        }
      };

      if (graphTarget?.resolution.found) {
        addSelector(graphTarget.a11yParams);
        if (graphTarget.coords) {
          // Coordinates remain a guarded fallback after semantic selectors.
        }
      }

      // Accessibility descriptors are separate ordered attempts, never one
      // OR/AND query whose semantics depend on the Android agent version.
      if (target?.resourceId) addSelector({ resourceId: target.resourceId });
      if (target?.contentDescription) addSelector({ contentDescription: target.contentDescription });
      if (target?.text) addSelector({ text: target.text, partialMatch: true });
      if (target?.elementId && !target.resourceId && !target.contentDescription && !target.text) {
        addSelector({ text: target.elementId, partialMatch: true });
      }

      let lastSelectorError: string | undefined;
      for (const selector of selectorAttempts) {
        const attempt = await tryA11ySelector(selector);
        if (attempt.success) return attempt;
        lastSelectorError = attempt.error;
      }

      if (selectorAttempts.length > 0 && !graphTarget?.coords && !target?.coords) {
        return { success: false, error: lastSelectorError ?? "Accessibility selector was not found" };
      }

      // Fallback to coordinates only when they are explicitly guarded/resolved.
      const coords = graphTarget?.coords ?? target?.coords;
      const sent = await dispatchStepJob("tap", coords ? { x: coords.x, y: coords.y } : { x: 0.5, y: 0.5 }, STEP_TIMEOUT_MS);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "type": {
      const text = (step.params?.text as string) || "";
      if (step.target?.coords) {
        // Tap first, then type
        const tapJobId = uuidv4();
        await sendDeviceExecutionJobToDevice(deviceId, {
          jobId: tapJobId,
          type: "tap",
          params: { x: step.target.coords.x, y: step.target.coords.y },
          timeoutMs: 5_000,
        }, {
          boundary: "generated_child",
          rootExternalId: workflowRootExternalId,
          actor: "workflow_runner",
          metadata: { observeSource: "runner.typeFocusTap", stepAction: step.action },
        });
        await waitForResult(tapJobId, 5_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      const sent = await dispatchStepJob("type_text", { text }, STEP_TIMEOUT_MS);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "swipe": {
      const direction = (step.params?.direction as string) || "up";
      const distance = (step.params?.distance as number) || 0.3;
      // Convert direction to start/end coords
      const swipeCoords: Record<string, { sx: number; sy: number; ex: number; ey: number }> = {
        up:    { sx: 0.5, sy: 0.7, ex: 0.5, ey: 0.7 - distance },
        down:  { sx: 0.5, sy: 0.3, ex: 0.5, ey: 0.3 + distance },
        left:  { sx: 0.8, sy: 0.5, ex: 0.8 - distance, ey: 0.5 },
        right: { sx: 0.2, sy: 0.5, ex: 0.2 + distance, ey: 0.5 },
      };
      const sc = swipeCoords[direction] || swipeCoords.up;
      const sent = await dispatchStepJob("swipe", { startX: sc.sx, startY: sc.sy, endX: sc.ex, endY: sc.ey }, 5_000);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "press_key": {
      const key = (step.params?.key as string) || "back";
      const sent = await dispatchStepJob("press_key", { key }, 5_000);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "wait": {
      const durationMs = (step.params?.durationMs as number)
        || (step.params?.duration as number)  // legacy fallback
        || 1000;
      await new Promise((r) => setTimeout(r, durationMs));
      return { success: true, jobId: undefined };
    }

    case "open_app": {
      const packageName = (step.params?.packageName as string) || step.target?.text || "";
      const sent = await dispatchStepJob("open_app", { packageName }, STEP_TIMEOUT_MS);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "intent_send": {
      const uri = (step.params?.uri as string) || "";
      const sent = await dispatchStepJob("intent_send", { uri }, STEP_TIMEOUT_MS);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "screenshot": {
      const sent = await dispatchStepJob("screenshot", {}, 10_000);
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    default:
      return { success: false, error: `Unknown action: ${step.action}` };
  }

  try {
    const result = await waitForResult(jobId, STEP_TIMEOUT_MS + 5_000);
    if (!result || result.status !== "completed") {
      return { success: false, jobId, error: result?.error || "Action timed out or failed" };
    }
    return { success: true, jobId };
  } catch (err) {
    return { success: false, jobId, error: (err as Error).message };
  }
}

async function executeDeterministicGraphRecovery(input: {
  deviceId: string;
  workflow: CompiledWorkflow;
  workflowRootExternalId: string;
  step: CompiledStep;
  uiGraph: NonNullable<Awaited<ReturnType<typeof createRunnerUiGraphSession>>>;
  targetPageKey: string;
}): Promise<boolean> {
  const targetState = input.uiGraph.stateByKey(input.targetPageKey);
  if (!targetState) return false;
  const transitions = await uiGraphRepository.loadTransitions(input.workflow.appId);
  if (transitions.length === 0) return false;
  const context = { appId: input.workflow.appId, deviceId: input.deviceId, workflowId: input.workflow.id, stepId: input.step.id };

  const executeTransition = async (transition: UiTransitionDefinition): Promise<{ ok: boolean; error?: string }> => {
    const tree = await captureUiTree(input.deviceId, input.workflowRootExternalId);
    const state = await input.uiGraph.observeState(tree, input.step);
    const actionType = String(transition.action.type ?? transition.action.action ?? "tap");
    const compiledAction = actionType === "tap" || actionType === "open_app" || actionType === "intent_send" || actionType === "press_key" || actionType === "swipe"
      ? actionType
      : null;
    if (!compiledAction) return { ok: false, error: `Unsupported graph transition action: ${actionType}` };
    const target = transition.elementKey ? { elementId: transition.elementKey } : undefined;
    const graphTarget = compiledAction === "tap" ? await input.uiGraph.resolveTarget(tree, { ...input.step, target }, state) : null;
    if (compiledAction === "tap" && (!graphTarget || !graphTarget.resolution.found)) {
      return { ok: false, error: `Graph selector did not resolve ${transition.elementKey ?? "unknown element"}` };
    }
    const targetVariant = targetState.variants[0];
    const syntheticStep: CompiledStep = {
      ...input.step,
      id: `${input.step.id}:graph:${transition.id}`,
      action: compiledAction,
      target,
      params: (transition.action.params as Record<string, unknown> | undefined) ?? transition.action,
      expectedPage: targetState.key,
      expectedPageHash: targetVariant?.signatureHash ?? "",
      retries: 0,
      description: `Graph transition ${transition.key}`,
    };
    const executed = await executeStepAction(input.deviceId, syntheticStep, input.workflowRootExternalId, graphTarget);
    return { ok: executed.success, error: executed.error };
  };

  const engine = new GraphRuntimeEngine(
    input.uiGraph.states,
    transitions,
    context,
    { maxSafetyClass: "navigation", minimumConfidence: 0.7, maxTransitions: 8 },
    {
      captureUiTree: () => captureUiTree(input.deviceId, input.workflowRootExternalId),
      executeTransition,
      saveCheckpoint: (checkpoint) => uiGraphRepository.saveRuntimeCheckpoint({ context, checkpoint, status: "running" }),
    },
    { maxTransitions: 8, maxReplans: 8, maxDurationMs: 60_000 },
  );
  const result = await engine.run(targetState.id);
  await uiGraphRepository.saveRuntimeCheckpoint({ context, checkpoint: result.checkpoint, status: result.status });
  observeUiGraphAction({ appId: input.workflow.appId, path: "graph", outcome: result.ok ? "recovered" : result.status, latencyMs: 0 });
  return result.ok;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-ACTION VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyPostAction(
  deviceId: string,
  workflowId: string,
  step: CompiledStep,
  stepIndex: number
): Promise<{ verified: boolean; actualHash: string }> {
  // Wait for UI to settle
  await new Promise((r) => setTimeout(r, DEFAULT_WAIT_AFTER_ACTION_MS));

  try {
    const { match, actualHash } = await verifyFingerprint(deviceId, step.expectedPageHash, workflowId);
    return { verified: match, actualHash };
  } catch (err) {
    console.warn(`[runner] Post-action fingerprint check failed: ${(err as Error).message}`);
    return { verified: false, actualHash: "" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPILED FAST-PATH BATCHING
// ═══════════════════════════════════════════════════════════════════════════════

function compiledStepToBatchStep(step: CompiledStep, id: number): BatchStep | null {
  if (step.action === "wait") {
    const durationMs = (step.params?.durationMs as number)
      || (step.params?.duration as number)
      || 1000;
    return {
      id,
      type: "wait",
      action: "wait",
      target: null,
      params: { durationMs },
    };
  }

  if (step.action === "tap") {
    const coords = step.target?.coords;
    if (!coords) return null;
    return {
      id,
      type: "action",
      action: "tap",
      target: null,
      params: { x: coords.x, y: coords.y },
    };
  }

  if (step.action === "type") {
    const text = (step.params?.text as string) || "";
    return {
      id,
      type: "action",
      action: "type",
      target: null,
      params: { text },
    };
  }

  if (step.action === "swipe") {
    return {
      id,
      type: "action",
      action: "swipe",
      target: null,
      params: { ...(step.params ?? {}) },
    };
  }

  if (step.action === "open_app") {
    const packageName = (step.params?.packageName as string) || step.target?.text || "";
    if (!packageName) return null;
    return {
      id,
      type: "action",
      action: "open_app",
      target: null,
      params: { packageName },
    };
  }

  return null;
}

function collectCompiledBatch(workflow: CompiledWorkflow, startIndex: number, allowCoordinateTaps = true): {
  steps: CompiledStep[];
  batchSteps: BatchStep[];
} {
  const steps: CompiledStep[] = [];
  const batchSteps: BatchStep[] = [];

  for (let i = startIndex; i < workflow.steps.length; i++) {
    if (!allowCoordinateTaps && workflow.steps[i].action === "tap") break;
    const converted = compiledStepToBatchStep(workflow.steps[i], steps.length + 1);
    if (!converted) break;
    steps.push(workflow.steps[i]);
    batchSteps.push(converted);
  }

  if (batchSteps.length < MIN_COMPILED_BATCH_SIZE) {
    return { steps: [], batchSteps: [] };
  }
  return { steps, batchSteps };
}

async function executeCompiledBatch(
  deviceId: string,
  workflowId: string,
  stepIndex: number,
  steps: BatchStep[]
): Promise<BATCH_RESULT> {
  const batchId = uuidv4();
  const timeoutMs = STEP_TIMEOUT_MS;
  const batchTimeoutMs = timeoutMs * steps.length * 2;
  const batchPayload = {
    type: "BATCH_START",
    batchId,
    workflowId,
    stepIndex,
    steps,
    options: {
      continueOnError: false,
      timeoutMs,
      batchTimeoutMs,
    },
  };

  const result = await sendServerWorkflowBatchChildToDevice(
    deviceId,
    workflowId,
    batchPayload,
    batchTimeoutMs + 30_000,
  );
  return {
    type: "BATCH_RESULT",
    batchId: result.batchId,
    workflowId: result.workflowId,
    status: result.status as BATCH_RESULT["status"],
    results: result.results as BATCH_RESULT["results"],
    executedAt: result.executedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: runCompiledWorkflow
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a compiled workflow deterministically, step by step.
 * On fingerprint mismatch, calls onRecoveryNeeded callback.
 *
 * @returns RunCompiledResult with execution status and per-step results
 */
export async function runCompiledWorkflow(
  req: RunCompiledRequest,
  onRecoveryNeeded: (ctx: RunnerContext, stepIndex: number, reason: string) => Promise<boolean>
): Promise<RunCompiledResult> {
  const startTime = Date.now();
  const { deviceId, workflow, startStepIndex = 0, compileLlmCalls = 0 } = req;
  const workflowRootExternalId = req.workflowRootExternalId ?? workflow.id;
  let rootAdmitted = false;
  let rootFinalized = false;
  const results: StepExecutionResult[] = [];
  const counters: WorkflowExecutionCounters = {
    compileLlmCalls,
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
  };

  if (!isDeviceOnline(deviceId)) {
    workflowEvents.publish({
      source: "workflow_compiler",
      event: "failed",
      workflowId: workflow.id,
      deviceId,
      status: "failed",
      currentStep: 0,
      totalSteps: workflow.steps.length,
      error: `Device ${deviceId} is offline`,
      details: { error: `Device ${deviceId} is offline` },
    });
    return {
      ok: false,
      workflowId: workflow.id,
      status: "failed",
      stepsCompleted: 0,
      stepsTotal: workflow.steps.length,
      recoveryCount: 0,
      counters,
      results: [],
      error: `Device ${deviceId} is offline`,
      totalLatencyMs: Date.now() - startTime,
    };
  }

  const uiGraph = await createRunnerUiGraphSession({ deviceId, workflow }).catch((error) => {
    console.warn(`[ui-graph] runner session disabled after initialization failure: ${(error as Error).message}`);
    return null;
  });

  try {
  // Update status to running
  await deviceExecutionArbiter.observeAdmission({
    deviceId,
    rootKind: "server_workflow",
    externalId: workflowRootExternalId,
    requestKey: workflowRootExternalId,
    actor: "workflow_compiler_runner",
    metadata: { compiledWorkflowId: workflow.id, observeSource: "runner.runCompiledWorkflow" },
  });
  rootAdmitted = true;
  await updateWorkflowStatus(workflow.id, "running");
  workflowEvents.publish({
    source: "workflow_compiler",
    event: "started",
    workflowId: workflow.id,
    deviceId,
    status: "running",
    currentStep: startStepIndex,
    stepIndex: startStepIndex,
    totalSteps: workflow.steps.length,
    details: {
      name: workflow.name,
      appId: workflow.appId,
      startStepIndex,
    },
  });

  const ctx: RunnerContext = {
    deviceId,
    workflowRootExternalId,
    workflow,
    stepsCompleted: 0,
    recoveryCount: 0,
    recoveryAttemptsByStep: {},
    maxRecoveryAttemptsPerStep: Math.max(0, Number(workflow.maxRecoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS_PER_STEP)),
    maxTotalRecoveryAttempts: Math.max(0, Number(workflow.maxTotalRecoveryAttempts ?? MAX_TOTAL_RECOVERY_ATTEMPTS)),
    aiRecoveryEnabled: uiGraph?.enabled ? uiGraph.flags.aiRecovery : true,
    results,
    onRecoveryNeeded,
  };

  let aborted = false;

  let i = startStepIndex;
  while (i < workflow.steps.length) {
    const batch = collectCompiledBatch(workflow, i, !(uiGraph?.enforced && uiGraph.flags.selectorFirst));
    if (batch.batchSteps.length >= MIN_COMPILED_BATCH_SIZE) {
      const batchStart = Date.now();
      console.log(`[runner] Fast-path batch from step ${i}: ${batch.batchSteps.length} deterministic steps`);
      workflowEvents.publish({
        source: "workflow_compiler",
        event: "batch_started",
        workflowId: workflow.id,
        deviceId,
        status: "running",
        currentStep: ctx.stepsCompleted,
        stepIndex: i,
        totalSteps: workflow.steps.length,
        details: {
          batchSize: batch.batchSteps.length,
          stepIds: batch.steps.map((step) => step.id),
        },
      });
      try {
        const batchResult = await executeCompiledBatch(deviceId, workflowRootExternalId, i, batch.batchSteps);
        const firstFailed = batchResult.results.findIndex(
          (r) => r.status === "failed" || r.status === "timeout"
        );
        const successfulCount = firstFailed >= 0 ? firstFailed : batch.steps.length;
        let verifiedSuccessfulCount = successfulCount;
        let batchCompleted = batchResult.status === "completed";

        if (batchCompleted && successfulCount > 0) {
          const lastStepIndex = i + successfulCount - 1;
          const lastStep = batch.steps[successfulCount - 1];
          if (lastStep.expectedPageHash && lastStep.action !== "wait") {
            const postCheck = await verifyPostAction(deviceId, workflowRootExternalId, lastStep, lastStepIndex);
            if (!postCheck.verified) {
              batchCompleted = false;
              verifiedSuccessfulCount = Math.max(0, successfulCount - 1);
              console.warn(
                `[runner] Batch final fingerprint mismatch at step ${lastStepIndex}; ` +
                `falling back to single-step recovery from that step`
              );
            }
          }
        }

        for (let j = 0; j < verifiedSuccessfulCount; j++) {
          const batchedStep = batch.steps[j];
          results.push({
            stepIndex: i + j,
            stepId: batchedStep.id,
            success: true,
            fingerprintMatch: true,
            postActionVerified: true,
            latencyMs: batchResult.results[j]?.durationMs ?? 0,
          });
        }

        counters.deterministicSteps += verifiedSuccessfulCount;
        counters.batchedSteps += verifiedSuccessfulCount;
        ctx.stepsCompleted = i + verifiedSuccessfulCount;

        if (batchCompleted) {
          await updateWorkflowStatus(workflow.id, "running", ctx.stepsCompleted, ctx.recoveryCount);
          workflowEvents.publish({
            source: "workflow_compiler",
            event: "batch_completed",
            workflowId: workflow.id,
            deviceId,
            status: "running",
            currentStep: ctx.stepsCompleted,
            stepIndex: ctx.stepsCompleted,
            totalSteps: workflow.steps.length,
            details: {
              batchSize: verifiedSuccessfulCount,
              latencyMs: Date.now() - batchStart,
            },
          });
          console.log(`[runner] Batch completed ${verifiedSuccessfulCount} steps (${Date.now() - batchStart}ms)`);
          i += verifiedSuccessfulCount;
          continue;
        }

        counters.failedSteps++;
        const localFailedStep = firstFailed >= 0 ? firstFailed + 1 : verifiedSuccessfulCount + 1;
        console.warn(
          `[runner] Batch stopped at local step ${localFailedStep}/${batch.steps.length}; ` +
          `falling back to single-step recovery from global step ${i + verifiedSuccessfulCount}`
        );
        workflowEvents.publish({
          source: "workflow_compiler",
          event: "batch_failed",
          workflowId: workflow.id,
          deviceId,
          status: "running",
          currentStep: ctx.stepsCompleted,
          stepIndex: i + verifiedSuccessfulCount,
          totalSteps: workflow.steps.length,
          details: {
            localFailedStep,
            verifiedSuccessfulCount,
            batchStatus: batchResult.status,
          },
        });
        i += verifiedSuccessfulCount;
      } catch (err) {
        console.warn(`[runner] Batch fast-path failed at step ${i}: ${(err as Error).message}; falling back to single-step execution`);
        workflowEvents.publish({
          source: "workflow_compiler",
          event: "batch_failed",
          workflowId: workflow.id,
          deviceId,
          status: "running",
          currentStep: ctx.stepsCompleted,
          stepIndex: i,
          error: (err as Error).message,
          totalSteps: workflow.steps.length,
          details: { error: (err as Error).message },
        });
      }
    }

    let step = workflow.steps[i];
    const stepStart = Date.now();
    counters.deterministicSteps++;

    console.log(`[runner] Step ${i + 1}/${workflow.steps.length}: ${step.action} — "${step.description}"`);
    workflowEvents.publish({
      source: "workflow_compiler",
      event: "step_started",
      workflowId: workflow.id,
      deviceId,
      status: "running",
      currentStep: ctx.stepsCompleted,
      stepIndex: i,
      stepId: step.id,
      totalSteps: workflow.steps.length,
      details: {
        action: step.action,
        description: step.description,
      },
    });

    // ─── Pre-action fingerprint check (verify we're on expected page) ───────
    let fingerprintMatch = true;
    let preActionUiTree: UiTreeNode[] | null = null;
    let preActionState: StateResolution | null = null;
    if (step.expectedPageHash && step.action !== "open_app" && step.action !== "wait") {
      try {
        const fp = await verifyFingerprint(deviceId, step.expectedPageHash, workflowRootExternalId);
        preActionUiTree = fp.uiTree;
        if (uiGraph?.enabled) {
          preActionState = await uiGraph.observeState(fp.uiTree, step);
        }
        fingerprintMatch = reconcileFingerprintWithResolvedState({
          rawFingerprintMatch: fp.match,
          enforced: Boolean(uiGraph?.enforced),
          expectedPage: step.expectedPage,
          resolution: preActionState,
        });
        if (fingerprintMatch && preActionState && uiGraph?.acceptsExpectedState(step, preActionState)) {
          console.log(`[ui-graph] State Resolver v2 accepted expected state ${step.expectedPage} at confidence=${preActionState.confidence.toFixed(3)}`);
        }
        if (!fingerprintMatch) {
          console.warn(
            `[runner] Pre-action fingerprint mismatch at step ${i}: ` +
            `expected="${step.expectedPageHash}" actual="${fp.actualHash}"`
          );

          let graphRecovered = false;
          if (uiGraph?.enforced && uiGraph.flags.graphRuntime && preActionState?.stateId) {
            graphRecovered = await executeDeterministicGraphRecovery({
              deviceId,
              workflow,
              workflowRootExternalId,
              step,
              uiGraph,
              targetPageKey: step.expectedPage,
            }).catch((error) => {
              console.warn(`[ui-graph] deterministic graph recovery failed: ${(error as Error).message}`);
              return false;
            });
            if (graphRecovered) {
              fingerprintMatch = true;
              preActionUiTree = await captureUiTree(deviceId, workflowRootExternalId);
              preActionState = await uiGraph.observeState(preActionUiTree, step);
              console.log(`[ui-graph] deterministic graph recovery reached ${step.expectedPage} without AI`);
            }
          }

          // Escalate only after the promoted graph cannot recover deterministically.
          let recovery = graphRecovered
            ? { recovered: true as const }
            : await attemptBoundedRecovery(
              ctx,
              counters,
              i,
              `fingerprint_mismatch:expected=${step.expectedPageHash},actual=${fp.actualHash}`
            );
          while (recovery.recovered && !graphRecovered && !fingerprintMatch) {
            step = workflow.steps[i];
            try {
              const replayCheck = await verifyFingerprint(deviceId, step.expectedPageHash, workflowRootExternalId);
              preActionUiTree = replayCheck.uiTree;
              preActionState = uiGraph?.enabled ? await uiGraph.observeState(replayCheck.uiTree, step) : null;
              fingerprintMatch = reconcileFingerprintWithResolvedState({
                rawFingerprintMatch: replayCheck.match,
                enforced: Boolean(uiGraph?.enforced),
                expectedPage: step.expectedPage,
                resolution: preActionState,
              });
              if (fingerprintMatch) break;
              recovery = await attemptBoundedRecovery(
                ctx,
                counters,
                i,
                `fingerprint_mismatch_after_recovery:expected=${step.expectedPageHash},actual=${replayCheck.actualHash}`,
              );
            } catch (error) {
              recovery = await attemptBoundedRecovery(
                ctx,
                counters,
                i,
                `fingerprint_verification_failed_after_recovery:${(error as Error).message}`,
              );
            }
          }
          if (!recovery.recovered || !fingerprintMatch) {
            counters.failedSteps++;
            results.push({
                stepIndex: i,
                stepId: step.id,
                success: false,
                fingerprintMatch: false,
                postActionVerified: false,
                error: recovery.error ?? "Fingerprint mismatch, recovery failed",
                latencyMs: Date.now() - stepStart,
              });
              workflowEvents.publish({
                source: "workflow_compiler",
                event: "step_failed",
                workflowId: workflow.id,
                deviceId,
                status: "failed",
                currentStep: ctx.stepsCompleted,
                stepIndex: i,
                stepId: step.id,
                totalSteps: workflow.steps.length,
                error: recovery.error ?? "Fingerprint mismatch, recovery failed",
                details: { error: recovery.error ?? "Fingerprint mismatch, recovery failed" },
              });
              aborted = true;
              break;
          }
        }
      } catch (err) {
        console.warn(`[runner] Pre-action fingerprint check failed: ${(err as Error).message}`);
        // Continue — not fatal if we can't check
      }
    }

    if (uiGraph?.enabled && step.action === "tap" && !preActionUiTree) {
      try {
        preActionUiTree = await captureUiTree(deviceId, workflowRootExternalId);
        preActionState = await uiGraph.observeState(preActionUiTree, step);
      } catch (error) {
        console.warn(`[ui-graph] pre-action target observation failed: ${(error as Error).message}`);
      }
    }

    let graphTarget: RunnerResolvedTarget | null = null;
    if (uiGraph?.enabled && step.action === "tap" && preActionUiTree && preActionState) {
      graphTarget = await uiGraph.resolveTarget(preActionUiTree, step, preActionState).catch((error) => {
        console.warn(`[ui-graph] target resolution failed: ${(error as Error).message}`);
        return null;
      });
      if (uiGraph.flags.mode === "shadow" && graphTarget) {
        console.log(`[ui-graph] shadow target step=${step.id} found=${graphTarget.resolution.found} method=${graphTarget.resolution.method}`);
      }
    }

    let targetMethod: TargetResolutionMethod = step.action !== "tap"
      ? "direct"
      : graphTarget?.resolution.found
        ? graphTarget.resolution.method
        : step.target?.resourceId ? "resource_id"
          : step.target?.contentDescription ? "content_description"
            : step.target?.text ? "text"
              : step.target?.coords ? "coord_cache"
                : "unknown";

    // ─── Execute action ─────────────────────────────────────────────────────
    let rejectUnguardedCoordinate = Boolean(
      uiGraph?.enforced
      && uiGraph.flags.selectorFirst
      && step.action === "tap"
      && step.target?.coords
      && (!graphTarget || !graphTarget.resolution.found)
    );
    const actionResult = rejectUnguardedCoordinate
      ? { success: false, error: "UI_GRAPH_UNGUARDED_COORDINATE_REJECTED" }
      : await executeStepAction(deviceId, step, workflowRootExternalId, uiGraph?.enforced ? graphTarget : null);
    let actionSucceeded = actionResult.success;
    let actionRecovered = false;
    let actionRetryCount = 0;
    let uiGraphOutcomeRecorded = false;
    const recordUiGraphOutcome = async (success: boolean, reason?: string) => {
      if (!uiGraph?.enabled || uiGraphOutcomeRecorded) return;
      uiGraphOutcomeRecorded = true;
      const latencyMs = Date.now() - stepStart;
      observeUiGraphAction({
        appId: workflow.appId,
        path: targetMethod,
        outcome: success ? (uiGraph.flags.mode === "shadow" ? "shadow" : actionRecovered ? "recovered" : "completed") : "failed",
        latencyMs,
      });
      await uiGraphRepository.recordActionEvent({
        context: { appId: workflow.appId, deviceId, workflowId: workflow.id, stepId: step.id },
        sourceStateId: preActionState?.stateId,
        stateResolutionMethod: preActionState?.method ?? "unknown",
        targetResolutionMethod: targetMethod,
        outcome: success ? (uiGraph.flags.mode === "shadow" ? "shadow" : actionRecovered ? "recovered" : "completed") : "failed",
        latencyMs,
        retryCount: actionRetryCount,
        reason,
        details: { action: step.action, expectedPage: step.expectedPage, selectorFirst: uiGraph.flags.selectorFirst },
      }).catch((error) => console.warn(`[ui-graph] action event persistence failed: ${(error as Error).message}`));
      if (uiGraph.enforced && graphTarget?.resolution.selectorId) {
        await uiGraphRepository.recordSelectorOutcome(graphTarget.resolution.selectorId, success)
          .catch((error) => console.warn(`[ui-graph] selector outcome persistence failed: ${(error as Error).message}`));
      }
    };

    if (!actionSucceeded) {
      console.warn(`[runner] Step ${i} action failed: ${actionResult.error}`);

      // Retry logic
      let retried = false;
      for (let retry = 0; retry < step.retries; retry++) {
        actionRetryCount++;
        counters.retriedSteps++;
        console.log(`[runner] Retry ${retry + 1}/${step.retries} for step ${i}`);
        await new Promise((r) => setTimeout(r, step.retryDelay));
        const retryResult = rejectUnguardedCoordinate
          ? { success: false, error: "UI_GRAPH_UNGUARDED_COORDINATE_REJECTED" }
          : await executeStepAction(deviceId, step, workflowRootExternalId, uiGraph?.enforced ? graphTarget : null);
        if (retryResult.success) {
          retried = true;
          actionSucceeded = true;
          break;
        }
      }

      if (!retried) {
        const graphRecovered = Boolean(
          uiGraph?.enforced
          && uiGraph.flags.graphRuntime
          && await executeDeterministicGraphRecovery({
            deviceId, workflow, workflowRootExternalId, step, uiGraph, targetPageKey: step.expectedPage,
          }).catch((error) => {
            console.warn(`[ui-graph] action-failure graph recovery failed: ${(error as Error).message}`);
            return false;
          })
        );
        // Escalate to AI only when the promoted graph cannot reach the goal.
        let recovery = graphRecovered
          ? { recovered: true as const }
          : await attemptBoundedRecovery(ctx, counters, i, `action_failed:${actionResult.error}`);
        actionRecovered = recovery.recovered;

        // AI recovery prepares the retry (and may replace workflow.steps[i]); it does
        // not itself execute retry_step/retry_with_adaptation. Replay the effective
        // step and only declare recovery successful after a real device result.
        while (recovery.recovered && !graphRecovered) {
          step = workflow.steps[i];
          graphTarget = null;

          const readiness = await ensureDeviceReadyForRecoveryReplay(deviceId, workflowRootExternalId);
          if (!readiness.success) {
            recovery = { recovered: false, error: readiness.error ?? "Recovery replay readiness failed" };
            break;
          }

          if (uiGraph?.enabled && step.action === "tap") {
            try {
              const recoveryTree = await captureUiTree(deviceId, workflowRootExternalId);
              const recoveryState = await uiGraph.observeState(recoveryTree, step);
              graphTarget = await uiGraph.resolveTarget(recoveryTree, step, recoveryState);
            } catch (error) {
              console.warn(`[ui-graph] recovery replay target resolution failed: ${(error as Error).message}`);
            }
          }

          targetMethod = step.action !== "tap"
            ? "direct"
            : graphTarget?.resolution.found
              ? graphTarget.resolution.method
              : step.target?.resourceId ? "resource_id"
                : step.target?.contentDescription ? "content_description"
                  : step.target?.text ? "text"
                    : step.target?.coords ? "coord_cache"
                      : "unknown";
          rejectUnguardedCoordinate = Boolean(
            uiGraph?.enforced
            && uiGraph.flags.selectorFirst
            && step.action === "tap"
            && step.target?.coords
            && (!graphTarget || !graphTarget.resolution.found)
          );

          actionRetryCount++;
          counters.retriedSteps++;
          const replayResult = rejectUnguardedCoordinate
            ? { success: false, error: "UI_GRAPH_UNGUARDED_COORDINATE_REJECTED" }
            : await executeStepAction(deviceId, step, workflowRootExternalId, uiGraph?.enforced ? graphTarget : null);
          actionSucceeded = replayResult.success;
          if (actionSucceeded) break;

          recovery = await attemptBoundedRecovery(
            ctx,
            counters,
            i,
            `action_failed_after_recovery:${replayResult.error}`,
          );
          actionRecovered = actionRecovered || recovery.recovered;
        }

        if (graphRecovered) actionSucceeded = true;
        if (!actionSucceeded) {
          ctx.pendingRecoveryLearning = undefined;
          const failure = recovery.error ?? actionResult.error;
          await recordUiGraphOutcome(false, failure);
          counters.failedSteps++;
          results.push({
            stepIndex: i,
            stepId: step.id,
            success: false,
            fingerprintMatch,
            postActionVerified: false,
            error: failure,
            latencyMs: Date.now() - stepStart,
          });
          workflowEvents.publish({
            source: "workflow_compiler",
            event: "step_failed",
            workflowId: workflow.id,
            deviceId,
            status: "failed",
            currentStep: ctx.stepsCompleted,
            stepIndex: i,
            stepId: step.id,
            totalSteps: workflow.steps.length,
            error: failure,
            details: { error: failure },
          });
          aborted = true;
          break;
        }
      }
    }

    // ─── Post-action verification ───────────────────────────────────────────
    let postActionVerified = true;
    if (step.expectedPageHash && step.action !== "wait") {
      await new Promise((r) => setTimeout(r, DEFAULT_WAIT_AFTER_ACTION_MS));
      let postCheck: { verified: boolean; actualHash: string; uiTree?: UiTreeNode[] };
      try {
        const fp = await verifyFingerprint(deviceId, step.expectedPageHash, workflowRootExternalId);
        postCheck = { verified: fp.match, actualHash: fp.actualHash, uiTree: fp.uiTree };
        if (uiGraph?.enabled) {
          const resolved = await uiGraph.observeState(fp.uiTree, step);
          if (!postCheck.verified && uiGraph.acceptsExpectedState(step, resolved)) postCheck.verified = true;
        }
      } catch (error) {
        console.warn(`[runner] Post-action fingerprint check failed: ${(error as Error).message}`);
        postCheck = { verified: false, actualHash: "" };
      }
      postActionVerified = postCheck.verified;

      if (!postActionVerified) {
        console.warn(
          `[runner] Post-action mismatch at step ${i}: expected="${step.expectedPageHash}" actual="${postCheck.actualHash}"`
        );

        const graphRecovered = Boolean(
          uiGraph?.enforced
          && uiGraph.flags.graphRuntime
          && await executeDeterministicGraphRecovery({
            deviceId, workflow, workflowRootExternalId, step, uiGraph, targetPageKey: step.expectedPage,
          }).catch((error) => {
            console.warn(`[ui-graph] post-action graph recovery failed: ${(error as Error).message}`);
            return false;
          })
        );
        let recovery = graphRecovered
          ? { recovered: true as const }
          : await attemptBoundedRecovery(
            ctx,
            counters,
            i,
            `post_action_mismatch:expected=${step.expectedPageHash},actual=${postCheck.actualHash}`
          );
        while (recovery.recovered && !graphRecovered && !postActionVerified) {
          step = workflow.steps[i];

          const readiness = await ensureDeviceReadyForRecoveryReplay(deviceId, workflowRootExternalId);
          if (!readiness.success) {
            recovery = { recovered: false, error: readiness.error ?? "Recovery replay readiness failed" };
            break;
          }

          let replayGraphTarget: RunnerResolvedTarget | null = null;
          if (uiGraph?.enabled && step.action === "tap") {
            try {
              const recoveryTree = await captureUiTree(deviceId, workflowRootExternalId);
              const recoveryState = await uiGraph.observeState(recoveryTree, step);
              replayGraphTarget = await uiGraph.resolveTarget(recoveryTree, step, recoveryState);
            } catch (error) {
              console.warn(`[ui-graph] post-action recovery target resolution failed: ${(error as Error).message}`);
            }
          }
          const rejectRecoveryCoordinate = Boolean(
            uiGraph?.enforced
            && uiGraph.flags.selectorFirst
            && step.action === "tap"
            && step.target?.coords
            && (!replayGraphTarget || !replayGraphTarget.resolution.found)
          );
          actionRetryCount++;
          counters.retriedSteps++;
          const replayResult = rejectRecoveryCoordinate
            ? { success: false, error: "UI_GRAPH_UNGUARDED_COORDINATE_REJECTED" }
            : await executeStepAction(deviceId, step, workflowRootExternalId, uiGraph?.enforced ? replayGraphTarget : null);
          if (!replayResult.success) {
            recovery = await attemptBoundedRecovery(
              ctx,
              counters,
              i,
              `post_action_replay_failed:${replayResult.error}`,
            );
            continue;
          }

          await new Promise((r) => setTimeout(r, DEFAULT_WAIT_AFTER_ACTION_MS));
          try {
            const replayCheck = await verifyFingerprint(deviceId, step.expectedPageHash, workflowRootExternalId);
            postActionVerified = replayCheck.match;
            if (uiGraph?.enabled) {
              const replayState = await uiGraph.observeState(replayCheck.uiTree, step);
              if (!postActionVerified && uiGraph.acceptsExpectedState(step, replayState)) postActionVerified = true;
            }
            if (postActionVerified) break;
            recovery = await attemptBoundedRecovery(
              ctx,
              counters,
              i,
              `post_action_mismatch_after_recovery:expected=${step.expectedPageHash},actual=${replayCheck.actualHash}`,
            );
          } catch (error) {
            recovery = await attemptBoundedRecovery(
              ctx,
              counters,
              i,
              `post_action_verification_failed_after_recovery:${(error as Error).message}`,
            );
          }
        }
        if (graphRecovered) postActionVerified = true;
        if (postActionVerified) {
          actionRecovered = true;
        } else {
          ctx.pendingRecoveryLearning = undefined;
          await recordUiGraphOutcome(false, recovery.error ?? "Post-action mismatch, recovery failed");
          counters.failedSteps++;
          results.push({
            stepIndex: i,
            stepId: step.id,
            success: false,
            fingerprintMatch,
            postActionVerified: false,
            error: recovery.error ?? "Post-action mismatch, recovery failed",
            latencyMs: Date.now() - stepStart,
          });
          workflowEvents.publish({
            source: "workflow_compiler",
            event: "step_failed",
            workflowId: workflow.id,
            deviceId,
            status: "failed",
            currentStep: ctx.stepsCompleted,
            stepIndex: i,
            stepId: step.id,
            totalSteps: workflow.steps.length,
            error: recovery.error ?? "Post-action mismatch, recovery failed",
            details: { error: recovery.error ?? "Post-action mismatch, recovery failed" },
          });
          aborted = true;
          break;
        }
      }
    }

    await recordUiGraphOutcome(actionSucceeded && postActionVerified, actionSucceeded && postActionVerified ? undefined : actionResult.error);

    // A recovery proposal is only a learning candidate after the adapted
    // action really ran and its postcondition passed. Staging it in the
    // recovery service prevents no-op retry proposals from polluting fast path.
    if (ctx.pendingRecoveryLearning && actionSucceeded && postActionVerified) {
      const candidate = ctx.pendingRecoveryLearning;
      ctx.pendingRecoveryLearning = undefined;
      await uiGraphLearningLoop.observe({
        ...candidate,
        evidence: { ...(candidate.evidence ?? {}), actionExecuted: true, postActionVerified: true },
      }).then(() => observeLearningCandidate(candidate.appId, candidate.type, "observed"))
        .catch((error) => console.warn(`[ui-graph] verified recovery learning candidate failed: ${(error as Error).message}`));
    }

    // ─── Record result ──────────────────────────────────────────────────────
    results.push({
      stepIndex: i,
      stepId: step.id,
      success: true,
      fingerprintMatch,
      postActionVerified,
      latencyMs: Date.now() - stepStart,
    });

    ctx.stepsCompleted = i + 1;

    // Update DB progress
    await updateWorkflowStatus(workflow.id, "running", ctx.stepsCompleted, ctx.recoveryCount);
    workflowEvents.publish({
      source: "workflow_compiler",
      event: "step_completed",
      workflowId: workflow.id,
      deviceId,
      status: "running",
      currentStep: ctx.stepsCompleted,
      stepIndex: i,
      stepId: step.id,
      totalSteps: workflow.steps.length,
      details: {
        stepsCompleted: ctx.stepsCompleted,
        fingerprintMatch,
        postActionVerified,
        latencyMs: Date.now() - stepStart,
      },
    });

    console.log(`[runner] Step ${i + 1} completed (${Date.now() - stepStart}ms)`);
    i++;
  }

  // ─── Finalize ─────────────────────────────────────────────────────────────
  const finalStatus = aborted ? "failed" : "completed";
  const totalLatencyMs = Date.now() - startTime;

  await updateWorkflowStatus(workflow.id, finalStatus, ctx.stepsCompleted, ctx.recoveryCount, {
    totalLatencyMs,
    counters,
    results: results.map((r) => ({
      step: r.stepId,
      ok: r.success,
      latency: r.latencyMs,
      fpMatch: r.fingerprintMatch,
      verified: r.postActionVerified,
      error: r.error,
    })),
  });
  const rootFinish = await deviceExecutionArbiter.finishServerWorkflowRoot({
    deviceId,
    workflowId: workflowRootExternalId,
    status: aborted ? "failed" : "completed",
    actor: "workflow_compiler_runner",
    reason: aborted ? "compiled_workflow_aborted" : "compiled_workflow_completed",
  });
  if (rootFinish.decision !== "terminal") {
    throw new Error(`Failed to finalize compiled workflow root: ${rootFinish.reason ?? rootFinish.decision}`);
  }
  rootFinalized = true;

  console.log(
    `[runner] Workflow "${workflow.name}" ${finalStatus}: ` +
    `${ctx.stepsCompleted}/${workflow.steps.length} steps, ` +
    `${ctx.recoveryCount} recoveries, ${totalLatencyMs}ms`
  );
  workflowEvents.publish({
    source: "workflow_compiler",
    event: finalStatus === "completed" ? "completed" : "failed",
    workflowId: workflow.id,
    deviceId,
    status: finalStatus,
    currentStep: ctx.stepsCompleted,
    stepIndex: ctx.stepsCompleted,
    totalSteps: workflow.steps.length,
    error: aborted ? "Workflow aborted — see step results" : undefined,
    details: {
      stepsCompleted: ctx.stepsCompleted,
      recoveryCount: ctx.recoveryCount,
      totalLatencyMs,
      counters,
      error: aborted ? "Workflow aborted — see step results" : undefined,
    },
  });

  return {
    ok: !aborted,
    workflowId: workflow.id,
    status: finalStatus as "completed" | "failed" | "aborted",
    stepsCompleted: ctx.stepsCompleted,
    stepsTotal: workflow.steps.length,
    recoveryCount: ctx.recoveryCount,
    counters,
    results,
    error: aborted ? "Workflow aborted — see step results" : undefined,
    totalLatencyMs,
  };
  } catch (err) {
    if (rootAdmitted && !rootFinalized) {
      try {
        const failed = await deviceExecutionArbiter.finishServerWorkflowRoot({
          deviceId,
          workflowId: workflowRootExternalId,
          status: "failed",
          actor: "workflow_compiler_runner.exception",
          reason: "compiled_workflow_unexpected_exception",
          metadata: { error: (err as Error).message },
        });
        if (failed.decision !== "terminal") {
          await deviceExecutionArbiter.markAmbiguous({
            deviceId,
            rootKind: "server_workflow",
            externalId: workflowRootExternalId,
            reason: "compiled_workflow_exception_terminalization_rejected",
            actor: "workflow_compiler_runner.exception",
            state: "blocked",
            metadata: { error: (err as Error).message, finishReason: failed.reason ?? failed.decision },
          });
        }
      } catch (transitionError) {
        await deviceExecutionArbiter.markAmbiguous({
          deviceId,
          rootKind: "server_workflow",
          externalId: workflowRootExternalId,
          reason: "compiled_workflow_exception_terminalization_failed",
          actor: "workflow_compiler_runner.exception",
          state: "blocked",
          metadata: {
            error: (err as Error).message,
            transitionError: (transitionError as Error).message,
          },
        }).catch((ambiguityError) => {
          console.error("[runner] Failed to block workflow root after unexpected exception:", (ambiguityError as Error).message);
        });
      }
    }
    throw err;
  }
}
