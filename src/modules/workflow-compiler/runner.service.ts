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
import { sendBatchToDeviceEnforced, sendDeviceExecutionJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import type { BATCH_RESULT, BatchStep } from "../../protocol/batch-types";
import { computePageSignature, isSamePage } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import {
  generatedWorkflowRecoveryAttempts,
  generatedWorkflowRecoveryBudgetExhausted,
} from "../observability/metrics";
import { workflowEvents } from "../workflow-events";

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
  workflow: CompiledWorkflow;
  stepsCompleted: number;
  recoveryCount: number;
  recoveryAttemptsByStep?: Record<number, number>;
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
export const RECOVERY_BUDGET_EXCEEDED = "RECOVERY_BUDGET_EXCEEDED";

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

  if (stepAttempts >= DEFAULT_RECOVERY_ATTEMPTS_PER_STEP || ctx.recoveryCount >= MAX_TOTAL_RECOVERY_ATTEMPTS) {
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

async function captureUiTree(deviceId: string, timeoutMs = 10_000): Promise<UiTreeNode[]> {
  const jobId = uuidv4();
  const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
    jobId,
    type: "ui_tree_dump",
    params: {},
    timeoutMs,
  }, {
    boundary: "generated_child",
    rootKind: "job",
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

  // UI tree is in result.output.tree or result.output
  const tree = result.output?.tree || result.output;
  return Array.isArray(tree) ? tree : [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINGERPRINT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyFingerprint(
  deviceId: string,
  expectedHash: string
): Promise<{ match: boolean; actualHash: string; uiTree: UiTreeNode[] }> {
  const uiTree = await captureUiTree(deviceId);
  const actualHash = computePageSignature(uiTree);
  const match = isSamePage(actualHash, expectedHash);

  return { match, actualHash, uiTree };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function executeStepAction(
  deviceId: string,
  step: CompiledStep
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
      rootKind: "job",
      actor: "workflow_runner",
      metadata: { observeSource: "runner.executeStepAction", stepAction: step.action },
    });
    return dispatch.sent;
  };

  switch (step.action) {
    case "tap": {
      const target = step.target;
      // If element has identifying info, use a11y targeting cascade
      if (target?.elementId || target?.resourceId || target?.text) {
        const a11yParams: Record<string, unknown> = {};
        if (target.resourceId) a11yParams.resourceId = target.resourceId;
        if (target.text) { a11yParams.text = target.text; a11yParams.partialMatch = true; }
        // elementId is app-map internal — pass as text fallback for a11y search
        if (target.elementId && !target.resourceId && !target.text) {
          a11yParams.text = target.elementId;
          a11yParams.partialMatch = true;
        }
        const sent = await dispatchStepJob("a11y_find_tap", a11yParams, STEP_TIMEOUT_MS);
        if (!sent) return { success: false, error: "Device unreachable" };
        break;
      }
      // Fallback to coords
      const coords = target?.coords;
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
          rootKind: "job",
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
    const { match, actualHash } = await verifyFingerprint(deviceId, step.expectedPageHash);
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

function collectCompiledBatch(workflow: CompiledWorkflow, startIndex: number): {
  steps: CompiledStep[];
  batchSteps: BatchStep[];
} {
  const steps: CompiledStep[] = [];
  const batchSteps: BatchStep[] = [];

  for (let i = startIndex; i < workflow.steps.length; i++) {
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

  const result = await sendBatchToDeviceEnforced(deviceId, batchPayload, batchTimeoutMs + 30_000);
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

  // Update status to running
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
    workflow,
    stepsCompleted: 0,
    recoveryCount: 0,
    recoveryAttemptsByStep: {},
    results,
    onRecoveryNeeded,
  };

  let aborted = false;

  let i = startStepIndex;
  while (i < workflow.steps.length) {
    const batch = collectCompiledBatch(workflow, i);
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
        const batchResult = await executeCompiledBatch(deviceId, workflow.id, i, batch.batchSteps);
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
            const postCheck = await verifyPostAction(deviceId, workflow.id, lastStep, lastStepIndex);
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

    const step = workflow.steps[i];
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
    if (step.expectedPageHash && step.action !== "open_app" && step.action !== "wait") {
      try {
        const fp = await verifyFingerprint(deviceId, step.expectedPageHash);
        fingerprintMatch = fp.match;
        if (!fingerprintMatch) {
          console.warn(
            `[runner] Pre-action fingerprint mismatch at step ${i}: ` +
            `expected="${step.expectedPageHash}" actual="${fp.actualHash}"`
          );

          // Attempt recovery
          const recovery = await attemptBoundedRecovery(
            ctx,
            counters,
            i,
            `fingerprint_mismatch:expected=${step.expectedPageHash},actual=${fp.actualHash}`
          );
          if (!recovery.recovered) {
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

    // ─── Execute action ─────────────────────────────────────────────────────
    const actionResult = await executeStepAction(deviceId, step);

    if (!actionResult.success) {
      console.warn(`[runner] Step ${i} action failed: ${actionResult.error}`);

      // Retry logic
      let retried = false;
      for (let retry = 0; retry < step.retries; retry++) {
        counters.retriedSteps++;
        console.log(`[runner] Retry ${retry + 1}/${step.retries} for step ${i}`);
        await new Promise((r) => setTimeout(r, step.retryDelay));
        const retryResult = await executeStepAction(deviceId, step);
        if (retryResult.success) {
          retried = true;
          break;
        }
      }

      if (!retried) {
        // Attempt recovery
        const recovery = await attemptBoundedRecovery(ctx, counters, i, `action_failed:${actionResult.error}`);
        if (!recovery.recovered) {
            counters.failedSteps++;
            results.push({
              stepIndex: i,
              stepId: step.id,
              success: false,
              fingerprintMatch,
              postActionVerified: false,
              error: recovery.error ?? actionResult.error,
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
              error: recovery.error ?? actionResult.error,
              details: { error: recovery.error ?? actionResult.error },
            });
            aborted = true;
            break;
        }
      }
    }

    // ─── Post-action verification ───────────────────────────────────────────
    let postActionVerified = true;
    if (step.expectedPageHash && step.action !== "wait") {
      const postCheck = await verifyPostAction(deviceId, workflow.id, step, i);
      postActionVerified = postCheck.verified;

      if (!postActionVerified) {
        console.warn(
          `[runner] Post-action mismatch at step ${i}: expected="${step.expectedPageHash}" actual="${postCheck.actualHash}"`
        );

        const recovery = await attemptBoundedRecovery(
          ctx,
          counters,
          i,
          `post_action_mismatch:expected=${step.expectedPageHash},actual=${postCheck.actualHash}`
        );
        if (recovery.recovered) {
          postActionVerified = true; // Recovery fixed it
        } else {
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
}
