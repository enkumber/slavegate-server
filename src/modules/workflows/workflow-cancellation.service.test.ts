import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  cancelQueuedPersistedWorkflow: vi.fn(),
  recordRejectedEgress: vi.fn(),
}));

vi.mock("./workflow.service", () => ({
  workflowService: {
    get: mocks.get,
  },
}));

vi.mock("../lifecycle/lifecycle.service", () => ({
  getResourceLifecycleExecutionStatusContract: vi.fn().mockResolvedValue({
    initial: "queued",
    active: "running",
    succeeded: "completed",
    failed: "failed",
    cancelled: "cancelled",
  }),
}));

vi.mock("../device-execution", () => ({
  isDeviceExecutionResultTerminal: (result: { transitionApplied?: boolean }) =>
    result.transitionApplied === true,
  deviceExecutionArbiter: {
    cancelQueuedPersistedWorkflow: mocks.cancelQueuedPersistedWorkflow,
    recordRejectedEgress: mocks.recordRejectedEgress,
  },
}));

import { cancelPersistedWorkflowSafely } from "./workflow-cancellation.service";

const workflow = {
  id: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  status: "queued",
  lifecycleInitial: true,
};

describe("persisted workflow cancellation safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(workflow);
    mocks.cancelQueuedPersistedWorkflow.mockResolvedValue({
      decision: "terminal",
      transitionApplied: true,
      root: null,
    });
    mocks.recordRejectedEgress.mockResolvedValue(undefined);
  });

  it("delegates the workflow and PNQ CAS to one atomic arbiter transaction", async () => {
    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toEqual({
      workflowId: workflow.id,
      status: "cancelled",
    });
    expect(mocks.cancelQueuedPersistedWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: workflow.deviceId,
      workflowId: workflow.id,
    }));
  });

  it("never releases PNQ ownership when the worker wins queued-to-running", async () => {
    mocks.cancelQueuedPersistedWorkflow.mockResolvedValue({
      decision: "rejected",
      root: { state: "dispatched" },
      reason: "root_not_queued",
    });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.recordRejectedEgress).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: workflow.deviceId,
      operationId: workflow.id,
      reason: "workflow_inflight_cancellation_unsupported",
    }));
  });

  it("accepts cancellation before a PNQ root has been admitted", async () => {
    mocks.cancelQueuedPersistedWorkflow.mockResolvedValue({
      decision: "terminal",
      transitionApplied: true,
      root: null,
    });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects running cancellation without changing workflow or PNQ state", async () => {
    mocks.get.mockResolvedValue({ ...workflow, status: "running", lifecycleInitial: false });

    await expect(cancelPersistedWorkflowSafely(workflow.id)).rejects.toMatchObject({
      code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
      status: 409,
    });
    expect(mocks.cancelQueuedPersistedWorkflow).not.toHaveBeenCalled();
  });
});
