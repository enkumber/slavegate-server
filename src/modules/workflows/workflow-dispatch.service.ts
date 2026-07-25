/**
 * workflow-dispatch.service.ts
 * Shared service for workflow dispatch, cancellation, rate limiting, and decisions.
 */

import { sendDeviceExecutionJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { deviceExecutionArbiter } from "../device-execution";

// ── Pre-workflow steps (sent as individual jobs before workflow) ────────────
// Device-side workflow executor may not handle these correctly,
// so we extract them and send via the proven individual job path.
const PRE_WORKFLOW_TYPES = new Set(["screen_wake", "unlock"]);

async function runPreWorkflowSteps(
  deviceId: string,
  steps: any[],
  workflowRootId: string,
): Promise<{ remaining: any[]; preResults: Record<string, any> }> {
  const preResults: Record<string, any> = {};
  const remaining: any[] = [];
  let extracting = true;

  for (const step of steps) {
    if (extracting && PRE_WORKFLOW_TYPES.has(step.type)) {
      // Send as individual job (works reliably)
      const { jobId } = await dispatcherService.dispatch({
        deviceId,
        type: step.type as any,
        params: step.params ?? step,
        timeoutMs: 15_000,
        workflowId: workflowRootId,
      });
      const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
        jobId,
        type: step.type as any,
        params: step.params ?? {},
        timeoutMs: 15_000,
      }, {
        boundary: "prestep_child",
        rootExternalId: workflowRootId,
        actor: "workflow_dispatch",
        metadata: { observeSource: "workflowDispatch.preWorkflowStep", workflowStepType: step.type },
      });

      if (dispatch.sent) {
        try {
          const result = await waitForResult(jobId, 15_000);
          preResults[step.id ?? step.type] = result;
          console.log(`[workflow-dispatch] Pre-step ${step.type}: ${result?.success ? "ok" : JSON.stringify(result)?.slice(0, 100)}`);
        } catch (e: any) {
          console.warn(`[workflow-dispatch] Pre-step ${step.type} timed out: ${e.message}`);
          preResults[step.id ?? step.type] = { status: "timeout" };
        }
      } else {
        console.warn(`[workflow-dispatch] Pre-step ${step.type}: device offline`);
        preResults[step.id ?? step.type] = { status: "device_offline" };
      }

      // Insert a wait step after unlock for the device to settle
      if (step.type === "unlock") {
        await new Promise((r) => setTimeout(r, 1500));
      }
    } else {
      extracting = false;
      remaining.push(step);
    }
  }

  return { remaining, preResults };
}

// ── Rate limiter (in-memory, per-device) ────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const deviceDispatchTimes = new Map<string, number[]>();

function checkRateLimit(deviceId: string): boolean {
  const now = Date.now();
  const times = deviceDispatchTimes.get(deviceId)?.filter((t) => now - t < RATE_WINDOW_MS) ?? [];
  if (times.length >= RATE_MAX) return false;
  times.push(now);
  deviceDispatchTimes.set(deviceId, times);
  return true;
}

// Periodic cleanup of stale rate-limit entries (every 5 min)
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, times] of deviceDispatchTimes) {
    const filtered = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (filtered.length === 0) deviceDispatchTimes.delete(key);
    else deviceDispatchTimes.set(key, filtered);
  }
}, 300_000);
rateCleanupTimer.unref?.();

// ── Active workflow tracking (for cancellation) ────────────────────────────
interface ActiveWorkflow {
  jobId: string;
  deviceId: string;
  workflowRootId: string;
  workflowName: string;
  dispatchedAt: number;
  status: "queued" | "dispatched";
}
const activeWorkflows = new Map<string, ActiveWorkflow>();

// ── Dispatch ────────────────────────────────────────────────────────────────
export interface DispatchParams {
  deviceId: string;
  workflow: { name: string; steps: any[] };
  timeoutMs?: number;
}

