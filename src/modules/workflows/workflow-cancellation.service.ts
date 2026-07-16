import { deviceExecutionArbiter } from "../device-execution";
import { workflowService } from "./workflow.service";

function cancellationError(code: string, message: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

async function auditUnsupportedInFlight(
  workflowId: string,
  deviceId: string | null,
  status: string,
): Promise<void> {
  if (!deviceId) return;
  await deviceExecutionArbiter.recordRejectedEgress({
    deviceId,
    operationId: workflowId,
    wireType: "WORKFLOW_CANCEL",
    actor: "workflow_api.cancel",
    reason: "workflow_inflight_cancellation_unsupported",
    metadata: { workflowStatus: status },
  });
}

/**
 * Product cancellation contract for persisted workflows.
 *
 * Only a workflow that is still queued may be cancelled. No wire cancellation
 * is sent: a running workflow retains PNQ ownership until its real terminal
 * result or ambiguity reconciliation. The workflow-table CAS happens first so
 * it competes directly with the worker's queued->running CAS. Once cancellation
 * wins that race, no worker can begin dispatch while the queued PNQ root is
 * terminalized.
 */
export async function cancelPersistedWorkflowSafely(workflowId: string): Promise<{ workflowId: string; status: "cancelled" }> {
  const workflow = await workflowService.get(workflowId);
  if (!workflow) throw cancellationError("NOT_FOUND", "Workflow not found", 404);
  if (!workflow.deviceId) throw cancellationError("CANCELLATION_REJECTED", "Workflow has no device", 409);

  if (workflow.status !== "queued") {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Cancellation is supported only before workflow dispatch; execution ownership remains active",
      409,
    );
  }

  const cancelled = await workflowService.cancel(workflowId);
  if (!cancelled) {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, "state_changed_before_cancel");
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Workflow became active before cancellation; execution ownership remains active",
      409,
    );
  }

  const pnq = await deviceExecutionArbiter.cancelQueuedServerWorkflowRoot({
    deviceId: workflow.deviceId,
    workflowId,
    actor: "workflow_api.cancel",
    reason: "api_cancelled_before_dispatch",
    metadata: { workflowStatus: workflow.status },
  });
  if (pnq.decision !== "terminal" && pnq.decision !== "missing") {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, pnq.root?.state ?? workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Workflow became active before cancellation; execution ownership remains active",
      409,
    );
  }
  return { workflowId, status: "cancelled" };
}
