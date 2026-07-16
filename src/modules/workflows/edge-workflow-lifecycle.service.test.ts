import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markRunning: vi.fn(),
  markFailedIfEdgeStartUnacknowledged: vi.fn(),
  get: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("./workflow.service", () => ({
  workflowService: {
    markRunning: mocks.markRunning,
    markFailedIfEdgeStartUnacknowledged: mocks.markFailedIfEdgeStartUnacknowledged,
    get: mocks.get,
  },
}));

vi.mock("../workflow-events", () => ({
  workflowEvents: { publish: mocks.publish },
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
