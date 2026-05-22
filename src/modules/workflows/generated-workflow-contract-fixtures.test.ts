import { describe, expect, it } from "vitest";
import type {
  GeneratedWorkflowCompiledPlanSummary,
  GeneratedWorkflowExecuteRequest,
  GeneratedWorkflowTemplate,
} from "../../../shared/protocol/api-types";

const readOnlyMarketingScanWorkflow = {
  id: "agent_generated_reddit_account_health_scan_v1",
  name: "Reddit account health scan",
  platform: "reddit",
  description: "Read-only marketing control-plane scan for account state signals.",
  version: "1.0.0",
  intent: "reddit_account_health_scan",
  safetyClass: "read_only",
  outputSchema: {
    required: [
      "loggedIn",
      "homeFeedVisible",
      "searchSurfaceAvailable",
      "challengeDetected",
      "loginWallDetected",
      "accountSwitcherVisible",
      "observedUsername",
      "error",
    ],
    properties: {
      loggedIn: { type: "string" },
      homeFeedVisible: { type: "string" },
      searchSurfaceAvailable: { type: "string" },
      challengeDetected: { type: "string" },
      loginWallDetected: { type: "string" },
      accountSwitcherVisible: { type: "string" },
      observedUsername: { type: "string" },
      error: { type: "string" },
    },
  },
  allowedRecoveryRequests: ["refresh_screen_state", "retry_current_step", "abort_read_only_scan"],
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
      type: "action",
      id: "dump_ui_state",
      action: "ui_tree_dump",
      timeoutMs: 10000,
    },
    {
      type: "action",
      id: "capture_screen",
      action: "screenshot",
      verification: "local_with_screenshot",
      timeoutMs: 10000,
    },
    {
      type: "action",
      id: "classify_local_state",
      action: "set_variable",
      params: {
        variables: {
          loggedIn: "unknown",
          homeFeedVisible: "unknown",
          searchSurfaceAvailable: "unknown",
          challengeDetected: "unknown",
          loginWallDetected: "unknown",
          accountSwitcherVisible: "unknown",
          observedUsername: "",
          error: "",
        },
      },
    },
    {
      type: "checkpoint",
      id: "account_health_observed",
      reason: "Read-only account health signals captured",
    },
  ],
} satisfies GeneratedWorkflowTemplate;

const readOnlyMarketingCompiledPlan = {
  planVersion: "generated-workflow-plan/v1",
  cacheKey: "0123456789abcdef01234567",
  templateId: readOnlyMarketingScanWorkflow.id,
  platform: "reddit",
  templateVersion: readOnlyMarketingScanWorkflow.version,
  metadata: {
    intent: "reddit_account_health_scan",
    safetyClass: "read_only",
    outputSchema: readOnlyMarketingScanWorkflow.outputSchema,
    allowedRecoveryRequests: readOnlyMarketingScanWorkflow.allowedRecoveryRequests,
  },
  stepCount: 5,
  actionCount: 4,
  checkpointCount: 1,
  maxDepth: 1,
  llmBudget: {
    happyPathRequests: 0,
    recoveryRequests: "only_on_failure",
  },
  steps: [
    { path: "workflow.steps[0]", type: "action", id: "open_reddit", action: "open_app", verification: "local_with_screenshot" },
    { path: "workflow.steps[1]", type: "action", id: "dump_ui_state", action: "ui_tree_dump", verification: "local_with_screenshot" },
    { path: "workflow.steps[2]", type: "action", id: "capture_screen", action: "screenshot", verification: "local_with_screenshot" },
    { path: "workflow.steps[3]", type: "action", id: "classify_local_state", action: "set_variable", verification: "local_with_screenshot" },
    { path: "workflow.steps[4]", type: "checkpoint", id: "account_health_observed" },
  ],
} satisfies GeneratedWorkflowCompiledPlanSummary;

describe("generated workflow shared contract fixtures", () => {
  it("accepts a read-only marketing scan fixture with stable schema metadata", () => {
    expect(readOnlyMarketingScanWorkflow).toMatchObject({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      allowedRecoveryRequests: ["refresh_screen_state", "retry_current_step", "abort_read_only_scan"],
    });
    expect(readOnlyMarketingCompiledPlan.metadata).toMatchObject({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
    });
    expect(readOnlyMarketingCompiledPlan.llmBudget.happyPathRequests).toBe(0);
  });

  it("documents canonical cache execution without an inline workflow payload", () => {
    const request = {
      requestKey: "c02c59dfbe512562f8c65c97",
      deviceId: "11111111-1111-4111-8111-111111111111",
    } satisfies GeneratedWorkflowExecuteRequest;

    expect(request).not.toHaveProperty("workflow");
  });
});

const invalidMutatingWorkflowFixture = {
  ...readOnlyMarketingScanWorkflow,
  id: "agent_generated_reddit_mutating_scan_v1",
  steps: [
    {
      type: "action",
      id: "type_comment",
      // @ts-expect-error Generated read-only workflow fixtures must not allow mutating actions.
      action: "type_text",
      params: { text: "mutating input" },
    },
  ],
} satisfies GeneratedWorkflowTemplate;

void invalidMutatingWorkflowFixture;
