import {
  deviceExecutionArbiter,
  isDeviceExecutionResultTerminal,
} from "../device-execution";
import { isDeviceExecutionEnforced } from "../device-execution/device-execution-authority";
import { workflowService } from "./workflow.service";
import { getResourceLifecycleExecutionStatusContract } from "../lifecycle/lifecycle.service";

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
export async function cancelPersistedWorkflowSafely(workflowId: string): Promise<{ workflowId: string; status: string }> {
  const workflow = await workflowService.get(workflowId);
  if (!workflow) throw cancellationError("NOT_FOUND", "Workflow not found", 404);
  if (!workflow.deviceId) throw cancellationError("CANCELLATION_REJECTED", "Workflow has no device", 409);
  const lifecycleStatusContract = await getResourceLifecycleExecutionStatusContract("workflows");

  if (workflow.lifecycleInitial !== true) {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Cancellation is supported only before workflow dispatch; execution ownership remains active",
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
      status: lifecycleStatusContract.cancelled,
      actor: "workflow_api.cancel.observe_only",
      reason: "api_cancelled_before_dispatch",
      metadata: { authorityMode: "observe_only" },
    });
    return { workflowId, status: lifecycleStatusContract.cancelled };
  }

  const pnq = await deviceExecutionArbiter.cancelQueuedPersistedWorkflow({
    deviceId: workflow.deviceId,
    workflowId,
    actor: "workflow_api.cancel",
    reason: "api_cancelled_before_dispatch",
    metadata: { workflowStatus: workflow.status },
  });
  if (!(await isDeviceExecutionResultTerminal(pnq))) {
    await auditUnsupportedInFlight(workflowId, workflow.deviceId, pnq.root?.state ?? workflow.status);
    throw cancellationError(
      "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      "Workflow became active before cancellation; execution ownership remains active",
      409,
    );
  }
  return { workflowId, status: lifecycleStatusContract.cancelled };
}
