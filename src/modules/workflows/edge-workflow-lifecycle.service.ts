import { workflowEvents } from "../workflow-events";
import { workflowService } from "./workflow.service";

const EDGE_WORKFLOW_ACK_TIMEOUT_MS = Number(process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS ?? 20_000);
const EDGE_WORKFLOW_ACK_TIMEOUT_ERROR = "Edge workflow did not acknowledge WORKFLOW_START";

function edgeCheckpointAcknowledged(checkpoint: unknown): boolean {
  return !!checkpoint &&
    typeof checkpoint === "object" &&
    (checkpoint as Record<string, unknown>).source === "edge";
}

export function scheduleEdgeWorkflowAckWatchdog(
  workflowId: string,
  deviceId: string,
  logPrefix: string,
): void {
  const timeout = setTimeout(async () => {
    try {
      const latest = await workflowService.get(workflowId);
      if (!latest || (latest.status !== "running" && latest.status !== "queued") || latest.currentStep !== 0) return;
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
        status: "failed",
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
      if (!latest || ["completed", "failed", "cancelled"].includes(latest.status)) return;
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
      status: "running",
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
