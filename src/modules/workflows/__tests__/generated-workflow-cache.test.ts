import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../../db/client";
import { WorkflowService } from "../workflow.service";
import type { WorkflowTemplate } from "../types";
import {
  compileGeneratedWorkflowTemplate,
  computeGeneratedWorkflowCompiledPlanHash,
  summarizeGeneratedWorkflowTemplate,
  validateGeneratedWorkflowCompiledPlan,
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
    artifact_state: "promoted",
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
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (String(sql).includes("ORDER BY state.sort_order, state.status")) {
      return {
        rows: [
          {
            lifecycle_key: "fixture",
            status: "candidate",
            initial: true,
            terminal: false,
            retryable: false,
            administrative: false,
            dispatchable: false,
            manual: true,
            stale_after_ms: null,
            stale_action_key: null,
            description: null,
            metadata: {},
          },
          {
            lifecycle_key: "fixture",
            status: "promoted",
            initial: false,
            terminal: false,
            retryable: false,
            administrative: false,
            dispatchable: true,
            manual: false,
            stale_after_ms: null,
            stale_action_key: null,
            description: null,
            metadata: {},
          },
        ],
      };
    }
    return { rows };
  });
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

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97", {
      capabilityKey: "reddit_home_smoke",
      portable: true,
      portabilityScope: "global",
    });

    const deleteCall = query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM generated_workflow_plan_cache"));
    expect(deleteCall?.[1]).toEqual(["c02c59dfbe512562f8c65c97", compiledPlan.cacheKey]);
    const [sql, values] = query.mock.calls.find(([candidate]) => String(candidate).includes("INSERT INTO generated_workflow_plan_cache"))!;
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
    expect(values[5]).toBe("candidate");
    expect(values[6]).toBe(JSON.stringify({
      intent: null,
      safetyClass: null,
      outputSchema: null,
      allowedRecoveryRequests: [],
      capabilityKey: "reddit_home_smoke",
      portable: true,
      portabilityScope: "global",
    }));
    expect(values[7]).toBe(workflow.id);
    expect(values[8]).toBe("reddit");
    expect(values[9]).toBe("1.0.0");
    expect(values[10]).toBe(JSON.stringify(workflow));
    expect(values[11]).toBe(JSON.stringify(compiledPlan));
    expect(query.mock.calls.some(([candidate]) => String(candidate).includes("INSERT INTO workflow_capabilities"))).toBe(false);
    expect(query.mock.calls.some(([candidate]) => String(candidate).includes("INSERT INTO workflow_capability_artifacts"))).toBe(false);
  });

  it("replaces an existing canonical requestKey with the freshly compiled artifact", async () => {
    const service = new WorkflowService();
    const workflow = redditHomeWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = mockDbQuery([{ cache_key: "oldcachekey000000000001" }]);

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97", {
      capabilityKey: "reddit_home_smoke",
    });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM generated_workflow_plan_cache"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO generated_workflow_plan_cache"))).toBe(true);
  });

  it("can promote the same candidate artifact for an existing requestKey", async () => {
    const service = new WorkflowService();
    const workflow = redditHomeWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ cache_key: compiledPlan.cacheKey, artifact_state: "candidate" }] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(getDb).mockReturnValue({ query } as any);

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97", {
      artifactState: "promoted",
      sourceMetadata: {
        capabilityKey: "reddit_home_smoke",
        source: "test_promotion",
      },
    });

    const [sql, values] = query.mock.calls.find(([candidate]) => String(candidate).includes("INSERT INTO generated_workflow_plan_cache"))!;
    expect(sql).toContain("ON CONFLICT (cache_key) DO UPDATE");
    expect(values[0]).toBe(compiledPlan.cacheKey);
    expect(values[5]).toBe("promoted");
  });

  it("persists canonical generated workflow safety metadata in source metadata", async () => {
    const service = new WorkflowService();
    const workflow = redditAccountHealthWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const query = mockDbQuery();

    await service.saveGeneratedPlanCache(workflow, compiledPlan, "c02c59dfbe512562f8c65c97", {
      capabilityKey: "reddit_account_health_scan",
      source: "test",
      portable: true,
      portabilityScope: "global",
    });

    const [, values] = query.mock.calls.find(([candidate]) => String(candidate).includes("INSERT INTO generated_workflow_plan_cache"))!;
    expect(JSON.parse(values[6] as string)).toEqual({
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      outputSchema: workflow.outputSchema,
      allowedRecoveryRequests: ["refresh_screen_state"],
      source: "test",
      capabilityKey: "reddit_account_health_scan",
      portable: true,
      portabilityScope: "global",
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
    expect(sql).toContain("lifecycle_state_matches");
    expect(values).toEqual(["56d91a7aa0e90314241896a2", false]);
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

  it("rejects generated observation output nodes that leak into the compiled executable plan", async () => {
    const service = new WorkflowService();
    const workflow = redditAccountHealthWorkflow();
    const compiledPlan = compileGeneratedWorkflowTemplate(workflow);
    const corruptedPlan = {
      ...compiledPlan,
      stepCount: compiledPlan.stepCount + 1,
      actionCount: compiledPlan.actionCount + 1,
      steps: [
        ...compiledPlan.steps,
        {
          path: "workflow.steps[2].params.outputs.contentDescriptionCount",
          type: "action",
          id: "foreground_and_observe__checkable_focusable_content_description_count_observed",
          action: null,
        },
      ],
    } as any;
    const query = mockDbQuery();

    await expect(service.saveGeneratedPlanCache(workflow, corruptedPlan, "c02c59dfbe512562f8c65c97"))
      .rejects.toMatchObject({
        code: "GENERATED_WORKFLOW_COMPILED_PLAN_VALIDATION_FAILED",
        validationErrors: expect.arrayContaining([
          "compiledPlan.steps must not add or omit executable workflow steps",
          "compiledPlan.steps[2] is not present in the validated workflow template",
        ]),
      });
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps countMatches-style observation output extractors as action params, not executable steps", () => {
    const workflow = redditAccountHealthWorkflow();
    workflow.steps = [
      {
        type: "action",
        id: "foreground_and_observe",
        action: "classify_ui_tree",
        effect: "observation",
        params: {
          outputs: {
            contentDescriptionCount: {
              countMatches: {
                field: "contentDescription",
                regex: ".+",
              },
              default: 0,
            },
          },
        },
      },
    ];

    const validation = validateGeneratedWorkflowTemplate(workflow);
    expect(validation.errors).toEqual([]);
    const compiledPlan = compileGeneratedWorkflowTemplate(validation.template!);

    expect(compiledPlan.steps).toEqual([
      expect.objectContaining({
        path: "workflow.steps[0]",
        type: "action",
        id: "foreground_and_observe",
        action: "classify_ui_tree",
      }),
    ]);
    expect(validateGeneratedWorkflowCompiledPlan(validation.template!, compiledPlan)).toEqual([]);
  });

  it.each([
    ["missing", undefined, {}],
    ["null", null, {}],
    ["array", [], {}],
    ["scalar", "invalid", {}],
    ["object", { source: "ui_tree", includeInvisible: false }, { source: "ui_tree", includeInvisible: false }],
  ])("normalizes %s nested observationPrimitive.params before validation", (_label, params, expectedParams) => {
    const workflow = redditAccountHealthWorkflow();
    const observationPrimitive: Record<string, unknown> = {
      action: "ui_tree_dump",
      timeoutMs: 1000,
    };
    if (params !== undefined) observationPrimitive.params = params;
    workflow.steps = [
      {
        type: "action",
        id: "foreground_and_observe__verify_chrome_foreground",
        action: "classify_ui_tree",
        effect: "observation",
        params: {
          observationPrimitive,
          outputs: {
            visibleCheckableFocusableContentDescriptionCount: {
              countMatches: {
                field: "contentDescription",
                regex: ".+",
              },
              default: 0,
            },
          },
        },
      },
    ];

    const validation = validateGeneratedWorkflowTemplate(workflow);
    expect(validation.errors).toEqual([]);
    expect(validation.template!.steps[0]).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        observationPrimitive: expect.objectContaining({
          action: "ui_tree_dump",
          params: expectedParams,
        }),
      }),
    }));
    const compiledPlan = compileGeneratedWorkflowTemplate(validation.template!);

    expect(compiledPlan.steps).toEqual([
      expect.objectContaining({
        path: "workflow.steps[0]",
        type: "action",
        id: "foreground_and_observe__verify_chrome_foreground",
        action: "classify_ui_tree",
      }),
    ]);
    expect(validateGeneratedWorkflowCompiledPlan(validation.template!, compiledPlan)).toEqual([]);
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
      artifactState: "promoted",
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
    expect(sql).toContain("lifecycle_state_matches");
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(values).toEqual(["c02c59dfbe512562f8c65c97", false]);
  });

  it("lists only promoted portable capability candidates for the runtime platform", async () => {
    const row = cacheRow({
      platform: "android",
      source_metadata: {
        capabilityKey: "remote_support_enable_screen_share",
        portable: true,
        portabilityScope: "global",
        safetyClass: "standard",
      },
    });
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.listPortableGeneratedPlanCacheCandidates("android");

    expect(result).toHaveLength(1);
    expect(result[0]?.cacheKey).toBe(row.cache_key);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("lifecycle_state_matches");
    expect(sql).toContain("'portable'");
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(values).toEqual(["android", 200]);
  });

  it("persists a lazily resolved portable capability identity on the promoted artifact", async () => {
    const service = new WorkflowService();
    const query = mockDbQuery();

    await service.recordPortableCapabilityIdentity(
      "9298138bc0d3174e92fc526e",
      "remote_support_enable_screen_share",
    );

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("'capabilityKey'");
    expect(sql).toContain("'portable', true");
    expect(sql).toContain("lifecycle_state_matches");
    expect(values).toEqual([
      "9298138bc0d3174e92fc526e",
      "remote_support_enable_screen_share",
    ]);
  });

  it("can include candidate artifacts only through an explicit lookup option", async () => {
    const row = cacheRow({ artifact_state: "candidate" });
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.getGeneratedPlanCache(row.cache_key as string, { includeCandidate: true });

    expect(result?.artifactState).toBe("candidate");
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("lifecycle_state_matches");
    expect(values).toEqual([row.cache_key, true]);
  });

  it("records successful artifact learning and applies the coverage promotion gate", async () => {
    const row = cacheRow({
      artifact_state: "promoted",
      source_metadata: {
        source: "dashboard_human",
        workflowLearning: {
          successCount: 1,
          failureCount: 0,
          lastOutcome: "success",
        },
      },
    });
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.recordGeneratedPlanCacheOutcome({
      cacheKey: row.cache_key as string,
      success: true,
      taskId: "22222222-2222-4222-8222-222222222222",
      workflowId: "33333333-3333-4333-8333-333333333333",
      agencyWorkflowRunId: "44444444-4444-4444-8444-444444444444",
      stepsCompleted: 5,
      totalSteps: 5,
    });

    expect(result?.artifactState).toBe("promoted");
    const [sql, values] = query.mock.calls.find(([candidate]) => String(candidate).includes("/* recordGeneratedPlanCacheOutcome */"))!;
    expect(sql).toContain("recordGeneratedPlanCacheOutcome");
    expect(sql).toContain("workflowLearning");
    expect(values).toEqual([
      row.cache_key,
      1,
      0,
      null,
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      5,
      5,
      false,
      null,
    ]);
  });

  it("quarantines a failed promoted artifact so it cannot be reused blindly", async () => {
    const row = cacheRow({
      artifact_state: "quarantined",
      source_metadata: {
        source: "dashboard_human",
        workflowLearning: {
          successCount: 2,
          failureCount: 1,
          lastOutcome: "failure",
          decision: "quarantine_promoted_after_failure",
        },
      },
    });
    const service = new WorkflowService();
    const query = mockDbQuery([row]);

    const result = await service.recordGeneratedPlanCacheOutcome({
      cacheKey: row.cache_key as string,
      success: false,
      reason: "RECOVERY_BUDGET_EXCEEDED",
      taskId: "22222222-2222-4222-8222-222222222222",
      stepsCompleted: 1,
      totalSteps: 5,
    });

    expect(result?.artifactState).toBe("quarantined");
    const [sql, values] = query.mock.calls.find(([candidate]) => String(candidate).includes("/* recordGeneratedPlanCacheOutcome */"))!;
    expect(sql).toContain("artifact_state = COALESCE");
    expect(values[1]).toBe(0);
    expect(values[2]).toBe(1);
    expect(values[3]).toBe("RECOVERY_BUDGET_EXCEEDED");
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
