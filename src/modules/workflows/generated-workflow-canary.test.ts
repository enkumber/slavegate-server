import { describe, expect, it } from "vitest";
import {
  compileGeneratedWorkflowTemplate,
  summarizeGeneratedWorkflowTemplate,
  validateGeneratedWorkflowTemplate,
} from "./workflow-validator";
import type { WorkflowTemplate } from "./types";

function redditHomeSmokeWorkflow(): WorkflowTemplate {
  return {
    id: "agent_generated_reddit_home_smoke_v1",
    name: "Agent generated Reddit home smoke",
    platform: "reddit",
    description: "Validation-only canary for an agent-generated Reddit navigation workflow.",
    version: "1.0.0",
    defaultVerificationStrategy: "local_with_screenshot",
    dataRetentionDays: 1,
    steps: [
      {
        type: "action",
        id: "open_reddit",
        action: "open_app",
        params: { packageName: "com.reddit.frontpage" },
        expectedScreen: "REDDIT_HOME_FEED",
        timeoutMs: 15000,
      },
      {
        type: "wait",
        id: "wait_for_reddit_home",
        condition: "app_launched",
        timeoutMs: 10000,
      },
      {
        type: "checkpoint",
        id: "reddit_home_loaded",
        reason: "Home feed reached or app launch validated",
      },
    ],
  };
}

describe("agent-generated workflow canary", () => {
  it("accepts a Reddit home smoke workflow shaped like agent output", () => {
    const workflow = redditHomeSmokeWorkflow();

    const result = validateGeneratedWorkflowTemplate(workflow);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.template?.id).toBe("agent_generated_reddit_home_smoke_v1");
  });

  it("summarizes the canary like the generated dry-run endpoint", () => {
    const workflow = redditHomeSmokeWorkflow();
    const result = validateGeneratedWorkflowTemplate(workflow);
    expect(result.template).toBeDefined();

    expect(summarizeGeneratedWorkflowTemplate(result.template!, { dryRun: true, persisted: false })).toMatchObject({
      generated: true,
      dryRun: true,
      persisted: false,
      templateId: "agent_generated_reddit_home_smoke_v1",
      platform: "reddit",
      version: "1.0.0",
      stepCount: 3,
      compiledPlan: {
        planVersion: "generated-workflow-plan/v1",
        templateId: "agent_generated_reddit_home_smoke_v1",
        platform: "reddit",
        stepCount: 3,
        actionCount: 1,
        checkpointCount: 1,
        llmBudget: {
          happyPathRequests: 0,
          recoveryRequests: "only_on_failure",
        },
      },
    });
  });

  it("compiles the generated workflow into a deterministic reusable plan", () => {
    const workflow = redditHomeSmokeWorkflow();
    const first = compileGeneratedWorkflowTemplate(workflow);
    const second = compileGeneratedWorkflowTemplate(redditHomeSmokeWorkflow());

    expect(first.cacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(first.steps.map((step) => step.path)).toEqual([
      "workflow.steps[0]",
      "workflow.steps[1]",
      "workflow.steps[2]",
    ]);
    expect(first.steps[0]).toMatchObject({
      type: "action",
      id: "open_reddit",
      action: "open_app",
      verification: "local_with_screenshot",
      bindingSource: "fallback",
    });
    expect(first.llmBudget.happyPathRequests).toBe(0);
  });

  it("reports per-step binding sources for generated workflow gates", () => {
    const workflow = redditHomeSmokeWorkflow();
    workflow.steps = [
      { type: "action", id: "tap_map_selector", action: "tap", target: "app_map:main_top_app_bar_search" },
      { type: "action", id: "tap_ui_tree", action: "tap", target: "search_button" },
      { type: "action", id: "tap_map_coordinate", action: "tap", x: 0.5, y: 0.1, params: { coordinateSource: "app_map" } },
      { type: "action", id: "tap_raw_coordinate", action: "tap", x: 0.5, y: 0.9 },
    ];

    const plan = compileGeneratedWorkflowTemplate(workflow);

    expect(plan.steps.map((step) => step.bindingSource)).toEqual([
      "app_map_selector",
      "ui_tree_selector",
      "app_map_coordinate",
      "raw_coordinate",
    ]);
  });

  it("is accepted by the dry-run route without dispatch hooks", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );
    const routeStart = source.indexOf('router.post("/workflows/generated"');
    const routeEnd = source.indexOf('router.post("/workflows/:id/cancel"', routeStart);
    const routeBody = source.substring(routeStart, routeEnd);

    expect(routeBody).toContain("summarizeGeneratedWorkflowTemplate(template, { dryRun: true, persisted: shouldPersist, compiledPlan })");
    const dryRunBranch = routeBody.substring(
      routeBody.indexOf("if (dryRun)"),
      routeBody.indexOf("await workflowService.saveTemplate(template);", routeBody.indexOf("if (dryRun)"))
    );
    expect(dryRunBranch).not.toContain("dispatchWorkflowTemplate");
    expect(dryRunBranch).not.toContain("startWorkflow");
  });

  it("keeps the canary validation-only and non-mutating", () => {
    const workflow = redditHomeSmokeWorkflow();
    const serialized = JSON.stringify(workflow);

    expect(serialized).not.toContain("comment");
    expect(serialized).not.toContain("upvote");
    expect(serialized).not.toContain("downvote");
    expect(serialized).not.toContain("post_button");
  });
});
