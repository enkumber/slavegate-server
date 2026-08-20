import { deviceExecutionArbiter } from "../device-execution";
import { isDeviceExecutionEnforced } from "../device-execution/device-execution-authority";
import { workflowService } from "./workflow.service";
import { directWsServer } from "../../ws/direct-ws.server";

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
 * result or ambiguity reconciliation. The workflow row and PNQ root are locked
 * and terminalized in one database transaction so neither side can win only
 * half of the cancellation race.
 */
export async function cancelPersistedWorkflowSafely(workflowId: string): Promise<{ workflowId: string; status: "cancelled" }> {
  const workflow = await workflowService.get(workflowId);
  if (!workflow) throw cancellationError("NOT_FOUND", "Workflow not found", 404);
  if (!workflow.deviceId) throw cancellationError("CANCELLATION_REJECTED", "Workflow has no device", 409);

  if (!(["queued", "running", "paused"] as string[]).includes(workflow.status)) {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Workflow is already terminal and cannot be cancelled",
      409,
    );
  }

  if (!isDeviceExecutionEnforced()) {
    const cancelled = await workflowService.cancel(workflowId);
    if (!cancelled) {
      throw cancellationError("CANCELLATION_UNSUPPORTED_IN_FLIGHT", "Workflow became active before cancellation", 409);
    }
    void deviceExecutionArbiter.observeTerminal({
      deviceId: workflow.deviceId,
      rootKind: "server_workflow",
      externalId: workflowId,
      status: "cancelled",
      actor: "workflow_api.cancel.observe_only",
      reason: "api_cancelled_before_dispatch",
      metadata: { authorityMode: "observe_only" },
    });
    return { workflowId, status: "cancelled" };
  }

  const pnq = await deviceExecutionArbiter.cancelPersistedWorkflow({
    deviceId: workflow.deviceId,
    workflowId,
    actor: "workflow_api.cancel",
    reason: workflow.status === "queued" ? "api_cancelled_before_dispatch" : "api_cancelled_in_flight",
    metadata: { workflowStatus: workflow.status },
  });
  if (pnq.decision !== "terminal") {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, pnq.root?.state ?? workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Workflow became active before cancellation; execution ownership remains active",
      409,
    );
  }
  if (workflow.status !== "queued") {
    directWsServer.sendWorkflowCancel(workflow.deviceId, workflowId);
  }
  return { workflowId, status: "cancelled" };
}
