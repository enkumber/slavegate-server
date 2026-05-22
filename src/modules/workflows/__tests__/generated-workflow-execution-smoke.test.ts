import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { WorkflowTemplate } from "../types";
import { compileGeneratedWorkflowTemplate } from "../workflow-validator";

const mocks = vi.hoisted(() => {
  const executionInc = vi.fn();
  const executionLabels = vi.fn(() => ({ inc: executionInc }));
  const llmAvoidedInc = vi.fn();
  const llmAvoidedLabels = vi.fn(() => ({ inc: llmAvoidedInc }));
  const cacheLookupInc = vi.fn();
  const cacheLookupLabels = vi.fn(() => ({ inc: cacheLookupInc }));

  return {
    workflowService: {
      getGeneratedPlanCache: vi.fn(),
      getGeneratedPlanCacheByRequestKey: vi.fn(),
      saveTemplate: vi.fn(),
      saveGeneratedPlanCache: vi.fn(),
      countActiveByDevice: vi.fn(),
      countByStatus: vi.fn(),
      create: vi.fn(),
      markRunning: vi.fn(),
      markFailed: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      getTemplate: vi.fn(),
      listTemplates: vi.fn(),
    },
    directWsServer: {
      supportsEdgeExecution: vi.fn(),
      sendWorkflowStart: vi.fn(),
      getAgentVersion: vi.fn(),
      sendWorkflowCancel: vi.fn(),
      getConnectedDeviceIds: vi.fn(),
      broadcastTemplate: vi.fn(),
    },
    hbeService: {
      initSession: vi.fn(),
    },
    metrics: {
      executionInc,
      executionLabels,
      llmAvoidedInc,
      llmAvoidedLabels,
      cacheLookupInc,
      cacheLookupLabels,
    },
  };
});

vi.mock("../../../modules/devices/devices.service", () => ({ devicesService: {} }));
vi.mock("../../../modules/dispatcher/dispatcher.service", () => ({ dispatcherService: {} }));
vi.mock("../../../modules/auth/auth.service", () => ({ authService: {} }));
vi.mock("../../../ws/direct-ws.server", () => ({ directWsServer: mocks.directWsServer }));
vi.mock("../../../transport/transport", () => ({
  sendJobToDevice: vi.fn(),
  isDeviceOnline: vi.fn(() => true),
}));
vi.mock("../../../modules/app-mapping/recorder.service", () => ({ loadMap: vi.fn() }));
vi.mock("../../../modules/workflows/workflow.service", () => ({
  workflowService: mocks.workflowService,
}));
vi.mock("../../../modules/workflows/workflow.executor", () => ({ startWorkflow: vi.fn() }));
vi.mock("../../../modules/hbe/hbe.service", () => ({ hbeService: mocks.hbeService }));
vi.mock("../../../modules/accounts/accounts.service", () => ({ accountsService: {} }));
vi.mock("../../../modules/data-pipeline/data-pipeline.service", () => ({ dataPipelineService: {} }));
vi.mock("../../../modules/vision/vision.service", () => ({ visionService: {} }));
vi.mock("../../../modules/model-config/model-config.service", () => ({
  modelConfigService: {},
  ModelConfigError: class ModelConfigError extends Error {},
}));
vi.mock("../../../modules/observability/metrics", () => ({
  generatedWorkflowCacheLookups: { labels: mocks.metrics.cacheLookupLabels },
  generatedWorkflowExecutions: { labels: mocks.metrics.executionLabels },
  generatedWorkflowLlmAvoided: { labels: mocks.metrics.llmAvoidedLabels },
  registry: null,
  refreshAccountMetrics: vi.fn(),
  killSwitchActive: { set: vi.fn() },
}));
vi.mock("../../../modules/canary/canary.service", () => ({ canaryService: {} }));
vi.mock("../../../modules/observability/alerts", () => ({
  alerting: {},
  AlertType: {},
}));
vi.mock("../../../db/client", () => ({ getDb: vi.fn() }));
vi.mock("../../../config/scalability.config", () => ({
  scalabilityConfig: {
    requestTimeout: 30_000,
    rateLimitPerMinute: 1000,
    maxWorkflowsPerDevice: 10,
    maxGlobalConcurrentWorkflows: 100,
  },
}));
vi.mock("../../../modules/skill-updater", () => ({
  processSkillUpdateJobs: vi.fn(),
  checkAndRollback: vi.fn(),
}));
vi.mock("../../../modules/nautilus/pipeline", () => ({ runNightlyPipeline: vi.fn() }));

