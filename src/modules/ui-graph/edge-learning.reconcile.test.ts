import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  observe: vi.fn(),
  validate: vi.fn(),
  promote: vi.fn(),
  resolveFlags: vi.fn(),
}));

vi.mock("../../db/client", () => ({ getDb: () => ({ query: mocks.query }) }));
vi.mock("./learning-loop", () => ({
  uiGraphLearningLoop: {
    observe: mocks.observe,
    validate: mocks.validate,
    promote: mocks.promote,
  },
}));
vi.mock("./repository", () => ({
  uiGraphRepository: { resolveFlags: mocks.resolveFlags },
}));

import { reconcileEdgeLearningStatus } from "./edge-learning.service";

describe("hybrid edge learning reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.observe.mockResolvedValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    mocks.validate.mockResolvedValue({ autoPromotable: false });
    mocks.resolveFlags.mockResolvedValue({ autoPromotion: true });
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ candidate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] });
  });

  it("upserts and validates a previously unknown selector from compact verified evidence", async () => {
    await reconcileEdgeLearningStatus({
      workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "running",
      currentStep: 2,
      variables: {
        _edgeLearningBindings: [{
          bindingId: "elb_new",
          appId: "app.example",
          actionStepIndex: 0,
          verifiedStepIndex: 1,
          stepId: "tap-search",
          verificationStepId: "verify-search",
          sourceStateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          targetStateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          payload: { elementKey: "search", strategy: "resource_id", selector: { value: "search_bar_field" } },
          safetyClass: "navigation",
        }],
        _edgeLearningEvidence: [{
          bindingId: "elb_new",
          result: "success",
          checkpoint: 1,
          verificationStepId: "verify-search",
          postState: { verified: true, outputHash: "hash" },
        }],
      },
    });

    expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({
      appId: "app.example",
      type: "selector",
      payload: expect.objectContaining({ strategy: "resource_id" }),
    }));
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (workflow_id, binding_id, checkpoint_key) DO NOTHING"),
      expect.arrayContaining(["elb_new", "1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "success"]),
    );
    expect(mocks.validate).toHaveBeenCalledTimes(1);
  });

  it("does not trust evidence whose verification step does not match the immutable binding", async () => {
    await reconcileEdgeLearningStatus({
      workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "completed",
      currentStep: 2,
      variables: {
        _edgeLearningBindings: [{
          bindingId: "elb_new",
          appId: "app.example",
          actionStepIndex: 0,
          verifiedStepIndex: 1,
          stepId: "tap-search",
          verificationStepId: "verify-search",
          payload: { elementKey: "search", strategy: "resource_id", selector: { value: "search_bar_field" } },
          safetyClass: "navigation",
        }],
        _edgeLearningEvidence: [{
          bindingId: "elb_new",
          result: "success",
          checkpoint: 1,
          verificationStepId: "wrong-step",
          postState: { verified: true, outputHash: "hash" },
        }],
      },
    });

    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("does not trust a success claim without verified post-state proof", async () => {
    await reconcileEdgeLearningStatus({
      workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "completed",
      currentStep: 2,
      variables: {
        _edgeLearningBindings: [{
          bindingId: "elb_new",
          appId: "app.example",
          actionStepIndex: 0,
          verifiedStepIndex: 1,
          stepId: "tap-search",
          verificationStepId: "verify-search",
          payload: { elementKey: "search", strategy: "resource_id", selector: { value: "search_bar_field" } },
          safetyClass: "navigation",
        }],
        _edgeLearningEvidence: [{
          bindingId: "elb_new",
          result: "success",
          checkpoint: 1,
          verificationStepId: "verify-search",
          postState: { verified: false, outputHash: "hash" },
        }],
      },
    });

    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
  });
});
