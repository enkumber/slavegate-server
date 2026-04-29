/**
 * workflow-dispatch.service.ts
 * Shared service for workflow dispatch, cancellation, rate limiting, and decisions.
 */

import { sendJobToDevice, isDeviceOnline } from "../../transport/transport";
import { dispatcherService } from "../dispatcher/dispatcher.service";

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
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of deviceDispatchTimes) {
    const filtered = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (filtered.length === 0) deviceDispatchTimes.delete(key);
    else deviceDispatchTimes.set(key, filtered);
  }
}, 300_000);

// ── Active workflow tracking (for cancellation) ────────────────────────────
interface ActiveWorkflow {
  jobId: string;
  deviceId: string;
  workflowName: string;
  dispatchedAt: number;
  status: "dispatched" | "cancelled";
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

  // Dispatch via dispatcher service (creates DB record + sends to device)
  const job = await dispatcherService.dispatch({
    deviceId,
    type: "workflow_execute" as any,
    params: { workflow },
    timeoutMs,
  });

  // Track
  activeWorkflows.set(job.jobId, {
    jobId: job.jobId,
    deviceId,
    workflowName: workflow.name,
    dispatchedAt: Date.now(),
    status: "dispatched",
  });

  // Auto-cleanup after timeout
  setTimeout(() => activeWorkflows.delete(job.jobId), timeoutMs + 30_000);

  return { jobId: job.jobId, workflowName: workflow.name, status: "dispatched" };
}

// ── Cancellation ────────────────────────────────────────────────────────────
export async function cancelWorkflow(jobId: string) {
  const entry = activeWorkflows.get(jobId);
  if (!entry) {
    throw Object.assign(new Error("Workflow job not found"), { code: "NOT_FOUND" });
  }
  if (entry.status === "cancelled") {
    throw Object.assign(new Error("Workflow already cancelled"), { code: "ALREADY_CANCELLED" });
  }

  // Notify device to cancel (use dedicated cancel signal)
  if (isDeviceOnline(entry.deviceId)) {
    sendJobToDevice(entry.deviceId, {
      jobId,
      type: "cancel_workflow" as any,
      params: { reason: "cancelled_by_user" },
      timeoutMs: 5000,
    });
  }

  activeWorkflows.delete(jobId);

  console.log(`[workflow-dispatch] Cancelled job ${jobId} (${entry.workflowName})`);
  return { jobId, status: "cancelled" };
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
