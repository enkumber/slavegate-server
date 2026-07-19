import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  llmJson: vi.fn(),
  saveExecutableGeneratedPlanCache: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: () => ({ query: mocks.query }),
}));

vi.mock("../../utils/llm", () => ({
  llmJson: mocks.llmJson,
}));

vi.mock("../app-mapping/recorder.service", () => ({
  loadMap: vi.fn().mockResolvedValue(null),
}));

vi.mock("../workflows/workflow.service", () => ({
  workflowService: {
    saveExecutableGeneratedPlanCache: mocks.saveExecutableGeneratedPlanCache,
  },
}));

vi.mock("./compile-job.service", () => ({
  humanWorkflowCompileJobService: {},
}));

vi.mock("../workflow-shortcuts/shortcut-registry.service", () => ({
  shortcutRegistryService: {},
}));

import { humanWorkflowCompilerService } from "./human-workflow-compiler.service";

describe("human workflow cross-workflow segment composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fingerprint: "system-fingerprint",
        category: "system/android",
        package_name: null,
        placement: "prefix",
        semantic_tokens: ["wake", "unlock"],
        steps: [
          { id: "wake-a", type: "action", action: "screen_wake", params: {} },
          { id: "unlock-a", type: "action", action: "unlock", params: {} },
        ],
        source_cache_key: "cache-a",
        source_workflow_id: "workflow-a",
        source_workflow_version: "1.0.0",
        source_intent: "Wake device and open AskReddit",
        success_count: 5,
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        fingerprint: "app-fingerprint",
        category: "app/com.reddit.frontpage",
        package_name: "com.reddit.frontpage",
        placement: "body",
        semantic_tokens: ["reddit", "askreddit", "feed"],
        steps: [{
          id: "open-askreddit-a",
          type: "action",
          action: "intent_send",
          params: { packageName: "com.reddit.frontpage", uri: "https://reddit.com/r/AskReddit" },
        }],
        source_cache_key: "cache-a",
        source_workflow_id: "workflow-a",
        source_workflow_version: "1.0.0",
        source_intent: "Open AskReddit feed",
        success_count: 3,
      },
    ] });
    mocks.llmJson.mockResolvedValue({
      id: "workflow-b",
      name: "Inspect AskReddit post",
      platform: "reddit",
      description: "Inspect a post after reusable navigation",
      version: "1.0.0",
      safetyClass: "standard",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        { id: "inspect-b", type: "action", action: "ui_tree_dump", params: { outputVariable: "_finalUiTree" } },
        { id: "done-b", type: "checkpoint", reason: "post inspected" },
      ],
    });
    mocks.saveExecutableGeneratedPlanCache.mockResolvedValue(undefined);
  });

  it("reuses system and Reddit segments from A while asking Qwen only for B's gap", async () => {
    const result = await humanWorkflowCompilerService.compileWithLlm({
      requestKey: "request-b",
      intent: "Open the AskReddit feed and inspect a post",
      target: {
        device_id: "device-1",
        device_model: "Pixel",
        device_name: "acasa",
        account_id: null,
        account_username: null,
        account_platform: "reddit",
        client_id: null,
      },
    });

    expect(result.source).toBe("hybrid");
    expect(result.plan.segmentReuse).toEqual(expect.objectContaining({
      selectedStepIds: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
      selectedCategories: ["system/android", "app/com.reddit.frontpage"],
      reusedStepCount: 3,
      llmCompiledGapStepCount: 2,
    }));
    expect(mocks.llmJson).toHaveBeenCalledWith(
      expect.stringContaining("Generate only the missing steps for the goal; do not repeat these steps."),
      undefined,
      expect.any(Object),
    );
    const persistedTemplate = mocks.saveExecutableGeneratedPlanCache.mock.calls[0][0];
    expect(persistedTemplate.steps.map((step: { type: string; action?: string }) => step.action ?? step.type)).toEqual([
      "screen_wake", "unlock", "intent_send", "ui_tree_dump", "checkpoint",
    ]);
    expect(mocks.saveExecutableGeneratedPlanCache.mock.calls[0][3].sourceMetadata.segmentReuse).toEqual(
      expect.objectContaining({ reusedStepCount: 3, llmCompiledGapStepCount: 2 }),
    );
  });
});
