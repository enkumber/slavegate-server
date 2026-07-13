import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../../db/client";
import { WorkflowService } from "../workflow.service";
import type { WorkflowTemplate } from "../types";
import {
  compileGeneratedWorkflowTemplate,
  computeGeneratedWorkflowCompiledPlanHash,
  summarizeGeneratedWorkflowTemplate,
  validateGeneratedWorkflowTemplate,
} from "../workflow-validator";

vi.mock("../../../db/client", () => ({
  getDb: vi.fn(),
}));

function redditHomeWorkflow(): WorkflowTemplate {
  return {
    id: "agent_generated_reddit_home_smoke_v1",
    name: "Agent generated Reddit home smoke",
    platform: "reddit",
    description: "Non-mutating generated workflow for cache-first tests.",
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

function redditAccountHealthWorkflow(): WorkflowTemplate {
  return {
    ...redditHomeWorkflow(),
    id: "agent_generated_reddit_account_health_v1",
    name: "Agent generated Reddit account health",
    description: "Read-only generated workflow for Reddit account health.",
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
  };
}

function cacheRow(overrides: Record<string, unknown> = {}) {
  const workflow = redditHomeWorkflow();
  const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
  return {
    cache_key: compiledPlan.cacheKey,
    request_key: "c02c59dfbe512562f8c65c97",
    canonical_workflow_id: workflow.id,
    canonical_workflow_version: workflow.version,
    compiled_plan_hash: computeGeneratedWorkflowCompiledPlanHash(compiledPlan),
    source_metadata: { source: "test" },
    template_id: workflow.id,
    platform: workflow.platform,
    template_version: workflow.version,
    workflow,
    compiled_plan: compiledPlan,
    hit_count: 3,
    created_at: new Date("2026-05-21T18:00:00.000Z"),
    updated_at: new Date("2026-05-21T18:10:00.000Z"),
    last_used_at: new Date("2026-05-21T18:20:00.000Z"),
    ...overrides,
  };
}

function mockDbQuery(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  vi.mocked(getDb).mockReturnValue({ query } as any);
  return query;
}

describe("generated workflow plan cache service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists generated plans under both cacheKey and requestKey", async () => {
    const service = new WorkflowService();
    const workflow = redditHomeWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = mockDbQuery();

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97");

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("DELETE FROM generated_workflow_plan_cache WHERE request_key = $1");
    expect(query.mock.calls[0][1]).toEqual(["c02c59dfbe512562f8c65c97", compiledPlan.cacheKey]);
    const [sql, values] = query.mock.calls[1];
    expect(sql).toContain("INSERT INTO generated_workflow_plan_cache");
    expect(sql).toContain("ON CONFLICT (cache_key) DO UPDATE");
    expect(sql).toContain("request_key      = COALESCE(EXCLUDED.request_key");
    expect(sql).toContain("canonical_workflow_id");
    expect(sql).toContain("compiled_plan_hash");
    expect(values[0]).toBe(compiledPlan.cacheKey);
    expect(values[1]).toBe("c02c59dfbe512562f8c65c97");
    expect(values[2]).toBe(workflow.id);
    expect(values[3]).toBe(workflow.version);
    expect(values[4]).toBe(computeGeneratedWorkflowCompiledPlanHash(compiledPlan));
    expect(values[5]).toBe(JSON.stringify({
      intent: null,
      safetyClass: null,
      outputSchema: null,
      allowedRecoveryRequests: [],
    }));
    expect(values[6]).toBe(workflow.id);
    expect(values[7]).toBe("reddit");
    expect(values[8]).toBe("1.0.0");
    expect(values[9]).toBe(JSON.stringify(workflow));
    expect(values[10]).toBe(JSON.stringify(compiledPlan));
  });

  it("replaces an existing canonical requestKey with the freshly compiled artifact", async () => {
    const service = new WorkflowService();
    const workflow = redditHomeWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = mockDbQuery([{ cache_key: "oldcachekey000000000001" }]);

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97");

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("DELETE FROM generated_workflow_plan_cache WHERE request_key = $1");
    expect(query.mock.calls[1][0]).toContain("INSERT INTO generated_workflow_plan_cache");
  });

  it("persists canonical generated workflow safety metadata in source metadata", async () => {
    const service = new WorkflowService();
    const workflow = redditAccountHealthWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = mockDbQuery();

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97", {
      source: "test",
    });

    const [, values] = query.mock.calls[1];
    expect(JSON.parse(values[5] as string)).toEqual({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      outputSchema: workflow.outputSchema,
      allowedRecoveryRequests: ["refresh_screen_state"],
      source: "test",
    });
    expect(compiledPlan.metadata).toMatchObject({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      outputSchema: workflow.outputSchema,
      allowedRecoveryRequests: ["refresh_screen_state"],
    });
    expect(compiledPlan.llmBudget.happyPathRequests).toBe(0);
  });

  it("returns a concrete cache miss without fabricating a workflow", async () => {
    const service = new WorkflowService();
    const query = mockDbQuery([]);

    const result = await service.getGeneratedPlanCache("56d91a7aa0e90314241896a2");

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("UPDATE generated_workflow_plan_cache");
    expect(sql).toContain("SET hit_count = hit_count + 1, last_used_at = NOW()");
    expect(sql).toContain("WHERE cache_key = $1");
    expect(values).toEqual(["56d91a7aa0e90314241896a2"]);
  });

  it("rejects unsafe compiled plans before canonical cache persistence", async () => {
    const service = new WorkflowService();
    const workflow = redditHomeWorkflow();
    const compiledPlan = {
      ...compileGeneratedWorkflowTemplate(workflow),
      llmBudget: {
        happyPathRequests: 1,
        recoveryRequests: "only_on_failure",
      },
    } as any;
    const query = mockDbQuery();

    await expect(service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97"))
      .rejects.toMatchObject({ code: "GENERATED_WORKFLOW_CACHE_LLM_BUDGET_UNSAFE" });
    expect(query).not.toHaveBeenCalled();
  });

  it("maps cacheKey hits and increments usage atomically", async () => {
    const row = cacheRow();
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.getGeneratedPlanCache(row.cache_key as string);

    expect(result).toMatchObject({
      cacheKey: row.cache_key,
      requestKey: row.request_key,
      canonicalWorkflowId: "agent_generated_reddit_home_smoke_v1",
      canonicalWorkflowVersion: "1.0.0",
      compiledPlanHash: row.compiled_plan_hash,
      sourceMetadata: { source: "test" },
      templateId: "agent_generated_reddit_home_smoke_v1",
      platform: "reddit",
      templateVersion: "1.0.0",
      hitCount: 3,
      workflow: {
        id: "agent_generated_reddit_home_smoke_v1",
        platform: "reddit",
      },
      compiledPlan: {
        cacheKey: row.cache_key,
        planVersion: "generated-workflow-plan/v1",
        llmBudget: {
          happyPathRequests: 0,
          recoveryRequests: "only_on_failure",
        },
      },
    });
    expect(result?.createdAt).toBe("2026-05-21T18:00:00.000Z");
    expect(result?.lastUsedAt).toBe("2026-05-21T18:20:00.000Z");
    expect(query.mock.calls[0][0]).toContain("RETURNING *");
  });

  it("computes a stable compiled plan hash independent of object key order", () => {
    const plan = compileGeneratedWorkflowTemplate(redditHomeWorkflow());
    const reordered = {
      steps: plan.steps,
      llmBudget: plan.llmBudget,
      metadata: plan.metadata,
      maxDepth: plan.maxDepth,
      checkpointCount: plan.checkpointCount,
      actionCount: plan.actionCount,
      stepCount: plan.stepCount,
      templateVersion: plan.templateVersion,
      platform: plan.platform,
      templateId: plan.templateId,
      cacheKey: plan.cacheKey,
      planVersion: plan.planVersion,
    };

    expect(computeGeneratedWorkflowCompiledPlanHash(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeGeneratedWorkflowCompiledPlanHash(reordered)).toBe(computeGeneratedWorkflowCompiledPlanHash(plan));
  });

  it("resolves requestKey hits through the latest cached cacheKey", async () => {
    const row = cacheRow({ hit_count: 7 });
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.getGeneratedPlanCacheByRequestKey(row.request_key as string);

    expect(result?.cacheKey).toBe(row.cache_key);
    expect(result?.requestKey).toBe("c02c59dfbe512562f8c65c97");
    expect(result?.hitCount).toBe(7);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("WHERE cache_key = (");
    expect(sql).toContain("WHERE request_key = $1");
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(values).toEqual(["c02c59dfbe512562f8c65c97"]);
  });

  it("supports execute-from-cache semantics with no regenerated workflow payload", async () => {
    const row = cacheRow();
    const cachedWorkflow = row.workflow as WorkflowTemplate;

    const validation = validateGeneratedWorkflowTemplate(cachedWorkflow);
    expect(validation.ok).toBe(true);

    const summary = summarizeGeneratedWorkflowTemplate(validation.template!, {
      dryRun: true,
      persisted: false,
    });

    expect(summary).toMatchObject({
      generated: true,
      dryRun: true,
      persisted: false,
      templateId: "agent_generated_reddit_home_smoke_v1",
      compiledPlan: {
        cacheKey: row.cache_key,
        llmBudget: {
          happyPathRequests: 0,
        },
      },
    });
  });
});
