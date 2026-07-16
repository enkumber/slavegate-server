import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  cancel: vi.fn(),
  cancelQueuedServerWorkflowRoot: vi.fn(),
  recordRejectedEgress: vi.fn(),
}));

vi.mock("./workflow.service", () => ({
  workflowService: {
    get: mocks.get,
    cancel: mocks.cancel,
  },
}));

vi.mock("../device-execution", () => ({
  deviceExecutionArbiter: {
    cancelQueuedServerWorkflowRoot: mocks.cancelQueuedServerWorkflowRoot,
    recordRejectedEgress: mocks.recordRejectedEgress,
  },
}));

import { cancelPersistedWorkflowSafely } from "./workflow-cancellation.service";

const workflow = {
  id: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  status: "queued",
};

describe("persisted workflow cancellation safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(workflow);
    mocks.cancel.mockResolvedValue(true);
    mocks.cancelQueuedServerWorkflowRoot.mockResolvedValue({ decision: "terminal", root: null });
    mocks.recordRejectedEgress.mockResolvedValue(undefined);
  });

  it("wins the workflow queued CAS before terminalizing the queued PNQ root", async () => {
    const order: string[] = [];
    mocks.cancel.mockImplementation(async () => {
      order.push("workflow-cas");
      return true;
    });
    mocks.cancelQueuedServerWorkflowRoot.mockImplementation(async () => {
      order.push("pnq-cas");
      return { decision: "terminal", root: null };
    });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toEqual({
      workflowId: workflow.id,
      status: "cancelled",
    });
    expect(order).toEqual(["workflow-cas", "pnq-cas"]);
  });

  it("never releases PNQ ownership when the worker wins queued-to-running", async () => {
    mocks.cancel.mockResolvedValue(false);

    await expect(cancelPersistedWorkflowSafely(workflow.id)).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.cancelQueuedServerWorkflowRoot).not.toHaveBeenCalled();
    expect(mocks.recordRejectedEgress).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: workflow.deviceId,
      operationId: workflow.id,
      reason: "workflow_inflight_cancellation_unsupported",
    }));
  });

  it("accepts cancellation before a PNQ root has been admitted", async () => {
    mocks.cancelQueuedServerWorkflowRoot.mockResolvedValue({
      decision: "missing",
      root: null,
      reason: "canonical_root_not_found",
    });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects running cancellation without changing workflow or PNQ state", async () => {
    mocks.get.mockResolvedValue({ ...workflow, status: "running" });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedServerWorkflowRoot).not.toHaveBeenCalled();
  });
});
