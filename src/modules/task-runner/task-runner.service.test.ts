import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTaskNow } from "./task-runner.service";
import { getDb } from "../../db/client";
import type { TaskRow } from "./task-runner.service";
import type { WorkflowTemplate } from "../workflows/types";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  isDeviceOnline: vi.fn(),
  dispatchGeneratedWorkflowTemplate: vi.fn(),
  cacheLookupLabels: vi.fn(() => ({ inc: vi.fn() })),
  executionLabels: vi.fn(() => ({ inc: vi.fn() })),
  llmAvoidedLabels: vi.fn(() => ({ inc: vi.fn() })),
  taskRunnerDispatchLabels: vi.fn(() => ({ inc: vi.fn() })),
  workflowEventsPublish: vi.fn(),
  getGeneratedPlanCache: vi.fn(),
  getGeneratedPlanCacheByRequestKey: vi.fn(),
  getGeneratedPlanCacheForRepair: vi.fn(),
  recordGeneratedPlanCacheOutcome: vi.fn(),
  saveTemplate: vi.fn(),
  saveGeneratedPlanCache: vi.fn(),
  getWorkflow: vi.fn(),
  cancelPersistedWorkflowSafely: vi.fn(),
  llmJson: vi.fn(),
  compiledWorkflowToEdgeTemplate: vi.fn(),
  recordExhaustedTaskIncident: vi.fn(),
  reconcileSupersededTaskIncidents: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: mocks.dbQuery })),
}));

vi.mock("../../transport/transport", () => ({
  isDeviceOnline: mocks.isDeviceOnline,
}));


vi.mock("../workflows/generated-workflow-execution.service", () => ({
  dispatchGeneratedWorkflowTemplate: mocks.dispatchGeneratedWorkflowTemplate,
}));

vi.mock("../observability/metrics", () => ({
  generatedWorkflowCacheLookups: { labels: mocks.cacheLookupLabels },
  generatedWorkflowExecutions: { labels: mocks.executionLabels },
  generatedWorkflowLlmAvoided: { labels: mocks.llmAvoidedLabels },
  generatedWorkflowTaskRunnerDispatches: { labels: mocks.taskRunnerDispatchLabels },
}));

vi.mock("../workflows/workflow.service", () => ({
  workflowService: {
    getGeneratedPlanCache: mocks.getGeneratedPlanCache,
    getGeneratedPlanCacheByRequestKey: mocks.getGeneratedPlanCacheByRequestKey,
    getGeneratedPlanCacheForRepair: mocks.getGeneratedPlanCacheForRepair,
    recordGeneratedPlanCacheOutcome: mocks.recordGeneratedPlanCacheOutcome,
    saveTemplate: mocks.saveTemplate,
    saveGeneratedPlanCache: mocks.saveGeneratedPlanCache,
    get: mocks.getWorkflow,
  },
}));

vi.mock("../workflows/workflow-cancellation.service", () => ({
  cancelPersistedWorkflowSafely: mocks.cancelPersistedWorkflowSafely,
}));

vi.mock("../../utils/llm", () => ({
  llmJson: mocks.llmJson,
}));

vi.mock("../workflow-compiler/edge-template.adapter", () => ({
  compiledWorkflowToEdgeTemplate: mocks.compiledWorkflowToEdgeTemplate,
}));

vi.mock("../workflow-events", () => ({
  workflowEvents: { publish: mocks.workflowEventsPublish },
}));

vi.mock("../incidents/incident.service", () => ({
  recordExhaustedTaskIncident: mocks.recordExhaustedTaskIncident,
  reconcileSupersededTaskIncidents: mocks.reconcileSupersededTaskIncidents,
}));

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN_ID = "66666666-6666-4666-8666-666666666666";
const REQUEST_KEY = "c02c59dfbe512562f8c65c97";
const CACHE_KEY = "56d91a7aa0e90314241896a2";
const REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS = {
  loggedIn: "unknown",
  homeFeedVisible: "unknown",
  searchSurfaceAvailable: "unknown",
  challengeDetected: "unknown",
  loginWallDetected: "unknown",
  accountSwitcherVisible: "unknown",
  observedUsername: "",
  screenState: "unknown",
  error: "",
};

function generatedWorkflow(): WorkflowTemplate {
  return {
    id: "agent_generated_reddit_account_health_scan_v1",
    name: "Reddit account health scan",
    platform: "reddit",
    description: "Read-only generated workflow for task-runner tests.",
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
        "screenState",
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
        screenState: { type: "string" },
        error: { type: "string" },
      },
    },
    allowedRecoveryRequests: ["refresh_screen_state"],
    defaultVerificationStrategy: "local_with_screenshot",
    dataRetentionDays: 1,
    steps: [
      {
        type: "action",
        id: "open_reddit",
        action: "open_app",
        params: { packageName: "com.reddit.frontpage" },
      },
      {
        type: "checkpoint",
        id: "reddit_home_loaded",
      },
    ],
  };
}

