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
import { sendJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import { computePageSignature, isSamePage } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";

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
}

export interface RunnerContext {
  deviceId: string;
  workflow: CompiledWorkflow;
  stepsCompleted: number;
  recoveryCount: number;
  results: StepExecutionResult[];
  /** Callback for recovery — injected to avoid circular deps */
  onRecoveryNeeded: (ctx: RunnerContext, stepIndex: number, reason: string) => Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════

const STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_AFTER_ACTION_MS = 800;

// ═══════════════════════════════════════════════════════════════════════════════
// UI TREE CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════

async function captureUiTree(deviceId: string, timeoutMs = 10_000): Promise<UiTreeNode[]> {
  const jobId = uuidv4();
  const sent = sendJobToDevice(deviceId, {
    jobId,
    type: "ui_tree_dump",
    params: {},
    timeoutMs,
  });

  if (!sent) {
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
        const sent = sendJobToDevice(deviceId, {
          jobId,
          type: "a11y_find_tap",
          params: a11yParams,
          timeoutMs: STEP_TIMEOUT_MS,
        });
        if (!sent) return { success: false, error: "Device unreachable" };
        break;
      }
      // Fallback to coords
      const coords = target?.coords;
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "tap",
        params: coords ? { x: coords.x, y: coords.y } : { x: 0.5, y: 0.5 },
        timeoutMs: STEP_TIMEOUT_MS,
      });
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "type": {
      const text = (step.params?.text as string) || "";
      if (step.target?.coords) {
        // Tap first, then type
        const tapJobId = uuidv4();
        sendJobToDevice(deviceId, {
          jobId: tapJobId,
          type: "tap",
          params: { x: step.target.coords.x, y: step.target.coords.y },
          timeoutMs: 5_000,
        });
        await waitForResult(tapJobId, 5_000).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "type_text",
        params: { text },
        timeoutMs: STEP_TIMEOUT_MS,
      });
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
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "swipe",
        params: { startX: sc.sx, startY: sc.sy, endX: sc.ex, endY: sc.ey },
        timeoutMs: 5_000,
      });
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "press_key": {
      const key = (step.params?.key as string) || "back";
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "press_key",
        params: { key },
        timeoutMs: 5_000,
      });
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
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "open_app",
        params: { packageName },
        timeoutMs: STEP_TIMEOUT_MS,
      });
      if (!sent) return { success: false, error: "Device unreachable" };
      break;
    }

    case "screenshot": {
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: "screenshot",
        params: {},
        timeoutMs: 10_000,
      });
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
  const MAX_TOTAL_RECOVERY = 10;
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
  };

  if (!isDeviceOnline(deviceId)) {
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

  const ctx: RunnerContext = {
    deviceId,
    workflow,
    stepsCompleted: 0,
    recoveryCount: 0,
    results,
    onRecoveryNeeded,
  };

  let aborted = false;

  for (let i = startStepIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepStart = Date.now();
    counters.deterministicSteps++;

    console.log(`[runner] Step ${i + 1}/${workflow.steps.length}: ${step.action} — "${step.description}"`);

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
          if (ctx.recoveryCount < MAX_TOTAL_RECOVERY) {
            counters.recoveryLlmCalls++;
            counters.runtimeLlmCalls++;
            const recovered = await onRecoveryNeeded(ctx, i, `fingerprint_mismatch:expected=${step.expectedPageHash},actual=${fp.actualHash}`);
            ctx.recoveryCount++;
            if (!recovered) {
              counters.failedSteps++;
              results.push({
                stepIndex: i,
                stepId: step.id,
                success: false,
                fingerprintMatch: false,
                postActionVerified: false,
                error: "Fingerprint mismatch, recovery failed",
                latencyMs: Date.now() - stepStart,
              });
              aborted = true;
              break;
            }
          } else {
            counters.failedSteps++;
            results.push({
              stepIndex: i,
              stepId: step.id,
              success: false,
              fingerprintMatch: false,
              postActionVerified: false,
              error: "Max total recovery attempts reached",
              latencyMs: Date.now() - stepStart,
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
        if (ctx.recoveryCount < MAX_TOTAL_RECOVERY) {
          counters.recoveryLlmCalls++;
          counters.runtimeLlmCalls++;
          const recovered = await onRecoveryNeeded(ctx, i, `action_failed:${actionResult.error}`);
          ctx.recoveryCount++;
          if (!recovered) {
            counters.failedSteps++;
            results.push({
              stepIndex: i,
              stepId: step.id,
              success: false,
              fingerprintMatch,
              postActionVerified: false,
              error: actionResult.error,
              latencyMs: Date.now() - stepStart,
            });
            aborted = true;
            break;
          }
        } else {
          counters.failedSteps++;
          results.push({
            stepIndex: i,
            stepId: step.id,
            success: false,
            fingerprintMatch,
            postActionVerified: false,
            error: `Action failed, max recovery reached: ${actionResult.error}`,
            latencyMs: Date.now() - stepStart,
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

        if (ctx.recoveryCount < MAX_TOTAL_RECOVERY) {
          counters.recoveryLlmCalls++;
          counters.runtimeLlmCalls++;
          const recovered = await onRecoveryNeeded(ctx, i, `post_action_mismatch:expected=${step.expectedPageHash},actual=${postCheck.actualHash}`);
          ctx.recoveryCount++;
          if (recovered) {
            postActionVerified = true; // Recovery fixed it
          } else {
            counters.failedSteps++;
          }
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

    console.log(`[runner] Step ${i + 1} completed (${Date.now() - stepStart}ms)`);
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
