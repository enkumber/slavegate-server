import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTaskNow } from "./task-runner.service";
import { getDb } from "../../db/client";
import { isDeviceOnline } from "../../transport/transport";
import { agentOrchestrator } from "../agents/orchestrator";
import { directWsServer } from "../../ws/direct-ws.server";
import { workflowService } from "../workflows/workflow.service";
import type { TaskRow } from "./task-runner.service";
import type { WorkflowTemplate } from "../workflows/types";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  isDeviceOnline: vi.fn(),
  agentExecuteTask: vi.fn(),
  supportsEdgeExecution: vi.fn(),
  sendWorkflowStart: vi.fn(),
  getAgentVersion: vi.fn(),
  initSession: vi.fn(),
  startWorkflow: vi.fn(),
  cacheLookupLabels: vi.fn(() => ({ inc: vi.fn() })),
  executionLabels: vi.fn(() => ({ inc: vi.fn() })),
  llmAvoidedLabels: vi.fn(() => ({ inc: vi.fn() })),
  taskRunnerDispatchLabels: vi.fn(() => ({ inc: vi.fn() })),
  getGeneratedPlanCache: vi.fn(),
  getGeneratedPlanCacheByRequestKey: vi.fn(),
  countActiveByDevice: vi.fn(),
  countByStatus: vi.fn(),
  createWorkflow: vi.fn(),
  markRunning: vi.fn(),
  markFailed: vi.fn(),
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

vi.mock("../../ws/direct-ws.server", () => ({
  directWsServer: {
    supportsEdgeExecution: mocks.supportsEdgeExecution,
    sendWorkflowStart: mocks.sendWorkflowStart,
    getAgentVersion: mocks.getAgentVersion,
  },
}));

vi.mock("../hbe/hbe.service", () => ({
  hbeService: { initSession: mocks.initSession },
}));

vi.mock("../workflows/workflow.executor", () => ({
  startWorkflow: mocks.startWorkflow,
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
    countActiveByDevice: mocks.countActiveByDevice,
    countByStatus: mocks.countByStatus,
    create: mocks.createWorkflow,
    markRunning: mocks.markRunning,
    markFailed: mocks.markFailed,
  },
}));

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_KEY = "c02c59dfbe512562f8c65c97";
const CACHE_KEY = "56d91a7aa0e90314241896a2";

function generatedWorkflow(): WorkflowTemplate {
  return {
    id: "agent_generated_reddit_home_smoke_v1",
    name: "Agent generated Reddit home smoke",
    platform: "reddit",
    description: "Non-mutating generated workflow for task-runner tests.",
    version: "1.0.0",
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
    .mockResolvedValueOnce({ rows: [{ platform }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe("task-runner generated_workflow routine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({ query: mocks.dbQuery } as any);
    mocks.isDeviceOnline.mockReturnValue(true);
    mocks.supportsEdgeExecution.mockReturnValue(true);
    mocks.sendWorkflowStart.mockReturnValue(true);
    mocks.initSession.mockReturnValue({});
    mocks.countActiveByDevice.mockResolvedValue(0);
    mocks.countByStatus.mockResolvedValue(0);
    mocks.createWorkflow.mockResolvedValue({ id: WORKFLOW_ID });
  });

  it("dispatches a cached generated workflow by requestKey and preserves task account/device linkage", async () => {
    const cached = cacheRecord();
    const row = task({ requestKey: REQUEST_KEY, deviceId: DEVICE_ID, variables: { timezone: "UTC" } });
    mockTaskDb(row);
    mocks.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: true,
      stepsCompleted: 2,
      totalSteps: 2,
      generatedWorkflow: {
        workflowId: WORKFLOW_ID,
        status: "running",
        mode: "edge",
        cacheKey: CACHE_KEY,
        requestKey: REQUEST_KEY,
        canonicalWorkflowId: "agent_generated_reddit_home_smoke_v1",
        compiledPlanHash: cached.compiledPlanHash,
        llmBudget: { happyPathRequests: 0 },
      },
    });
    expect(mocks.getGeneratedPlanCacheByRequestKey).toHaveBeenCalledWith(REQUEST_KEY);
    expect(mocks.getGeneratedPlanCache).not.toHaveBeenCalled();
    expect(mocks.agentExecuteTask).not.toHaveBeenCalled();
    expect(mocks.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "agent_generated_reddit_home_smoke_v1",
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      totalSteps: 2,
    }));
    expect(mocks.sendWorkflowStart).toHaveBeenCalledWith(
      DEVICE_ID,
      cached.workflow,
      expect.objectContaining({
        taskId: TASK_ID,
        generatedWorkflow: true,
        generatedWorkflowId: "agent_generated_reddit_home_smoke_v1",
        generatedWorkflowCacheKey: CACHE_KEY,
        generatedWorkflowRequestKey: REQUEST_KEY,
        compiledPlanHash: cached.compiledPlanHash,
      }),
      WORKFLOW_ID,
    );
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "canonical_hit");
    expect(mocks.executionLabels).toHaveBeenCalledWith("reddit", "true", "task_runner_request_key");
    expect(mocks.llmAvoidedLabels).toHaveBeenCalledWith("reddit", "task_runner_cache_hit");
    expect(mocks.taskRunnerDispatchLabels).toHaveBeenCalledWith("reddit", "request_key", "accepted");
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
    expect(mocks.sendWorkflowStart).not.toHaveBeenCalled();
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
    expect(mocks.sendWorkflowStart).not.toHaveBeenCalled();
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
    expect(mocks.sendWorkflowStart).not.toHaveBeenCalled();
    expect(mocks.createWorkflow).not.toHaveBeenCalled();
    expect(mocks.cacheLookupLabels).toHaveBeenCalledWith("task_runner", "miss");
    expect(mocks.taskRunnerDispatchLabels).toHaveBeenCalledWith("reddit", "cache_key", "miss");
  });

  it("rejects invalid or ambiguous task device ids before cache lookup", async () => {
    mockTaskDb(task({ requestKey: REQUEST_KEY, deviceId: "33333333" }, { device_id: "33333333" }));

    const result = await executeTaskNow(TASK_ID);

    expect(result).toMatchObject({
      success: false,
      generatedWorkflow: { failureCode: "DEVICE_ID_INVALID_OR_AMBIGUOUS" },
    });
    expect(mocks.getGeneratedPlanCacheByRequestKey).not.toHaveBeenCalled();
    expect(mocks.sendWorkflowStart).not.toHaveBeenCalled();
  });
});
