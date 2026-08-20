import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  cancelPersistedWorkflow: vi.fn(),
  recordRejectedEgress: vi.fn(),
  sendWorkflowCancel: vi.fn(),
}));

vi.mock("./workflow.service", () => ({
  workflowService: {
    get: mocks.get,
  },
}));

vi.mock("../device-execution", () => ({
  deviceExecutionArbiter: {
    cancelPersistedWorkflow: mocks.cancelPersistedWorkflow,
    recordRejectedEgress: mocks.recordRejectedEgress,
  },
}));

vi.mock("../../ws/direct-ws.server", () => ({
  directWsServer: {
    sendWorkflowCancel: mocks.sendWorkflowCancel,
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
    mocks.cancelPersistedWorkflow.mockResolvedValue({ decision: "terminal", root: null });
    mocks.recordRejectedEgress.mockResolvedValue(undefined);
  });

  it("delegates the workflow and PNQ CAS to one atomic arbiter transaction", async () => {
    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toEqual({
      workflowId: workflow.id,
      status: "cancelled",
    });
    expect(mocks.cancelPersistedWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: workflow.deviceId,
      workflowId: workflow.id,
    }));
    expect(mocks.sendWorkflowCancel).not.toHaveBeenCalled();
  });

  it("does not send device cancel when the queued CAS loses before in-flight ownership is observed", async () => {
    mocks.cancelPersistedWorkflow.mockResolvedValue({
      decision: "rejected",
      root: { state: "dispatched" },
      reason: "root_not_queued",
    });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.sendWorkflowCancel).not.toHaveBeenCalled();
  });

  it("accepts cancellation before a PNQ root has been admitted", async () => {
    mocks.cancelPersistedWorkflow.mockResolvedValue({ decision: "terminal", root: null });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels running workflows atomically and sends in-flight device cancellation", async () => {
    mocks.get.mockResolvedValue({ ...workflow, status: "running" });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toEqual({
      workflowId: workflow.id,
      status: "cancelled",
    });
    expect(mocks.cancelPersistedWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      reason: "api_cancelled_in_flight",
    }));
    expect(mocks.sendWorkflowCancel).toHaveBeenCalledWith(workflow.deviceId, workflow.id);
  });
});
