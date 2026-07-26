import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";
import { attachEdgeLearningBindings, bindEdgeLearningCandidates } from "./edge-learning.service";

function template(steps: WorkflowTemplate["steps"]): WorkflowTemplate {
  return {
    id: "edge-learning-test",
    name: "edge learning test",
    platform: "app.example",
    description: "generic selector validation",
    version: "1",
    runtimeContract: "edge-workflow/v2",
    safetyClass: "read_only",
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
        safety_class: "catalog_safe",
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
        safety_class: "catalog_safe",
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
        safety_class: "catalog_safe",
        payload: { strategy: "normalized_coords", selector: { x: 0.25, y: 0.75 } },
      }],
    );
    expect(result[0]?.candidateId).toBe("candidate-coords");
  });

  it("creates a hybrid binding for a new selector with no existing candidate", () => {
    const workflow = template([
      { type: "action", id: "tap-search", action: "a11y_find_tap", params: { resourceId: "search_bar_field" } },
      {
        type: "wait",
        id: "verify-search",
        until: { action: "ui_tree_dump", outputPath: "tree", operator: "contains_ci", expected: "search", timeoutMs: 10_000 },
      },
    ]);
    const result = bindEdgeLearningCandidates(workflow, [], [{
      state_id: "11111111-1111-4111-8111-111111111111",
      element_key: "search_bar",
      strategy: "resource_id",
      selector: { value: "search_bar_field" },
      target_state_id: "22222222-2222-4222-8222-222222222222",
      safety_class: "catalog_safe",
    }]);

    expect(result).toEqual([expect.objectContaining({
      candidateId: undefined,
      bindingId: expect.stringMatching(/^elb_[a-f0-9]{24}$/),
      sourceStateId: "11111111-1111-4111-8111-111111111111",
      targetStateId: "22222222-2222-4222-8222-222222222222",
      payload: expect.objectContaining({ elementKey: "search_bar", strategy: "resource_id" }),
    })]);

    const attached = attachEdgeLearningBindings(workflow, result);
    expect(attached.steps[0]).toEqual(expect.objectContaining({ learningBindingId: result[0].bindingId }));
    expect(attached.steps[1]).toEqual(expect.objectContaining({ learningBindingIds: [result[0].bindingId] }));
    expect(workflow.steps[0]).not.toHaveProperty("learningBindingId");
  });

  it("does not learn selector targets from a standard workflow", () => {
    const workflow = { ...template([
      { type: "action", id: "tap", action: "a11y_find_tap", params: { resourceId: "delete_button" } },
      { type: "wait", id: "verify", until: { action: "ui_tree_dump", operator: "truthy", timeoutMs: 10_000 } },
    ]), safetyClass: "standard" as const };
    expect(bindEdgeLearningCandidates(workflow, [])).toEqual([]);
  });

  it("uses a full graph resource id as context for a portable short id without merging candidates", () => {
    const workflow = template([
      { type: "action", id: "tap", action: "a11y_find_tap", params: { resourceId: "search_bar_field" } },
      { type: "wait", id: "verify", until: { action: "ui_tree_dump", operator: "truthy", timeoutMs: 10_000 } },
    ]);
    const result = bindEdgeLearningCandidates(workflow, [], [{
      state_id: "11111111-1111-4111-8111-111111111111",
      element_key: "search_bar",
      strategy: "resource_id",
      selector: { value: "com.example:id/search_bar_field" },
      target_state_id: null,
      safety_class: "catalog_safe",
    }]);
    expect(result[0]).toEqual(expect.objectContaining({
      candidateId: undefined,
      sourceStateId: "11111111-1111-4111-8111-111111111111",
    }));
  });
});