function cacheRecord(overrides: Record<string, unknown> = {}) {
  const workflow = generatedWorkflow();
  return {
    cacheKey: CACHE_KEY,
    requestKey: REQUEST_KEY,
    canonicalWorkflowId: workflow.id,
    canonicalWorkflowVersion: workflow.version,
    compiledPlanHash: "2bfa7e7f8cf48d6e04434bc20cfc2dc32209d15b83605d183df0922b6df3b5ef",
    sourceMetadata: { source: "test" },
    templateId: workflow.id,
    platform: workflow.platform,
    templateVersion: workflow.version,
    workflow,
    compiledPlan: {
      planVersion: "generated-workflow-plan/v1",
      cacheKey: CACHE_KEY,
      templateId: workflow.id,
      platform: workflow.platform,
      templateVersion: workflow.version,
      stepCount: 2,
      actionCount: 1,
      checkpointCount: 1,
      maxDepth: 1,
      llmBudget: {
        happyPathRequests: 0,
        recoveryRequests: "only_on_failure",
      },
      steps: [
        { id: "open_reddit", type: "action", deterministic: true },
        { id: "reddit_home_loaded", type: "checkpoint", deterministic: true },
      ],
    },
    hitCount: 1,
    createdAt: "2026-05-22T08:00:00.000Z",
    updatedAt: "2026-05-22T08:01:00.000Z",
    lastUsedAt: "2026-05-22T08:02:00.000Z",
    ...overrides,
  };
}

function completedWorkflow(variables: Record<string, unknown> = REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS) {
  return {
    id: WORKFLOW_ID,
    templateId: "agent_generated_reddit_account_health_scan_v1",
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    status: "completed",
    currentStep: 2,
    totalSteps: 2,
    checkpoint: {
      stepIndex: 2,
      loopStack: [],
      variables,
      hbeParams: {},
      checkpointAt: "2026-05-22T08:00:10.000Z",
      executionStats: {
        compileLlmCalls: 0,
        recoveryLlmCalls: 0,
        creativeLlmCalls: 0,
        runtimeLlmCalls: 0,
        vlmCalls: 0,
        deterministicSteps: 2,
        batchedSteps: 0,
        failedSteps: 0,
        retriedSteps: 0,
        recoveryAttempts: 0,
        recoveryBudgetExhausted: 0,
        mode: "edge",
      },
    },
    executionStats: null,
    hbeParams: {},
    startedAt: "2026-05-22T08:00:00.000Z",
    completedAt: "2026-05-22T08:00:10.000Z",
    error: null,
    createdAt: "2026-05-22T08:00:00.000Z",
  };
}

function failedWorkflow(error = "RECOVERY_BUDGET_EXCEEDED") {
  return {
    ...completedWorkflow({}),
    status: "failed",
    currentStep: 1,
    totalSteps: 3,
    error,
    checkpoint: {
      ...completedWorkflow({}).checkpoint,
      stepIndex: 1,
      variables: {
        _finalUiTree: { uiTree: "package=com.google.android.gm text=Add account Something went wrong" },
      },
    },
  };
}

function task(params: Record<string, unknown>, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID,
    account_id: ACCOUNT_ID,
    device_id: DEVICE_ID,
    routine: "generated_workflow",
    params,
    scheduled_time: new Date("2026-05-22T08:00:00.000Z"),
    status: "queued",
    retry_count: 0,
    ...overrides,
  };
}

