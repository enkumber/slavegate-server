import { workflowEvents } from "../workflow-events";
import { workflowService } from "./workflow.service";
import type { WorkflowStep, WorkflowTemplate } from "./types";
import { getResourceLifecycleExecutionStatusContract } from "../lifecycle/lifecycle.service";

const EDGE_WORKFLOW_ACK_TIMEOUT_MS = Number(process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS ?? 20_000);
const EDGE_WORKFLOW_ACK_TIMEOUT_ERROR = "Edge workflow did not acknowledge WORKFLOW_START";
const EDGE_WORKFLOW_PROGRESS_SWEEP_MS = Number(process.env.EDGE_WORKFLOW_PROGRESS_SWEEP_MS ?? 30_000);
const EDGE_WORKFLOW_PROGRESS_GRACE_MS = Number(process.env.EDGE_WORKFLOW_PROGRESS_GRACE_MS ?? 15_000);
const EDGE_WORKFLOW_MIN_STALE_MS = Number(process.env.EDGE_WORKFLOW_MIN_STALE_MS ?? 30_000);
const EDGE_WORKFLOW_MAX_STALE_MS = Number(process.env.EDGE_WORKFLOW_MAX_STALE_MS ?? 660_000);

let progressSweepTimer: NodeJS.Timeout | null = null;

function edgeCheckpointAcknowledged(checkpoint: unknown): boolean {
  return !!checkpoint &&
    typeof checkpoint === "object" &&
    (checkpoint as Record<string, unknown>).source === "edge";
}

