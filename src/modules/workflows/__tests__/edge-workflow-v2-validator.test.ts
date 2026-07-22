import { describe, expect, it } from "vitest";
import { compileGeneratedWorkflowTemplate, validateGeneratedWorkflowTemplate } from "../workflow-validator";

function workflow() {
  return {
    id: "portable_navigation_v2",
    name: "Portable navigation",
    platform: "com.example.anyapp",
    description: "All execution behavior is carried by the workflow payload.",
    version: "2.0.0",
    runtimeContract: "edge-workflow/v2",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 0,
    steps: [
      {
        id: "tap",
        type: "action",
        action: "a11y_find_tap",
        params: { resourceId: "search" },
        retries: 2,
        retryDelayMs: 250,
        delayAfterMs: 300,
        failureMode: "run_branch_then_retry",
        onFailureSteps: [
          { id: "back", type: "action", action: "press_key", params: { key: "back" } },
        ],
      },
      {
        id: "ready",
        type: "wait",
        until: {
          action: "ui_tree_dump",
          outputPath: "uiTree",
          operator: "contains_ci",
          expected: "search_field",
          timeoutMs: 5000,
        },
      },
      {
        id: "branch",
        type: "condition",
        check: "expression",
        expression: "$ready == true",
        if_true: [{ id: "enter", type: "action", action: "keyevent", params: { keyCode: 66 } }],
        if_false: [],
      },
    ],
  };
}

describe("edge-workflow/v2 validation", () => {
  it("accepts explicit timing, retry, branch and state polling", () => {
    expect(validateGeneratedWorkflowTemplate(workflow())).toEqual(expect.objectContaining({ ok: true }));
  });

  it("rejects application-specific runtime actions", () => {
    const candidate = workflow();
    candidate.steps[0].action = "classify_reddit_health_scan";
    const result = validateGeneratedWorkflowTemplate(candidate);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("classify_reddit_health_scan");
  });

  it("accepts an explicit LLM request and accounts for it in the plan", () => {
    const candidate = workflow();
    candidate.steps.push({
      id: "decide",
      type: "action",
      action: "request_llm",
      params: {
        prompt: "Choose a branch for {{screenState}} and return JSON",
        responseFormat: "json",
        requiredKeys: ["branch"],
        targetVariable: "decision",
      },
      timeoutMs: 30_000,
      failureMode: "abort",
    } as never);
    const result = validateGeneratedWorkflowTemplate(candidate);
    expect(result.ok).toBe(true);
    expect(compileGeneratedWorkflowTemplate(result.template!).llmBudget.happyPathRequests).toBe(1);
  });

  it("rejects request_llm without an explicit prompt", () => {
    const candidate = workflow();
    candidate.steps.push({ id: "decide", type: "action", action: "request_llm", params: {} } as never);
    const result = validateGeneratedWorkflowTemplate(candidate);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("params.prompt");
  });
});