function redditHomeWorkflow(): WorkflowTemplate {
  return {
    id: "agent_generated_reddit_home_smoke_v1",
    name: "Agent generated Reddit home smoke",
    platform: "reddit",
    description: "Non-mutating generated workflow for cache-only execution tests.",
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
        type: "checkpoint",
        id: "reddit_home_loaded",
        reason: "Home feed reached",
      },
    ],
  };
}

function cacheRecord() {
  const workflow = redditHomeWorkflow();
  const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
  return {
    cacheKey: compiledPlan.cacheKey,
    requestKey: "c02c59dfbe512562f8c65c97",
    templateId: workflow.id,
    canonicalWorkflowId: workflow.id,
    canonicalWorkflowVersion: workflow.version,
    compiledPlanHash: "hash-test",
    sourceMetadata: { source: "test" },
    platform: workflow.platform,
    templateVersion: workflow.version,
    workflow,
    compiledPlan,
    hitCount: 4,
    createdAt: "2026-05-21T18:00:00.000Z",
    updatedAt: "2026-05-21T18:10:00.000Z",
    lastUsedAt: "2026-05-21T18:20:00.000Z",
  };
}

async function postGeneratedWorkflow(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  process.env.API_KEY = "test-api-key";
  const { default: router } = await import("../../../api/routes");
  const app = express();
  app.use(express.json());
  app.use("/api", router);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a port");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/generated`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-api-key",
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: await response.json() as any,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("generated workflow cache-only execution route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.workflowService.saveTemplate.mockResolvedValue(undefined);
    mocks.workflowService.saveGeneratedPlanCache.mockResolvedValue(undefined);
    mocks.workflowService.countActiveByDevice.mockResolvedValue(0);
    mocks.workflowService.countByStatus.mockResolvedValue(0);
    mocks.workflowService.create.mockResolvedValue({ id: "wf-cache-smoke" });
    mocks.workflowService.markRunning.mockResolvedValue(undefined);
    mocks.directWsServer.supportsEdgeExecution.mockReturnValue(true);
    mocks.directWsServer.sendWorkflowStart.mockReturnValue(true);
    mocks.directWsServer.getConnectedDeviceIds.mockReturnValue([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "22222222-3333-4333-8333-333333333333",
    ]);
    mocks.directWsServer.getAgentVersion.mockReturnValue("4.0.0");
    mocks.hbeService.initSession.mockReturnValue({});
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  it("accepts cacheKey-only execution and records low-cardinality smoke metrics", async () => {
    const cached = cacheRecord();
    mocks.workflowService.getGeneratedPlanCache.mockResolvedValue(cached);

    const response = await postGeneratedWorkflow({
      cacheKey: cached.cacheKey,
      deviceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status, JSON.stringify(response.json)).toBe(202);
    expect(response.json.data).toMatchObject({
      generated: true,
      cacheHit: true,
      canonicalHit: true,
      canExecuteFromCache: true,
      cacheKey: cached.cacheKey,
      requestKey: cached.requestKey,
      canonicalWorkflowId: cached.canonicalWorkflowId,
      canonicalWorkflowVersion: cached.canonicalWorkflowVersion,
      compiledPlanHash: cached.compiledPlanHash,
      compiledPlan: {
        llmBudget: {
          happyPathRequests: 0,
        },
      },
    });
    expect(mocks.workflowService.getGeneratedPlanCache).toHaveBeenCalledWith(cached.cacheKey);
    expect(mocks.directWsServer.sendWorkflowStart).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      cached.workflow,
      expect.objectContaining({
        generatedWorkflow: true,
        generatedWorkflowId: cached.templateId,
      }),
      "wf-cache-smoke",
    );
    expect(mocks.workflowService.create).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        executionStats: expect.objectContaining({
          recoveryLlmCalls: 0,
          runtimeLlmCalls: 0,
          recoveryAttempts: 0,
          recoveryBudgetExhausted: 0,
        }),
      }),
    }));
    expect(mocks.metrics.executionLabels).toHaveBeenCalledWith("reddit", "true", "cache_key");
    expect(mocks.metrics.executionInc).toHaveBeenCalledTimes(1);
    expect(mocks.metrics.llmAvoidedLabels).toHaveBeenCalledWith("reddit", "cache_hit");
    expect(mocks.metrics.llmAvoidedInc).toHaveBeenCalledTimes(1);
  });

  it("accepts requestKey-only execution without a workflow body", async () => {
    const cached = cacheRecord();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const response = await postGeneratedWorkflow({
      requestKey: cached.requestKey,
      deviceId: "11111111",
    });

    expect(response.status, JSON.stringify(response.json)).toBe(202);
    expect(response.json.data).toMatchObject({
      generated: true,
      cacheHit: true,
      canonicalHit: true,
      canExecuteFromCache: true,
      cacheKey: cached.cacheKey,
      requestKey: cached.requestKey,
      compiledPlan: {
        llmBudget: {
          happyPathRequests: 0,
        },
      },
    });
    expect(mocks.workflowService.getGeneratedPlanCacheByRequestKey).toHaveBeenCalledWith(cached.requestKey);
    expect(mocks.directWsServer.sendWorkflowStart).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      cached.workflow,
      expect.any(Object),
      "wf-cache-smoke",
    );
    expect(mocks.metrics.executionLabels).toHaveBeenCalledWith("reddit", "true", "request_key");
    expect(mocks.metrics.llmAvoidedLabels).toHaveBeenCalledWith("reddit", "cache_hit");
  });

  it("rejects workflow payloads in canonical cache execution mode", async () => {
    const cached = cacheRecord();

    const response = await postGeneratedWorkflow({
      requestKey: cached.requestKey,
      workflow: cached.workflow,
      deviceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      ok: false,
      code: "WORKFLOW_PAYLOAD_NOT_ALLOWED_FOR_CANONICAL_EXECUTION",
    });
    expect(mocks.workflowService.getGeneratedPlanCacheByRequestKey).not.toHaveBeenCalled();
    expect(mocks.directWsServer.sendWorkflowStart).not.toHaveBeenCalled();
  });

  it("rejects ambiguous short device id prefixes before database writes", async () => {
    const cached = cacheRecord();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const response = await postGeneratedWorkflow({
      requestKey: cached.requestKey,
      deviceId: "22222222",
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      ok: false,
      code: "DEVICE_ID_AMBIGUOUS",
    });
    expect(mocks.workflowService.create).not.toHaveBeenCalled();
    expect(mocks.directWsServer.sendWorkflowStart).not.toHaveBeenCalled();
  });

  it("rejects unknown non-uuid device ids before database writes", async () => {
    const cached = cacheRecord();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cached);

    const response = await postGeneratedWorkflow({
      requestKey: cached.requestKey,
      deviceId: "missing1",
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      ok: false,
      code: "DEVICE_NOT_FOUND",
    });
    expect(mocks.workflowService.create).not.toHaveBeenCalled();
    expect(mocks.directWsServer.sendWorkflowStart).not.toHaveBeenCalled();
  });
});
