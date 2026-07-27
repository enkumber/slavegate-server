import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markRunning: vi.fn(),
  markFailedIfEdgeStartUnacknowledged: vi.fn(),
  markFailedIfEdgeProgressStale: vi.fn(),
  listActive: vi.fn(),
  getTemplate: vi.fn(),
  sendWorkflowCancellationControl: vi.fn(),
  get: vi.fn(),
  publish: vi.fn(),
  getWorkflowInterpreterPolicy: vi.fn(),
}));

vi.mock("./workflow.service", () => ({
  workflowService: {
    markRunning: mocks.markRunning,
    markFailedIfEdgeStartUnacknowledged: mocks.markFailedIfEdgeStartUnacknowledged,
    markFailedIfEdgeProgressStale: mocks.markFailedIfEdgeProgressStale,
    listActive: mocks.listActive,
    getTemplate: mocks.getTemplate,
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

vi.mock("../workflow-events", () => ({
  workflowEvents: { publish: mocks.publish },
}));

vi.mock("../../transport/transport", () => ({
  sendWorkflowCancellationControl: mocks.sendWorkflowCancellationControl,
}));

vi.mock("../dispatcher/dispatcher.service", () => ({
  getWorkflowInterpreterPolicy: mocks.getWorkflowInterpreterPolicy,
}));

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";

describe("replayed edge workflow lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS = "5";
    mocks.markRunning.mockResolvedValue(true);
    mocks.markFailedIfEdgeStartUnacknowledged.mockResolvedValue(true);
    mocks.markFailedIfEdgeProgressStale.mockResolvedValue(true);
    mocks.listActive.mockResolvedValue({ items: [], total: 0 });
    mocks.getTemplate.mockResolvedValue(null);
    mocks.sendWorkflowCancellationControl.mockResolvedValue(true);
    mocks.getWorkflowInterpreterPolicy.mockResolvedValue({
      enginePolicy: {
        ackTimeoutMs: 5,
        progressSweepMs: 1000,
        progressGraceMs: 15_000,
        minStaleMs: 30_000,
        maxStaleMs: 300_000,
        localStepBudgetMs: 15_000,
      },
    });
  });

  it("fails and cancels an acknowledged workflow whose current step stopped making progress", async () => {
    const checkpointAt = "2026-07-22T12:00:00.000Z";
    mocks.listActive.mockResolvedValue({
      items: [{
        id: WORKFLOW_ID,
        deviceId: DEVICE_ID,
        templateId: "template-1",
        status: "running",
        currentStep: 1,
        checkpoint: { source: "edge", checkpointAt },
      }],
      total: 1,
    });
    mocks.getTemplate.mockResolvedValue({
      steps: [{ type: "action", action: "screen_wake" }, { type: "action", action: "unlock", timeoutMs: 15_000 }],
    });
    const { sweepStaleEdgeWorkflows } = await import("./edge-workflow-lifecycle.service");

    await expect(sweepStaleEdgeWorkflows(Date.parse(checkpointAt) + 31_000)).resolves.toEqual({ checked: 1, failed: 1 });

    expect(mocks.markFailedIfEdgeProgressStale).toHaveBeenCalledWith(
      WORKFLOW_ID,
      checkpointAt,
      expect.stringContaining("made no progress"),
    );
    expect(mocks.sendWorkflowCancellationControl).toHaveBeenCalledWith(DEVICE_ID, WORKFLOW_ID);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      event: "failed",
      workflowId: WORKFLOW_ID,
      details: expect.objectContaining({ reason: "edge_progress_timeout", cancelSent: true }),
    }));
  });

  it("does not cancel a workflow that progressed before the checkpoint CAS", async () => {
    const checkpointAt = "2026-07-22T12:00:00.000Z";
    mocks.listActive.mockResolvedValue({
      items: [{
        id: WORKFLOW_ID,
        deviceId: DEVICE_ID,
        templateId: null,
        status: "running",
        currentStep: 1,
        checkpoint: { source: "edge", checkpointAt },
      }],
      total: 1,
    });
    mocks.markFailedIfEdgeProgressStale.mockResolvedValue(false);
    const { sweepStaleEdgeWorkflows } = await import("./edge-workflow-lifecycle.service");

    await expect(sweepStaleEdgeWorkflows(Date.parse(checkpointAt) + 60_000)).resolves.toEqual({ checked: 1, failed: 0 });
    expect(mocks.sendWorkflowCancellationControl).not.toHaveBeenCalled();
  });

  afterEach(() => {
    delete process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("marks a replayed PNQ workflow running and applies the same ACK timeout", async () => {
    mocks.get.mockResolvedValue({
      id: WORKFLOW_ID,
      status: "running",
      currentStep: 0,
      checkpoint: { stepIndex: 0, variables: {} },
    });
    const { promoteReplayedEdgeWorkflowToRunning } = await import("./edge-workflow-lifecycle.service");

    await promoteReplayedEdgeWorkflowToRunning({
      workflowId: WORKFLOW_ID,
      deviceId: DEVICE_ID,
      templateId: "template-1",
      variables: {
        controlPlaneContext: {
          taskId: "33333333-3333-4333-8333-333333333333",
        },
      },
      actor: "test.queue_pump",
    });

    expect(mocks.markRunning).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      event: "dispatch_running",
      workflowId: WORKFLOW_ID,
      deviceId: DEVICE_ID,
      status: "running",
      details: expect.objectContaining({ replayedFromPnq: true }),
    }));

    await vi.advanceTimersByTimeAsync(6);

    expect(mocks.markFailedIfEdgeStartUnacknowledged).toHaveBeenCalledWith(
      WORKFLOW_ID,
      expect.stringContaining("did not acknowledge WORKFLOW_START"),
    );
  });

  it("does not fail a replay after an edge checkpoint acknowledges the wire send", async () => {
    mocks.get.mockResolvedValue({
      id: WORKFLOW_ID,
      status: "running",
      currentStep: 0,
      checkpoint: { source: "edge", stepIndex: 0, variables: {} },
    });
    const { promoteReplayedEdgeWorkflowToRunning } = await import("./edge-workflow-lifecycle.service");

    await promoteReplayedEdgeWorkflowToRunning({
      workflowId: WORKFLOW_ID,
      deviceId: DEVICE_ID,
      actor: "test.queue_pump",
    });
    await vi.advanceTimersByTimeAsync(6);

    expect(mocks.markFailedIfEdgeStartUnacknowledged).not.toHaveBeenCalled();
  });

  it("does not publish a timeout failure when the atomic status transition loses to an ACK", async () => {
    mocks.get.mockResolvedValue({
      id: WORKFLOW_ID,
      status: "running",
      currentStep: 0,
      checkpoint: { stepIndex: 0, variables: {} },
    });
    mocks.markFailedIfEdgeStartUnacknowledged.mockResolvedValue(false);
    const { promoteReplayedEdgeWorkflowToRunning } = await import("./edge-workflow-lifecycle.service");

    await promoteReplayedEdgeWorkflowToRunning({
      workflowId: WORKFLOW_ID,
      deviceId: DEVICE_ID,
      actor: "test.queue_pump",
    });
    await vi.advanceTimersByTimeAsync(6);

    expect(mocks.publish).not.toHaveBeenCalledWith(expect.objectContaining({ event: "failed" }));
  });

  it("does not surface post-wire reconciliation failure as a retryable dispatch error", async () => {
    mocks.markRunning.mockRejectedValue(new Error("database unavailable"));
    const { promoteReplayedEdgeWorkflowToRunning } = await import("./edge-workflow-lifecycle.service");

    await expect(promoteReplayedEdgeWorkflowToRunning({
      workflowId: WORKFLOW_ID,
      deviceId: DEVICE_ID,
      actor: "test.queue_pump",
    })).resolves.toBeUndefined();

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.markFailedIfEdgeStartUnacknowledged).not.toHaveBeenCalled();
  });
});