function mockTaskDb(row: TaskRow, platform = "reddit") {
  mocks.dbQuery
    .mockResolvedValueOnce({ rows: [row] })
    .mockResolvedValueOnce({ rows: [{ platform, client_id: CLIENT_ID }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe("task-runner generated_workflow routine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({ query: mocks.dbQuery } as any);
    mocks.isDeviceOnline.mockReturnValue(true);
    mocks.dispatchGeneratedWorkflowTemplate.mockResolvedValue({
      workflowId: WORKFLOW_ID,
      status: "running",
      mode: "edge",
      templateId: "agent_generated_reddit_account_health_scan_v1",
    });
    mocks.getWorkflow.mockResolvedValue(completedWorkflow());
    mocks.cancelPersistedWorkflowSafely.mockResolvedValue({
      workflowId: WORKFLOW_ID,
      status: "cancelled",
    });
    mocks.recordGeneratedPlanCacheOutcome.mockResolvedValue(null);
    mocks.getGeneratedPlanCacheForRepair.mockResolvedValue(null);
    mocks.saveTemplate.mockResolvedValue(undefined);
    mocks.saveGeneratedPlanCache.mockResolvedValue(undefined);
    mocks.llmJson.mockReset();
  });

  it("dispatches a cached generated workflow by requestKey and preserves task account/device linkage", async () => {
    const cached = cacheRecord();
    const row = task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID, campaignId: CAMPAIGN_ID, variables: { timezone: "UTC" } });
    mockTaskDb(row);
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: true,
      stepsCompleted: 2,
      totalSteps: 2,
      output: REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      generatedWorkflow: {
        workflowId: WORKFLOW_ID,
        status: "running",
        mode: "edge",
        cacheKey: CACHE_KEY,
        requestKey: REQUEST_KEY,
        canonicalWorkflowId: "agent_generated_reddit_account_health_scan_v1",
        compiledPlanHash: cached.compiledPlanHash,
        llmBudget: { happyPathRequests: 0 },
        output: REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
        controlPlaneContext: {
          source: "task_runner",
          routine: "generated_workflow",
          taskId: TASK_ID,
          accountId: ACCOUNT_ID,
          clientId: CLIENT_ID,
          campaignId: CAMPAIGN_ID,
          deviceId: DEVICE_ID,
          platform: "reddit",
        },
      },
    });
    expect(mocks.getGeneratedPlanCacheByRequestKey).toHaveBeenCalledWith(REQUEST_KEY, { includeCandidate: false });
    expect(mocks.getGeneratedPlanCache).not.toHaveBeenCalled();
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "agent_generated_reddit_account_health_scan_v1",
      template: cached.workflow,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
    }));
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({
        ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
        timezone: "UTC",
        taskId: TASK_ID,
        generatedWorkflow: true,
        generatedWorkflowId: "agent_generated_reddit_account_health_scan_v1",
        generatedWorkflowCacheKey: CACHE_KEY,
        generatedWorkflowRequestKey: REQUEST_KEY,
        compiledPlanHash: cached.compiledPlanHash,
      }),
      logPrefix: "task-runner",
      controlPlaneContext: {
        source: "task_runner",
        routine: "generated_workflow",
        taskId: TASK_ID,
        accountId: ACCOUNT_ID,
        clientId: CLIENT_ID,
        campaignId: CAMPAIGN_ID,
        deviceId: DEVICE_ID,
        platform: "reddit",
      },
    }));
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "canonical_hit");
    expect(mocks.executionLabels).toHaveBeenCalledWith("reddit", "true", "task_runner_request_key");
    expect(mocks.llmAvoidedLabels).toHaveBeenCalledWith("reddit", "task_runner_cache_hit");
    expect(mocks.taskRunnerDispatchLabels).toHaveBeenCalledWith("generated_workflow", "request_key", "accepted");
    expect(mocks.workflowEventsPublish).toHaveBeenCalledWith(expect.objectContaining({
      source: "task_runner",
      event: "task_running",
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      status: "running",
    }));
    expect(mocks.workflowEventsPublish).toHaveBeenCalledWith(expect.objectContaining({
      source: "task_runner",
      event: "task_completed",
      workflowId: WORKFLOW_ID,
      taskId: TASK_ID,
      status: "completed",
    }));
  });

  it("fails cached dashboard human workflows that do not satisfy their PostgreSQL Goal Contract", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "fa un cont nou de gmail si da-mi aici credentialele",
        platform: "android",
      },
    });
    cached.workflow = {
      ...cached.workflow,
      id: "step-01-wake-device",
      platform: "android",
      safetyClass: "standard",
      goalContract: {
        version: "1",
        allowedEffects: ["none", "business_mutation"],
        stages: [{
          id: "perform_goal",
          required: true,
          minOccurrences: 1,
          allowedActions: ["catalog_supplied_action"],
          allowedEffects: ["business_mutation"],
        }],
      },
      steps: [
        { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
        { id: "unlock_device", type: "action", action: "unlock", params: {} },
      ],
    };
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      intent: "fa un cont nou de gmail si da-mi aici credentialele",
      source: "dashboard_human",
    }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      failReason: expect.stringContaining("human workflow undercompiled"),
      generatedWorkflow: expect.objectContaining({
        failureCode: "HUMAN_WORKFLOW_UNDERCOMPILED",
      }),
    });
    expect(mocks.dispatchGeneratedWorkflowTemplate).not.toHaveBeenCalled();
    expect(mocks.taskRunnerDispatchLabels).toHaveBeenCalledWith("generated_workflow", "request_key", "dispatch_failed");
  });

  it("does not rewrite application packages from cached workflow data", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide browserul chrome pe device si deschide un cont nou de gmail",
        platform: "android",
      },
    });
    cached.workflow = {
      ...cached.workflow,
      id: "gmail_new_account_bad_browser_package",
      platform: "android",
      safetyClass: "standard",
      steps: [
        { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
        { id: "unlock_device", type: "action", action: "unlock", params: {} },
        { id: "open_android", type: "action", action: "open_app", params: { packageName: "android" } },
        { id: "done", type: "checkpoint" },
      ],
    };
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      intent: "deschide browserul chrome pe device si deschide un cont nou de gmail",
      source: "dashboard_human",
    }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ action: "open_app", params: { packageName: "android" } }),
        ]),
      }),
    }));
  });

  it("dispatches cached workflow navigation data without application-specific rewriting", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "Deschide gmail si fa un cont nou de email pt mihai pavel",
        platform: "android",
      },
    });
    cached.workflow = {
      ...cached.workflow,
      id: "gmail_new_account_mihai_pavel",
      platform: "android",
      safetyClass: "standard",
      steps: [
        { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
        { id: "unlock_device", type: "action", action: "unlock", params: {} },
        { id: "open_gmail_web", type: "action", action: "intent_send", params: { uri: "https://mail.google.com" } },
        { id: "done", type: "checkpoint" },
      ],
    };
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      intent: "Deschide gmail si fa un cont nou de email pt mihai pavel",
      source: "dashboard_human",
      platform: "android",
    }), "android");
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result.success).toBe(true);
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "open_gmail_web",
            action: "intent_send",
            params: expect.objectContaining({ uri: "https://mail.google.com" }),
          }),
        ]),
      }),
    }));
    const dispatched = mocks.dispatchGeneratedWorkflowTemplate.mock.calls[0][0].template;
    expect(JSON.stringify(dispatched.steps)).toContain("mail.google.com");
  });

  it("materializes output schema defaults so edge checkpoints retain required result fields", async () => {
    const cached = cacheRecord();
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining(REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS),
    }));
    expect(result).toMatchObject({ output: REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS });
  });

  it("does not repair product-specific routes in cached workflows", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "Intra pe Reddit pe /AskReddit si sorteaza articolele dupa HOT iar la primul articol vreau un comentariu contextual",
      },
    });
    cached.workflow = {
      ...cached.workflow,
      id: "workflow_reddit_askreddit_hot_comment",
      steps: [
        {
          type: "action",
          id: "open_askreddit",
          action: "intent_send",
          params: { uri: "https://www.reddit.com/r/AskReddit/", packageName: "com.reddit.frontpage" },
        },
        {
          type: "action",
          id: "sort_hot",
          action: "semantic_tap",
          params: { target: "reddit_home_feed.subreddit_toolbar_search_button" },
        },
        {
          type: "action",
          id: "open_first_post_comments",
          action: "semantic_tap",
          params: { target: "reddit.first_visible_post.open_comments" },
        },
      ],
    };
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.reddit.frontpage text=r/AskReddit Add a comment Sort comments resourceId=comment_list" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
    const dispatched = mocks.dispatchGeneratedWorkflowTemplate.mock.calls[0][0];
    expect(dispatched.template.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "open_askreddit",
          action: "intent_send",
          params: expect.objectContaining({ uri: "https://www.reddit.com/r/AskReddit/" }),
        }),
        expect.objectContaining({
          action: "semantic_tap",
          params: expect.objectContaining({ target: "reddit_home_feed.subreddit_toolbar_search_button" }),
        }),
        expect.objectContaining({
          id: "open_first_post_comments",
          action: "semantic_tap",
          params: expect.objectContaining({ target: "reddit.first_visible_post.open_comments" }),
        }),
      ]),
    );
  });

  it("waits for workflow completion and materializes final checkpoint output", async () => {
    const cached = cacheRecord();
    const finalOutput = {
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      loggedIn: "true",
      homeFeedVisible: "true",
      searchSurfaceAvailable: "true",
      challengeDetected: "false",
      loginWallDetected: "false",
      accountSwitcherVisible: "false",
      screenState: "reddit_home_feed",
    };
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow(finalOutput));

    const result = await executeTaskNow(TASK_ID);

    expect(mocks.getWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
    expect(result).toMatchObject({
      success: true,
      output: finalOutput,
      generatedWorkflow: { output: finalOutput },
    });
  });

  it("does not report completed when a dashboard workflow returns null required output", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide browserul chrome si mergi pe ciprianneculai.com",
        platform: "android",
        outputContractVersion: "required-v1",
      },
    });
    cached.workflow = {
      ...cached.workflow,
      id: "open_requested_url",
      platform: "android",
      intent: "deschide browserul chrome si mergi pe ciprianneculai.com",
      outputSchema: {
        required: ["navigationResult"],
        properties: {
          navigationResult: { type: "string" },
        },
      },
      steps: [
        {
          type: "action",
          id: "open_requested_url",
          action: "intent_send",
          params: {
            action: "android.intent.action.VIEW",
            uri: "https://ciprianneculai.com",
            packageName: "com.android.chrome",
            outputVariable: "navigationResult",
          },
          effect: "navigation",
        },
      ],
    };
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      deviceId: DEVICE_ID,
      source: "dashboard_human",
      intent: "deschide browserul chrome si mergi pe ciprianneculai.com",
    }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({ navigationResult: null }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      failReason: expect.stringContaining("HUMAN_WORKFLOW_OUTPUT_INVALID"),
      generatedWorkflow: expect.objectContaining({
        failureCode: "HUMAN_WORKFLOW_OUTPUT_INVALID",
      }),
    });
  });

  it("accepts authoritative edge completion that arrives after a provisional ACK timeout", async () => {
    vi.useFakeTimers();
    process.env.GENERATED_WORKFLOW_LATE_TERMINAL_GRACE_MS = "10000";
    try {
      const cached = cacheRecord();
      let completed = false;
      mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
      mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
      mocks.getWorkflow.mockImplementation(async () => completed
        ? completedWorkflow({ ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS, screenState: "reddit_home_feed" })
        : {
            ...completedWorkflow(),
            status: "failed",
            currentStep: 0,
            error: "Edge workflow did not acknowledge WORKFLOW_START within 20000ms",
          });

      const pending = executeTaskNow(TASK_ID);
      await vi.advanceTimersByTimeAsync(2_001);
      completed = true;
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;

      expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
      expect(mocks.recordGeneratedPlanCacheOutcome).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
      }));
    } finally {
      delete process.env.GENERATED_WORKFLOW_LATE_TERMINAL_GRACE_MS;
      vi.useRealTimers();
    }
  });

  it("cancels a workflow that remains queued until the PNQ wait timeout", async () => {
    vi.useFakeTimers();
    try {
      const cached = cacheRecord();
      let cancelled = false;
      mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
      mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
      mocks.getWorkflow.mockImplementation(async () => ({
        ...completedWorkflow(),
        status: cancelled ? "cancelled" : "queued",
        currentStep: 0,
        completedAt: cancelled ? new Date().toISOString() : null,
      }));
      mocks.cancelPersistedWorkflowSafely.mockImplementation(async () => {
        cancelled = true;
        return { workflowId: WORKFLOW_ID, status: "cancelled" as const };
      });

      const pending = executeTaskNow(TASK_ID);
      await vi.advanceTimersByTimeAsync(180_001);
      const result = await pending;

      expect(mocks.cancelPersistedWorkflowSafely).toHaveBeenCalledTimes(1);
      expect(mocks.cancelPersistedWorkflowSafely).toHaveBeenCalledWith(WORKFLOW_ID);
      expect(result).toMatchObject({
        success: false,
        generatedWorkflow: { workflowId: WORKFLOW_ID },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting without redispatch when the PNQ queue pump wins the timeout race", async () => {
    vi.useFakeTimers();
    try {
      const cached = cacheRecord();
      let queuePumpWon = false;
      mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
      mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
      mocks.getWorkflow.mockImplementation(async () => ({
        ...completedWorkflow(),
        status: queuePumpWon ? "completed" : "queued",
        currentStep: queuePumpWon ? 2 : 0,
      }));
      mocks.cancelPersistedWorkflowSafely.mockImplementation(async () => {
        queuePumpWon = true;
        throw Object.assign(new Error("workflow became active"), {
          code: "CANCELLATION_UNSUPPORTED_IN_FLIGHT",
          status: 409,
        });
      });

      const pending = executeTaskNow(TASK_ID);
      await vi.advanceTimersByTimeAsync(180_001);
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;

      expect(mocks.cancelPersistedWorkflowSafely).toHaveBeenCalledTimes(1);
      expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry or redispatch while the original workflow remains active past the observer warning", async () => {
    vi.useFakeTimers();
    try {
      const cached = cacheRecord();
      let completed = false;
      mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
      mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
      mocks.getWorkflow.mockImplementation(async () => ({
        ...completedWorkflow(),
        status: completed ? "completed" : "running",
        currentStep: completed ? 2 : 1,
        completedAt: completed ? new Date().toISOString() : null,
      }));

      const pending = executeTaskNow(TASK_ID);
      await vi.advanceTimersByTimeAsync(180_001);
      completed = true;
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;

      expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a repaired generated workflow candidate after failure", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "Deschide Gmail si verifica inbox",
        workflowLearning: {
          failureCount: 1,
          lastOutcome: "failure",
        },
      },
    });
    const repairedWorkflow: WorkflowTemplate = {
      ...cached.workflow,
      id: "agent_generated_gmail_inbox_repair_v2",
      name: "Gmail inbox repair",
      platform: "android",
      intent: "gmail_open_inbox",
      version: "1.0.1",
      steps: [
        { type: "action", id: "wake_screen", action: "screen_wake", params: {} },
        { type: "action", id: "unlock_device", action: "unlock", params: {} },
        { type: "action", id: "open_gmail", action: "open_app", params: { packageName: "com.google.android.gm" } },
        { type: "checkpoint", id: "gmail_opened" },
      ],
    };
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      source: "dashboard_human",
      allowCandidateArtifact: true,
      maxSelfHealingAttempts: 1,
      agencyWorkflowRunId: TASK_ID,
      intent: "Deschide Gmail si verifica inbox",
    }), "android");
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow
      .mockResolvedValueOnce(failedWorkflow("RECOVERY_BUDGET_EXCEEDED"))
      .mockResolvedValueOnce(completedWorkflow({
        ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
        screenState: "gmail_inbox",
      }));
    mocks.recordGeneratedPlanCacheOutcome.mockResolvedValue({
      ...cached,
      artifactState: "failed",
      sourceMetadata: {
        ...cached.sourceMetadata,
        workflowLearning: {
          failureCount: 2,
          lastOutcome: "failure",
        },
      },
    });
    mocks.getGeneratedPlanCacheForRepair.mockResolvedValue({
      ...cached,
      artifactState: "failed",
      sourceMetadata: {
        ...cached.sourceMetadata,
        workflowLearning: {
          failureCount: 2,
          lastOutcome: "failure",
        },
      },
    });
    mocks.llmJson.mockResolvedValue({
      workflow: repairedWorkflow,
      rationale: "Open the native Gmail app after unlock and checkpoint the reached inbox surface.",
      expectedFix: "Avoid retrying the old failing navigation path.",
      confidence: 0.82,
    });
    mocks.getGeneratedPlanCache.mockImplementation(async (cacheKey: string) => ({
      ...cached,
      cacheKey,
      artifactState: "candidate",
      sourceMetadata: {
        source: "llm_repair",
        intent: "Deschide Gmail si verifica inbox",
        repairOfCacheKey: CACHE_KEY,
      },
      workflow: repairedWorkflow,
      compiledPlan: {
        ...cached.compiledPlan,
        cacheKey,
        templateId: repairedWorkflow.id,
        platform: repairedWorkflow.platform,
        templateVersion: repairedWorkflow.version,
        stepCount: 4,
        actionCount: 3,
        checkpointCount: 1,
      },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: true,
      generatedWorkflow: expect.objectContaining({
        selfHealing: expect.objectContaining({
          status: "recovered",
          attempts: 1,
          sourceCacheKeys: [CACHE_KEY],
          repairedCacheKeys: [expect.any(String)],
        }),
      }),
    });
    expect(mocks.recordGeneratedPlanCacheOutcome).toHaveBeenCalledWith(expect.objectContaining({
      cacheKey: CACHE_KEY,
      success: false,
      reason: "RECOVERY_BUDGET_EXCEEDED",
      taskId: TASK_ID,
      workflowId: WORKFLOW_ID,
    }));
    expect(mocks.recordGeneratedPlanCacheOutcome).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      taskId: TASK_ID,
      workflowId: WORKFLOW_ID,
    }));
    expect(mocks.llmJson).toHaveBeenCalledWith(
      expect.stringContaining("A generated Android workflow failed"),
      undefined,
      expect.objectContaining({ system: expect.stringContaining("repair failed Android") }),
    );
    expect(mocks.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({
      id: "agent_generated_gmail_inbox_repair_v2",
    }));
    expect(mocks.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent_generated_gmail_inbox_repair_v2" }),
      expect.objectContaining({
        cacheKey: expect.any(String),
        llmBudget: { happyPathRequests: 0, recoveryRequests: "only_on_failure" },
      }),
      REQUEST_KEY,
      expect.objectContaining({
        artifactState: "candidate",
        replaceRequestKeyArtifacts: false,
        sourceMetadata: expect.objectContaining({
          source: "llm_repair",
          repairOfCacheKey: CACHE_KEY,
          workflowRepair: expect.objectContaining({
            status: "candidate_generated",
            nextAction: "retry_task_with_repaired_candidate",
            reason: "RECOVERY_BUDGET_EXCEEDED",
          }),
        }),
      }),
    );
    const repairedCacheKey = mocks.saveGeneratedPlanCache.mock.calls[0][1].cacheKey;
    expect(mocks.getGeneratedPlanCache).toHaveBeenCalledWith(repairedCacheKey, { includeCandidate: true });
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledTimes(2);
  });

  it("does not apply server-side product evidence rules", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide reddit si mergi pe /askreddit",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "open_askreddit",
        action: "intent_send",
        params: { uri: "https://www.reddit.com/r/AskReddit/", packageName: "com.reddit.frontpage" },
      },
      {
        type: "action",
        id: "capture_final_ui_tree",
        action: "ui_tree_dump",
        params: { packageName: "com.reddit.frontpage", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({}));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("accepts dashboard human AskReddit workflows with matching final UI evidence", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide reddit si mergi pe /askreddit",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "open_askreddit",
        action: "intent_send",
        params: { uri: "https://www.reddit.com/r/AskReddit/", packageName: "com.reddit.frontpage" },
      },
      {
        type: "action",
        id: "capture_final_ui_tree",
        action: "ui_tree_dump",
        params: { packageName: "com.reddit.frontpage", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.reddit.frontpage text=r/AskReddit" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("leaves final-state validation to workflow-declared edge conditions", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide reddit si mergi pe r/GreeceTravel si intra pe sectiunea de comentarii a primului articol afisat",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "tap_first_post_comments",
        action: "semantic_tap",
        params: { target: "reddit.first_visible_post.open_comments", waitMs: 2000 },
      },
      {
        type: "action",
        id: "capture_final_ui_tree",
        action: "ui_tree_dump",
        params: { packageName: "com.reddit.frontpage", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.reddit.frontpage resourceId=inbox_screen text=Activity Notifications Chats" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("accepts dashboard human Reddit comments workflows with comments detail evidence", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "deschide reddit si mergi pe r/GreeceTravel si intra pe sectiunea de comentarii a primului articol afisat",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "tap_first_post_comments",
        action: "semantic_tap",
        params: { target: "reddit.first_visible_post.open_comments", waitMs: 2000 },
      },
      {
        type: "action",
        id: "capture_final_ui_tree",
        action: "ui_tree_dump",
        params: { packageName: "com.reddit.frontpage", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.reddit.frontpage resourceId=comment_list text=Sort comments Add a comment" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("does not infer install failure from product-specific UI text", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "instaleaza reddit pe acest device",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "open_reddit_play_store",
        action: "intent_send",
        params: { uri: "market://details?id=com.reddit.frontpage", packageName: "com.android.vending" },
      },
      {
        type: "action",
        id: "capture_install_state",
        action: "ui_tree_dump",
        params: { packageName: "com.android.vending", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID, accountId: null }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.android.vending text=Sign in Add account Google account" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("does not infer install completion from product-specific UI text", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "instaleaza reddit pe acest device",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "open_reddit_play_store",
        action: "intent_send",
        params: { uri: "market://details?id=com.reddit.frontpage", packageName: "com.android.vending" },
      },
      {
        type: "action",
        id: "capture_install_state",
        action: "ui_tree_dump",
        params: { packageName: "com.android.vending", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID, accountId: null }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.android.vending text=Reddit Install About this app" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("accepts dashboard human app install workflows with installed evidence", async () => {
    const cached = cacheRecord({
      sourceMetadata: {
        source: "dashboard_human",
        intent: "instaleaza reddit pe acest device",
      },
    });
    cached.workflow.steps = [
      {
        type: "action",
        id: "open_reddit_play_store",
        action: "intent_send",
        params: { uri: "market://details?id=com.reddit.frontpage", packageName: "com.android.vending" },
      },
      {
        type: "action",
        id: "capture_install_state",
        action: "ui_tree_dump",
        params: { packageName: "com.android.vending", outputVariable: "_finalUiTree" },
      },
    ];
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID, accountId: null }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);
    mocks.getWorkflow.mockResolvedValue(completedWorkflow({
      ...REDDIT_ACCOUNT_HEALTH_OUTPUT_DEFAULTS,
      _finalUiTree: { uiTree: "package=com.android.vending text=Reddit Open Uninstall" },
    }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
  });

  it("dispatches a cached generated workflow by cacheKey", async () => {
    const cached = cacheRecord();
    mockTaskDb(task({ cacheKey: CACHE_KEY }));
    mocks.getGeneratedPlanCache.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
    expect(mocks.getGeneratedPlanCache).toHaveBeenCalledWith(CACHE_KEY, { includeCandidate: false });
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "cache_hit");
    expect(mocks.executionLabels).toHaveBeenCalledWith("reddit", "true", "task_runner_cache_key");
  });

  it("allows candidate lookup only for explicit dashboard human first-run tasks", async () => {
    const cached = cacheRecord({ artifactState: "candidate" });
    mockTaskDb(task({
      requestKey: REQUEST_KEY,
      source: "dashboard_human",
      allowCandidateArtifact: true,
      agencyWorkflowRunId: TASK_ID,
    }));
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
    expect(mocks.getGeneratedPlanCacheByRequestKey).toHaveBeenCalledWith(REQUEST_KEY, { includeCandidate: true });
  });

  it("rejects workflow payloads without cache lookup or dispatch", async () => {
    mockTaskDb(task({ requestKey: REQUEST_KEY, workflow: generatedWorkflow() }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      generatedWorkflow: { failureCode: "WORKFLOW_PAYLOAD_NOT_ALLOWED" },
    });
    expect(mocks.getGeneratedPlanCacheByRequestKey).not.toHaveBeenCalled();
    expect(mocks.dispatchGeneratedWorkflowTemplate).not.toHaveBeenCalled();
  });

  it("rejects tasks that provide both cacheKey and requestKey", async () => {
    mockTaskDb(task({ cacheKey: CACHE_KEY, requestKey: REQUEST_KEY }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      generatedWorkflow: { failureCode: "GENERATED_WORKFLOW_EXACTLY_ONE_KEY_REQUIRED" },
    });
    expect(mocks.getGeneratedPlanCache).not.toHaveBeenCalled();
    expect(mocks.getGeneratedPlanCacheByRequestKey).not.toHaveBeenCalled();
    expect(mocks.dispatchGeneratedWorkflowTemplate).not.toHaveBeenCalled();
  });

  it("returns a structured miss before dispatch", async () => {
    mockTaskDb(task({ cacheKey: CACHE_KEY }));
    mocks.getGeneratedPlanCache.mockResolvedValue(null);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      generatedWorkflow: { failureCode: "GENERATED_WORKFLOW_CACHE_MISS" },
    });
    expect(mocks.dispatchGeneratedWorkflowTemplate).not.toHaveBeenCalled();
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "miss");
    expect(mocks.taskRunnerDispatchLabels).toHaveBeenCalledWith("generated_workflow", "cache_key", "miss");
  });

  it("rejects invalid or ambiguous task device ids before cache lookup", async () => {
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: "33333333" }, { device_id: "33333333" }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      generatedWorkflow: { failureCode: "DEVICE_ID_INVALID_OR_AMBIGUOUS" },
    });
    expect(mocks.getGeneratedPlanCacheByRequestKey).not.toHaveBeenCalled();
    expect(mocks.dispatchGeneratedWorkflowTemplate).not.toHaveBeenCalled();
  });
});

