import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendDeviceExecutionJobToDevice: vi.fn(),
  isDeviceOnline: vi.fn(() => true),
  waitForResult: vi.fn(),
  dispatch: vi.fn(),
  observeAdmission: vi.fn(),
  finishServerWorkflowRoot: vi.fn(),
  cancelQueuedServerWorkflowRoot: vi.fn(),
  recordRejectedEgress: vi.fn(),
}));

vi.mock("../../transport/transport", () => ({
  sendDeviceExecutionJobToDevice: mocks.sendDeviceExecutionJobToDevice,
  isDeviceOnline: mocks.isDeviceOnline,
  waitForResult: mocks.waitForResult,
}));

vi.mock("../dispatcher/dispatcher.service", () => ({
  dispatcherService: { dispatch: mocks.dispatch },
}));

vi.mock("../device-execution", () => ({
  deviceExecutionArbiter: {
    observeAdmission: mocks.observeAdmission,
    finishServerWorkflowRoot: mocks.finishServerWorkflowRoot,
    cancelQueuedServerWorkflowRoot: mocks.cancelQueuedServerWorkflowRoot,
    recordRejectedEgress: mocks.recordRejectedEgress,
  },
}));

import { cancelWorkflow, dispatchWorkflow } from "./workflow-dispatch.service";

describe("workflow dispatch PNQ lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDeviceOnline.mockReturnValue(true);
    mocks.observeAdmission.mockResolvedValue({ decision: "admitted" });
    mocks.finishServerWorkflowRoot.mockResolvedValue({
      decision: "terminal",
      root: { state: "completed" },
    });
    mocks.recordRejectedEgress.mockResolvedValue(undefined);
    mocks.waitForResult.mockResolvedValue({ success: true });
  });

  it("finishes the canonical root when all workflow steps are pre-steps", async () => {
    mocks.dispatch.mockResolvedValueOnce({ jobId: "prestep-job" });
    mocks.sendDeviceExecutionJobToDevice.mockResolvedValueOnce({
      sent: true,
      decision: "dispatched",
      root: { state: "dispatched" },
    });

    const result = await dispatchWorkflow({
      deviceId: "11111111-1111-4111-8111-111111111101",
      workflow: { name: "presteps-only", steps: [{ id: "wake", type: "screen_wake" }] },
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(mocks.finishServerWorkflowRoot).toHaveBeenCalledWith(expect.objectContaining({
      successful: true,
      reason: "all_preworkflow_steps_finished",
    }));
  });

  it("cancels a queued workflow through the queued-only PNQ CAS", async () => {
    mocks.dispatch.mockResolvedValueOnce({ jobId: "queued-job" });
    mocks.sendDeviceExecutionJobToDevice.mockResolvedValueOnce({
      sent: false,
      queued: true,
      decision: "would_wait",
      reason: "device_slot_already_active",
      root: { state: "queued" },
    });
    mocks.cancelQueuedServerWorkflowRoot.mockResolvedValueOnce({
      decision: "terminal",
      root: { state: "cancelled" },
    });

    const dispatched = await dispatchWorkflow({
      deviceId: "11111111-1111-4111-8111-111111111102",
      workflow: { name: "queued", steps: [{ id: "tap", type: "tap", params: { x: 1, y: 2 } }] },
    });
    expect(dispatched).toMatchObject({ jobId: "queued-job", status: "queued" });

    await expect(cancelWorkflow("queued-job")).resolves.toEqual({
      jobId: "queued-job",
      status: "cancelled",
    });
    expect(mocks.cancelQueuedServerWorkflowRoot).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: expect.stringContaining("workflow-dispatch:"),
      reason: "api_cancelled_before_dispatch",
    }));
    expect(mocks.recordRejectedEgress).not.toHaveBeenCalled();
  });

  it("does not falsely cancel or release ownership after workflow dispatch", async () => {
    mocks.dispatch.mockResolvedValueOnce({ jobId: "inflight-job" });
    mocks.sendDeviceExecutionJobToDevice.mockResolvedValueOnce({
      sent: true,
      queued: false,
      decision: "dispatched",
      root: { state: "dispatched" },
    });
    mocks.cancelQueuedServerWorkflowRoot.mockResolvedValueOnce({
      decision: "rejected",
      reason: "root_not_queued",
      root: { state: "dispatched", ownerGeneration: 4 },
    });

    await expect(dispatchWorkflow({
      deviceId: "11111111-1111-4111-8111-111111111103",
      workflow: { name: "inflight", steps: [{ id: "tap", type: "tap", params: { x: 3, y: 4 } }] },
    })).resolves.toMatchObject({ jobId: "inflight-job", status: "dispatched" });

    await expect(cancelWorkflow("inflight-job")).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.recordRejectedEgress).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "inflight-job",
      wireType: "WORKFLOW_CANCEL",
      reason: "workflow_execute_inflight_cancellation_unsupported",
    }));
    expect(mocks.finishServerWorkflowRoot).not.toHaveBeenCalled();
    expect(mocks.sendDeviceExecutionJobToDevice).toHaveBeenCalledTimes(1);
  });
});