export async function dispatchWorkflow(params: DispatchParams) {
  const { deviceId, workflow, timeoutMs = 300_000 } = params;

  // Rate limit
  if (!checkRateLimit(deviceId)) {
    throw Object.assign(new Error("Rate limit exceeded: max 10 workflows/min per device"), {
      code: "RATE_LIMITED",
    });
  }

  // Online check
  if (!isDeviceOnline(deviceId)) {
    throw Object.assign(new Error("Device not connected"), { code: "DEVICE_OFFLINE" });
  }

  console.log(
    `[workflow-dispatch] Dispatching "${workflow.name}" to ${deviceId.slice(0, 8)} (${workflow.steps.length} steps)`,
  );

  // 1. Extract screen_wake + unlock and send as individual jobs
  const workflowRootId = `workflow-dispatch:${deviceId}:${Date.now()}`;
  await deviceExecutionArbiter.observeAdmission({
    deviceId,
    rootKind: "server_workflow",
    externalId: workflowRootId,
    requestKey: workflowRootId,
    actor: "workflow_dispatch",
    metadata: { workflowName: workflow.name, observeSource: "workflowDispatch.dispatchWorkflow" },
  });
  const { remaining, preResults } = await runPreWorkflowSteps(deviceId, workflow.steps, workflowRootId);

  if (remaining.length === 0) {
    // All steps were pre-workflow, nothing left to send as workflow
    console.log(`[workflow-dispatch] All steps handled as pre-workflow jobs`);
    const finished = await deviceExecutionArbiter.finishServerWorkflowRoot({
      deviceId,
      workflowId: workflowRootId,
      successful: true,
      actor: "workflow_dispatch",
      reason: "all_preworkflow_steps_finished",
      metadata: { workflowName: workflow.name, preStepCount: workflow.steps.length },
    });
    if (finished.decision !== "terminal") {
      throw new Error(`Failed to finish all-presteps workflow root: ${finished.reason ?? finished.decision}`);
    }
    const jobId = `pre-${Date.now()}`;
    return { jobId, workflowName: workflow.name, status: "completed", preResults };
  }

  // 2. Create DB record for the remaining workflow steps
  const workflowWithRemaining = { ...workflow, steps: remaining };
  const job = await dispatcherService.dispatch({
    deviceId,
    type: "workflow_execute" as any,
    params: { workflow: workflowWithRemaining },
    timeoutMs,
    workflowId: workflowRootId,
  });

  // 3. Send remaining workflow to device via WebSocket
  const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
    jobId: job.jobId,
    type: "workflow_execute" as any,
    params: { workflow: workflowWithRemaining },
    timeoutMs,
  }, {
    boundary: "server_workflow_root",
    rootExternalId: workflowRootId,
    actor: "workflow_dispatch",
    metadata: {
      observeSource: "workflowDispatch.dispatchWorkflow",
      workflowName: workflow.name,
      workflowStepCount: remaining.length,
    },
  });

  const status = dispatch.sent ? "dispatched" : dispatch.decision === "would_wait" ? "queued" : null;
  if (!status) {
    throw Object.assign(
      new Error(`Workflow dispatch failed (${dispatch.decision}${dispatch.reason ? `: ${dispatch.reason}` : ""})`),
      { code: "WORKFLOW_DISPATCH_FAILED" },
    );
  }
  if (status === "queued") {
    console.log(`[workflow-dispatch] Queued job ${job.jobId} behind the active device root`);
  }

  // Track
  activeWorkflows.set(job.jobId, {
    jobId: job.jobId,
    deviceId,
    workflowRootId,
    workflowName: workflow.name,
    dispatchedAt: Date.now(),
    status,
  });

  // Auto-cleanup after timeout
  const cleanupTimer = setTimeout(() => activeWorkflows.delete(job.jobId), timeoutMs + 30_000);
  cleanupTimer.unref?.();

  return { jobId: job.jobId, workflowName: workflow.name, status };
}

// ── Cancellation ────────────────────────────────────────────────────────────
export async function cancelWorkflow(jobId: string) {
  const entry = activeWorkflows.get(jobId);
  if (!entry) {
    throw Object.assign(new Error("Workflow job not found"), { code: "NOT_FOUND" });
  }
  const cancelled = await deviceExecutionArbiter.cancelQueuedServerWorkflowRoot({
    deviceId: entry.deviceId,
    workflowId: entry.workflowRootId,
    actor: "workflow_dispatch.cancel",
    reason: "api_cancelled_before_dispatch",
    metadata: { jobId, workflowName: entry.workflowName },
  });

  if (cancelled.decision === "terminal") {
    activeWorkflows.delete(jobId);
    console.log(`[workflow-dispatch] Cancelled queued job ${jobId} (${entry.workflowName})`);
    return { jobId, status: "cancelled" };
  }

  if (cancelled.reason === "root_not_queued") {
    // The queue pump may have dispatched after the original API response. Do
    // not send WORKFLOW_CANCEL: workflow_execute is a JOB wire operation and
    // that signal would falsely claim cancellation while releasing ownership.
    entry.status = "dispatched";
    await deviceExecutionArbiter.recordRejectedEgress({
      deviceId: entry.deviceId,
      operationId: jobId,
      wireType: "WORKFLOW_CANCEL",
      actor: "workflow_dispatch.cancel",
      reason: "workflow_execute_inflight_cancellation_unsupported",
      metadata: { workflowRootId: entry.workflowRootId, workflowName: entry.workflowName },
    });
    throw Object.assign(
      new Error("Cancellation is unsupported after workflow dispatch; execution ownership remains active"),
      { code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT", status: 409 },
    );
  }

  throw Object.assign(
    new Error(`Workflow cancellation failed (${cancelled.reason ?? cancelled.decision})`),
    { code: cancelled.decision === "missing" ? "NOT_FOUND" : "CANCELLATION_REJECTED" },
  );
}

// ── Generic decide ──────────────────────────────────────────────────────────
export function decide(
  workflowName: string | undefined,
  stepName: string | undefined,
  context: Record<string, any> | undefined,
): { action: string; nextStep?: string; error?: string } {
  const ctx = context ?? {};

  // Common decision patterns based on step type / name
  if (stepName === "open_app_check" || stepName?.endsWith("_check")) {
    // Generic app check: if context has packageName, we assume success
    if (ctx.packageName) return { action: "continue" };
    if (ctx.error) return { action: "retry", error: ctx.error };
    return { action: "wait_retry", error: "App check inconclusive, waiting..." };
  }

  if (stepName === "service_check" || stepName?.includes("service")) {
    if (ctx.hasOkButton || ctx.serviceRunning) return { action: "continue" };
    return { action: "wait_retry", error: "Service not ready, waiting..." };
  }

  if (stepName === "verify_running" || stepName?.startsWith("verify")) {
    if (ctx.running || ctx.success) return { action: "done" };
    return { action: "retry_step", error: "Verification failed", nextStep: stepName };
  }

  // Default: continue if no error
  if (ctx.error) return { action: "error", error: ctx.error };
  console.warn(`[workflow-decide] No pattern matched for step "${stepName}" — defaulting to continue`);
  return { action: "continue" };
}