function checkpointTimestamp(checkpoint: unknown): string | null {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const value = (checkpoint as Record<string, unknown>).checkpointAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function stepBudgetMs(step: WorkflowStep | undefined): number {
  if (!step) return 15_000;
  if (step.type === "action") return step.timeoutMs ?? 15_000;
  if (step.type === "wait") {
    if (step.until?.timeoutMs) return step.until.timeoutMs;
    if (step.timeoutMs) return step.timeoutMs;
    if (step.duration?.max) return step.duration.max;
  }
  // Conditions/checkpoints are local and loops report progress through their
  // nested actions. Keep a bounded default if no explicit duration exists.
  return 30_000;
}

export function edgeProgressStaleAfterMs(template: WorkflowTemplate | null, currentStep: number): number {
  const budget = stepBudgetMs(template?.steps[currentStep]);
  return Math.min(
    EDGE_WORKFLOW_MAX_STALE_MS,
    Math.max(EDGE_WORKFLOW_MIN_STALE_MS, budget + EDGE_WORKFLOW_PROGRESS_GRACE_MS),
  );
}

export async function sweepStaleEdgeWorkflows(nowMs = Date.now()): Promise<{ checked: number; failed: number }> {
  const running = await workflowService.listActive(1, 500);
  const lifecycleStatusContract = await getResourceLifecycleExecutionStatusContract("workflows");
  let checked = 0;
  let failed = 0;

  for (const workflow of running.items) {
    if (!workflow.deviceId || !edgeCheckpointAcknowledged(workflow.checkpoint)) continue;
    const checkpointAt = checkpointTimestamp(workflow.checkpoint);
    if (!checkpointAt) continue;
    checked += 1;

    const template = workflow.templateId ? await workflowService.getTemplate(workflow.templateId) : null;
    const staleAfterMs = edgeProgressStaleAfterMs(template, workflow.currentStep);
    const ageMs = nowMs - Date.parse(checkpointAt);
    if (ageMs <= staleAfterMs) continue;

    const error = `Edge workflow made no progress for ${ageMs}ms (deadline ${staleAfterMs}ms)`;
    const terminalized = await workflowService.markFailedIfEdgeProgressStale(
      workflow.id,
      checkpointAt,
      error,
    );
    if (!terminalized) continue;

    failed += 1;
    // Cancellation is a control-plane message and may bypass the work queue.
    // The DB CAS above releases scheduling immediately; the wire cancel clears
    // the matching local engine run without restarting the phone.
    // Load lazily: transport imports this lifecycle module for replay handling.
    // A static import here would create a circular module initialization path.
    const { sendWorkflowCancellationControl } = await import("../../transport/transport");
    const cancelSent = await sendWorkflowCancellationControl(workflow.deviceId, workflow.id)
      .catch((err) => {
        console.error(`[edge-watchdog] Cancel send failed for ${workflow.id}: ${(err as Error).message}`);
        return false;
      });
    workflowEvents.publish({
      source: "workflow_executor",
      event: "failed",
      workflowId: workflow.id,
      deviceId: workflow.deviceId,
      mode: "edge",
      status: lifecycleStatusContract.failed,
      currentStep: workflow.currentStep,
      error,
      details: { reason: "edge_progress_timeout", checkpointAt, ageMs, staleAfterMs, cancelSent },
    });
    console.warn(`[edge-watchdog] Failed stale workflow ${workflow.id} at step ${workflow.currentStep}; cancelSent=${cancelSent}`);
  }

  return { checked, failed };
}

export function startEdgeWorkflowProgressWatchdog(): NodeJS.Timeout {
  if (progressSweepTimer) return progressSweepTimer;
  progressSweepTimer = setInterval(() => {
    sweepStaleEdgeWorkflows().catch((err) =>
      console.error(`[edge-watchdog] Progress sweep failed: ${(err as Error).message}`),
    );
  }, EDGE_WORKFLOW_PROGRESS_SWEEP_MS);
  progressSweepTimer.unref?.();
  void sweepStaleEdgeWorkflows().catch((err) =>
    console.error(`[edge-watchdog] Startup progress sweep failed: ${(err as Error).message}`),
  );
  return progressSweepTimer;
}

export function scheduleEdgeWorkflowAckWatchdog(
  workflowId: string,
  deviceId: string,
  logPrefix: string,
): void {
  const timeout = setTimeout(async () => {
    try {
      const latest = await workflowService.get(workflowId);
      if (!latest || latest.lifecycleTerminal === true || latest.currentStep !== 0) return;
      if (edgeCheckpointAcknowledged(latest.checkpoint)) return;

      const failed = await workflowService.markFailedIfEdgeStartUnacknowledged(
        workflowId,
        `${EDGE_WORKFLOW_ACK_TIMEOUT_ERROR} within ${EDGE_WORKFLOW_ACK_TIMEOUT_MS}ms`,
      );
      if (!failed) return;
      workflowEvents.publish({
        source: "workflow_executor",
        event: "failed",
        workflowId,
        deviceId,
        mode: "edge",
        status: (await getResourceLifecycleExecutionStatusContract("workflows")).failed,
        currentStep: 0,
        error: EDGE_WORKFLOW_ACK_TIMEOUT_ERROR,
        details: {
          reason: "edge_ack_timeout",
          timeoutMs: EDGE_WORKFLOW_ACK_TIMEOUT_MS,
        },
      });
      console.warn(`[${logPrefix}] Edge workflow ${workflowId} on ${deviceId.slice(0, 8)} did not acknowledge start within ${EDGE_WORKFLOW_ACK_TIMEOUT_MS}ms`);
    } catch (err) {
      console.error(`[${logPrefix}] Edge workflow ack watchdog failed for ${workflowId}: ${(err as Error).message}`);
    }
  }, EDGE_WORKFLOW_ACK_TIMEOUT_MS);
  timeout.unref?.();
}

export async function promoteReplayedEdgeWorkflowToRunning(input: {
  workflowId: string;
  deviceId: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  actor: string;
}): Promise<void> {
  const { workflowId, deviceId, templateId, variables, actor } = input;
  let started = false;
  try {
    started = await workflowService.markRunning(workflowId);
    if (!started) {
      const latest = await workflowService.get(workflowId);
      if (!latest || latest.lifecycleTerminal === true) return;
      if (edgeCheckpointAcknowledged(latest.checkpoint)) return;
    }

    scheduleEdgeWorkflowAckWatchdog(workflowId, deviceId, actor);
    const context = variables?.controlPlaneContext;
    const controlPlaneContext = context && typeof context === "object" && !Array.isArray(context)
      ? context as Record<string, unknown>
      : {};
    workflowEvents.publish({
      source: "workflow_executor",
      event: "dispatch_running",
      workflowId,
      taskId: typeof controlPlaneContext.taskId === "string" ? controlPlaneContext.taskId : undefined,
      agencyWorkflowRunId: typeof controlPlaneContext.agencyWorkflowRunId === "string"
        ? controlPlaneContext.agencyWorkflowRunId
        : undefined,
      clientId: typeof controlPlaneContext.clientId === "string" ? controlPlaneContext.clientId : undefined,
      accountId: typeof controlPlaneContext.accountId === "string" ? controlPlaneContext.accountId : undefined,
      deviceId,
      mode: "edge",
      status: (await getResourceLifecycleExecutionStatusContract("workflows")).active,
      details: {
        mode: "edge",
        templateId: templateId ?? null,
        controlPlaneContext,
        replayedFromPnq: true,
      },
    });
  } catch (err) {
    // The wire send has already happened. Never surface this as a dispatch
    // failure because the caller could issue a duplicate workflow execution.
    console.error(`[${actor}] Failed to reconcile replayed edge workflow ${workflowId} after wire dispatch: ${(err as Error).message}`);
  }
}
