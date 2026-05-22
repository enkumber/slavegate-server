import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTaskNow } from "./task-runner.service";
import { getDb } from "../../db/client";
import { agentOrchestrator } from "../agents/orchestrator";
import type { TaskRow } from "./task-runner.service";
import type { WorkflowTemplate } from "../workflows/types";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  isDeviceOnline: vi.fn(),
  agentExecuteTask: vi.fn(),
  dispatchGeneratedWorkflowTemplate: vi.fn(),
  cacheLookupLabels: vi.fn(() => ({ inc: vi.fn() })),
  executionLabels: vi.fn(() => ({ inc: vi.fn() })),
  llmAvoidedLabels: vi.fn(() => ({ inc: vi.fn() })),
  taskRunnerDispatchLabels: vi.fn(() => ({ inc: vi.fn() })),
  getGeneratedPlanCache: vi.fn(),
  getGeneratedPlanCacheByRequestKey: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: mocks.dbQuery })),
}));

vi.mock("../../transport/transport", () => ({
  isDeviceOnline: mocks.isDeviceOnline,
}));

vi.mock("../agents/orchestrator", () => ({
  agentOrchestrator: { executeTask: mocks.agentExecuteTask },
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
  },
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
    expect(mocks.getGeneratedPlanCacheByRequestKey).toHaveBeenCalledWith(REQUEST_KEY);
    expect(mocks.getGeneratedPlanCache).not.toHaveBeenCalled();
    expect(mocks.agentExecuteTask).not.toHaveBeenCalled();
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

  it("dispatches a cached generated workflow by cacheKey", async () => {
    const cached = cacheRecord();
    mockTaskDb(task({ cacheKey: CACHE_KEY }));
    mocks.getGeneratedPlanCache.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({ success: true });
    expect(mocks.getGeneratedPlanCache).toHaveBeenCalledWith(CACHE_KEY);
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "cache_hit");
    expect(mocks.executionLabels).toHaveBeenCalledWith("reddit", "true", "task_runner_cache_key");
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
    expect(mocks.agentExecuteTask).not.toHaveBeenCalled();
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
    expect(mocks.agentExecuteTask).not.toHaveBeenCalled();
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
