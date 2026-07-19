import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/client", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import { WorkflowSegmentLibraryService } from "./workflow-segment-library.service";

const successfulWorkflow: WorkflowTemplate = {
  id: "workflow-a",
  name: "Open AskReddit",
  platform: "reddit",
  description: "Reusable navigation",
  version: "1.0.0",
  safetyClass: "read_only",
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 7,
  steps: [
    { id: "wake", type: "action", action: "screen_wake", params: {} },
    { id: "unlock", type: "action", action: "unlock", params: {} },
    {
      id: "askreddit",
      type: "action",
      action: "intent_send",
      params: { packageName: "com.reddit.frontpage", uri: "https://reddit.com/r/AskReddit" },
    },
  ],
};

describe("workflow segment telemetry persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("auto-promotes categorized segments only after a complete successful execution", async () => {
    const service = new WorkflowSegmentLibraryService();
    const learned = await service.learnFromSuccessfulWorkflow({
      workflow: successfulWorkflow,
      cacheKey: "cache-a",
      intent: "Open AskReddit",
      packageName: "com.reddit.frontpage",
      taskId: "task-a",
      workflowRunId: "run-a",
      stepsCompleted: 3,
      totalSteps: 3,
    });

    expect(learned.map((segment) => segment.category)).toEqual([
      "system/android",
      "app/com.reddit.frontpage",
    ]);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(String(mocks.query.mock.calls[0][1][10])).toContain("successful_full_execution");
    expect(mocks.query.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.any(String),
      "app/com.reddit.frontpage",
      "com.reddit.frontpage",
    ]));
  });

  it("does not learn from a partial execution", async () => {
    const service = new WorkflowSegmentLibraryService();
    const learned = await service.learnFromSuccessfulWorkflow({
      workflow: successfulWorkflow,
      cacheKey: "cache-a",
      intent: "Open AskReddit",
      packageName: "com.reddit.frontpage",
      stepsCompleted: 2,
      totalSteps: 3,
    });

    expect(learned).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("learns only the newly compiled gap after a hybrid workflow succeeds", async () => {
    const service = new WorkflowSegmentLibraryService();
    const hybridWorkflow: WorkflowTemplate = {
      ...successfulWorkflow,
      steps: [
        { id: "reuse_aaaaaaaa_0_wake", type: "action", action: "screen_wake", params: {} },
        { id: "new-observation", type: "action", action: "ui_tree_dump", params: { packageName: "com.reddit.frontpage" } },
      ],
    };
    const learned = await service.learnFromSuccessfulWorkflow({
      workflow: hybridWorkflow,
      cacheKey: "cache-b",
      intent: "Inspect Reddit feed",
      packageName: "com.reddit.frontpage",
      stepsCompleted: 2,
      totalSteps: 2,
      excludeComposedReuseSteps: true,
    });

    expect(learned).toHaveLength(1);
    expect(learned[0].category).toBe("app/com.reddit.frontpage");
    expect(learned[0].steps.map((step) => step.id)).toEqual(["new-observation"]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