describe("task-runner compiled_workflow routine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({ query: mocks.dbQuery } as any);
    mocks.isDeviceOnline.mockReturnValue(true);
  });

  it("executes a compiled workflow only after the task runner owns the device lock", async () => {
    const compiledWorkflow = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Queued recovery canary",
      source: "read-only canary",
      appId: "com.example.app",
      compiledAt: "2026-07-21T00:00:00.000Z",
      steps: [{
        id: "observe",
        action: "screenshot",
        expectedPage: "home",
        expectedPageHash: "abc123",
        retries: 0,
        retryDelay: 0,
        description: "Read-only observation",
      }],
      appMapVersion: "1",
      startPage: "home",
      maxRecoveryAttempts: 1,
      maxTotalRecoveryAttempts: 1,
    };
    const row = task(
      { compiledWorkflow, compileLlmCalls: 0, disableTaskRetry: true },
      { account_id: null, routine: "compiled_workflow" },
    );
    mocks.dbQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValue({ rows: [] });
    mocks.compiledWorkflowToEdgeTemplate.mockResolvedValueOnce({
      id: compiledWorkflow.id,
      name: compiledWorkflow.name,
      platform: compiledWorkflow.appId,
      description: compiledWorkflow.source,
      version: "compiled-1",
      runtimeContract: "edge-workflow/v2",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 0,
      steps: [{ type: "action", id: "observe", action: "screenshot", params: {} }],
    });
    mocks.dispatchGeneratedWorkflowTemplate.mockResolvedValueOnce({
      workflowId: WORKFLOW_ID,
      status: "running",
      mode: "edge",
      templateId: compiledWorkflow.id,
    });
    mocks.getWorkflow.mockResolvedValueOnce({
      id: WORKFLOW_ID,
      status: "completed",
      currentStep: 1,
      totalSteps: 1,
      checkpoint: { variables: { observed: true } },
      error: null,
    });

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: true,
      stepsCompleted: 1,
      totalSteps: 1,
      output: {
        workflowId: WORKFLOW_ID,
        status: "completed",
        mode: "edge",
        runtimeContract: "edge-workflow/v2",
      },
    });
    expect(mocks.compiledWorkflowToEdgeTemplate).toHaveBeenCalledWith(compiledWorkflow);
    expect(mocks.saveTemplate).toHaveBeenCalledWith(expect.objectContaining({
      id: compiledWorkflow.id,
      runtimeContract: "edge-workflow/v2",
    }));
    expect(mocks.saveTemplate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchGeneratedWorkflowTemplate.mock.invocationCallOrder[0],
    );
    expect(mocks.dispatchGeneratedWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      templateId: compiledWorkflow.id,
      template: expect.objectContaining({ runtimeContract: "edge-workflow/v2" }),
    }));
  });
});
