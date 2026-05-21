import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../../db/client";
import { WorkflowService } from "../workflow.service";
import type { WorkflowTemplate } from "../types";
import {
  compileGeneratedWorkflowTemplate,
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

function cacheRow(overrides: Record<string, unknown> = {}) {
  const workflow = redditHomeWorkflow();
  const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
  return {
    cache_key: compiledPlan.cacheKey,
    request_key: "c02c59dfbe512562f8c65c97",
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

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO generated_workflow_plan_cache");
    expect(sql).toContain("ON CONFLICT (cache_key) DO UPDATE");
    expect(sql).toContain("request_key      = COALESCE(EXCLUDED.request_key");
    expect(values).toEqual([
      compiledPlan.cacheKey,
      "c02c59dfbe512562f8c65c97",
      workflow.id,
      "reddit",
      "1.0.0",
      JSON.stringify(workflow),
      JSON.stringify(compiledPlan),
    ]);
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

  it("maps cacheKey hits and increments usage atomically", async () => {
    const row = cacheRow();
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.getGeneratedPlanCache(row.cache_key as string);

    expect(result).toMatchObject({
      cacheKey: row.cache_key,
      requestKey: row.request_key,
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
