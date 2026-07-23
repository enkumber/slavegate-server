import { describe, expect, it } from "vitest";
import {
  humanWorkflowGoalCoverageReason,
  humanWorkflowUndercompiledReason,
} from "./human-workflow-compiler.service";
import type { WorkflowTemplate } from "../workflows/types";

function workflow(steps: WorkflowTemplate["steps"], outputSchema?: WorkflowTemplate["outputSchema"]): WorkflowTemplate {
  return {
    id: "human_search_content",
    name: "Search content",
    platform: "android",
    description: "Search and return a content result.",
    version: "1.0.0",
    runtimeContract: "edge-workflow/v2",
    safetyClass: "read_only",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps,
    outputSchema,
  };
}

describe("human workflow goal coverage", () => {
  it("rejects the observed semantic failure that taps the search control again", () => {
    const candidate = workflow([
      { id: "open", type: "action", action: "open_app", params: { packageName: "com.example" } },
      { id: "focus_search", type: "action", action: "a11y_find_tap", params: { resourceId: "search_bar_field" } },
      { id: "query", type: "action", action: "type_text", params: { text: "Romania" } },
      { id: "tap_search_again", type: "action", action: "a11y_find_tap", params: { text: "Search" } },
      { id: "dump", type: "action", action: "ui_tree_dump", params: {}, saveOutputAs: "tree" },
    ]);

    expect(humanWorkflowUndercompiledReason(candidate, "Caută un articol legat de România"))
      .toContain("does not select a result distinct");
  });

  it("rejects a selected result that does not extract a business result", () => {
    const candidate = workflow([
      { id: "query", type: "action", action: "set_focused_text", params: { text: "Romania" } },
      { id: "open_result", type: "action", action: "a11y_find_tap", params: { text: "Romania news" } },
      { id: "dump", type: "action", action: "ui_tree_dump", params: {}, saveOutputAs: "tree" },
    ]);

    expect(humanWorkflowGoalCoverageReason(candidate, "Find an article about Romania"))
      .toContain("no deterministic classifier outputs");
  });

  it("accepts distinct query, result selection, detail observation and requested outputs", () => {
    const candidate = workflow([
      { id: "query", type: "action", action: "set_focused_text", params: { text: "Romania" } },
      { id: "submit", type: "action", action: "press_key", params: { key: "ENTER" } },
      {
        id: "open_result",
        type: "action",
        action: "observe_and_transition",
        params: {
          selectors: [{ text: "Romania news", partialMatch: true }],
          postcondition: { action: "ui_tree_dump", operator: "contains_ci", expected: "comments" },
        },
      },
      {
        id: "extract",
        type: "action",
        action: "classify_ui_tree",
        params: {
          outputs: {
            title: { regex: "\"text\":\"([^\"]+)\"", group: 1 },
            author: { regex: "\"author\":\"([^\"]+)\"", group: 1 },
            score: { regex: "\"score\":\"?([0-9.,k]+)", group: 1 },
          },
        },
      },
    ], {
      required: ["title", "author", "score"],
      properties: {
        title: { type: "string" },
        author: { type: "string" },
        score: { type: "string" },
      },
    });

    expect(humanWorkflowGoalCoverageReason(
      candidate,
      "Find an article about Romania and extract title, author and score",
    )).toBeNull();
  });

  it("does not impose discovery requirements on a simple open-app goal", () => {
    const candidate = workflow([
      { id: "open", type: "action", action: "open_app", params: { packageName: "com.example" } },
    ]);
    expect(humanWorkflowGoalCoverageReason(candidate, "Open the app")).toBeNull();
  });
});
