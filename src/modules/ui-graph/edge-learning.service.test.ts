import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";
import { bindEdgeLearningCandidates } from "./edge-learning.service";

function template(steps: WorkflowTemplate["steps"]): WorkflowTemplate {
  return {
    id: "edge-learning-test",
    name: "edge learning test",
    platform: "app.example",
    description: "generic selector validation",
    version: "1",
    runtimeContract: "edge-workflow/v2",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 0,
    steps,
  };
}

describe("edge workflow learning bindings", () => {
  it("binds a selector only when later UI-tree waits verify state", () => {
    const result = bindEdgeLearningCandidates(
      template([
        { type: "action", id: "tap", action: "a11y_find_tap", params: { resourceId: "search" } },
        {
          type: "wait",
          id: "verify",
          until: {
            action: "ui_tree_dump",
            outputPath: "uiTree",
            operator: "contains_ci",
            expected: "results",
            timeoutMs: 10_000,
          },
        },
      ]),
      [{
        id: "candidate-1",
        app_id: "app.example",
        source_state_id: "state-1",
        payload: { strategy: "resource_id", selector: { value: "search" } },
      }],
    );

    expect(result).toEqual([expect.objectContaining({
      candidateId: "candidate-1",
      actionStepIndex: 0,
      verifiedStepIndex: 1,
      stepId: "tap",
    })]);
  });

  it("does not validate an unverified selector action", () => {
    const result = bindEdgeLearningCandidates(
      template([{ type: "action", id: "tap", action: "a11y_find_tap", params: { text: "Search" } }]),
      [{
        id: "candidate-1",
        app_id: "app.example",
        source_state_id: "state-1",
        payload: { strategy: "text", selector: { value: "Search" } },
      }],
    );
    expect(result).toEqual([]);
  });

  it("matches normalized coordinates without coupling to a device", () => {
    const result = bindEdgeLearningCandidates(
      template([
        { type: "action", id: "tap", action: "tap", params: { x: 0.25, y: 0.75 } },
        {
          type: "wait",
          id: "verify",
          until: { action: "ui_tree_dump", operator: "truthy", timeoutMs: 10_000 },
        },
      ]),
      [{
        id: "candidate-coords",
        app_id: "app.example",
        source_state_id: "state-1",
        payload: { strategy: "normalized_coords", selector: { x: 0.25, y: 0.75 } },
      }],
    );
    expect(result[0]?.candidateId).toBe("candidate-coords");
  });
});
