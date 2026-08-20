import { beforeEach, describe, expect, test, vi } from "vitest";
import { selectIntent, buildProposal, createCreativeWorkflowRun } from "./creative-workflow.service";

const mocks = vi.hoisted(() => ({
  db: {
    connect: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  workflowEvents: {
    publish: vi.fn(),
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

vi.mock("../workflow-events", () => ({
  workflowEvents: mocks.workflowEvents,
}));

function cachedArtifact(overrides: Record<string, unknown> = {}) {
  return {
    platform: "reddit",
    cache_key: "0123456789abcdef01234567",
    request_key: "c02c59dfbe512562f8c65c97",
    canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
    canonical_workflow_version: "1.0.0",
    compiled_plan_hash: "a".repeat(64),
    source_metadata: { safetyClass: "read_only", intent: "reddit_account_health_scan" },
    workflow: {
      id: "agent_generated_reddit_account_health_scan_v1",
      platform: "reddit",
      safetyClass: "read_only",
      intent: "reddit_account_health_scan",
    },
    compiled_plan: {
      metadata: { safetyClass: "read_only", intent: "reddit_account_health_scan" },
      llmBudget: { happyPathRequests: 0 },
    },
    ...overrides,
  };
}

describe("selectIntent", () => {
  test("scan intent for health/scan keywords", () => {
    expect(selectIntent("Scan account health").intent).toBe("account_scan");
    expect(selectIntent("Check health").intent).toBe("account_scan");
    expect(selectIntent("Audit everything").intent).toBe("account_scan");
  });

  test("strategy_review intent", () => {
    expect(selectIntent("Review strategy").intent).toBe("strategy_review");
    expect(selectIntent("Plan the week").intent).toBe("strategy_review");
  });

  test("unsupported mutating-ish intents stay light", () => {
    expect(selectIntent("Boost engagement").safetyClass).toBe("light");
    expect(selectIntent("Post content").safetyClass).toBe("light");
  });
});

describe("buildProposal", () => {
  test("builds proposal with all fields", () => {
    const proposal = buildProposal({
      clientId: "client-1",
      accountId: "account-1",
      deviceId: "device-1",
      objective: "Scan account",
    });

    expect(proposal).toMatchObject({
      objective: "Scan account",
      intent: "account_scan",
      safetyClass: "read_only",
      clientId: "client-1",
      accountId: "account-1",
      deviceId: "device-1",
    });
  });
});

describe("createCreativeWorkflowRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.connect.mockResolvedValue(mocks.client);
  });

  test("dry run returns proposal and does not touch DB", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Boost engagement",
      dryRun: true,
    });

    expect(result.status).toBe("proposal");
    expect(result.agencyWorkflowRunId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(result.report).toMatchObject({ dryRun: true });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  test("missing fields returns not_ready without fake IDs or DB access", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "",
      accountId: "",
      deviceId: "",
      objective: "",
    });

    expect(result.status).toBe("not_ready");
    expect(result.code).toBe("CREATIVE_WORKFLOW_MISSING_FIELDS");
    expect(result.runId).toBeNull();
    expect(result.agencyWorkflowRunId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  test("unsupported executable intent returns not_ready without fake IDs or DB access", async () => {
    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Post content",
    });

    expect(result.status).toBe("not_ready");
    expect(result.code).toBe("CREATIVE_WORKFLOW_UNSUPPORTED_INTENT");
    expect(result.agencyWorkflowRunId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  test("no compatible artifact returns not_ready and does not insert run/task", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "a-1", username: "acct", platform: "reddit", client_id: "c-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Scan account health",
    });

    expect(result.status).toBe("not_ready");
    expect(result.code).toBe("CREATIVE_WORKFLOW_ARTIFACT_NOT_READY");
    expect(result.agencyWorkflowRunId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO agency_workflow_runs"))).toBe(false);
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tasks"))).toBe(false);
    expect(mocks.client.release).toHaveBeenCalled();
  });

  test("non-dry-run creates persisted agency run and generated_workflow task", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const taskId = "22222222-2222-4222-8222-222222222222";
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "a-1", username: "acct", platform: "reddit", client_id: "c-1" }] })
      .mockResolvedValueOnce({ rows: [cachedArtifact()] })
      .mockResolvedValueOnce({ rows: [{ id: runId }] })
      .mockResolvedValueOnce({ rows: [{ id: taskId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Scan account health",
    });

    expect(result.status).toBe("queued");
    expect(result.runId).toBe(runId);
    expect(result.agencyWorkflowRunId).toBe(runId);
    expect(result.taskId).toBe(taskId);
    expect(result.message).toContain(runId);
    expect(result.message).toContain(taskId);

    const cacheLookup = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("generated_workflow_plan_cache"));
    expect(cacheLookup?.[0]).toContain("artifact_state = 'promoted'");

    const runInsert = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO agency_workflow_runs"));
    expect(runInsert).toBeDefined();
    expect(runInsert![1][0]).toBe("c-1");

    const taskInsert = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO tasks"));
    expect(taskInsert).toBeDefined();
    expect(JSON.parse(taskInsert![1][2])).toMatchObject({
      cacheKey: "0123456789abcdef01234567",
      clientId: "c-1",
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: "reddit_account_health_scan",
      source: "creative_workflows",
    });
    expect(mocks.workflowEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      event: "queued",
      agencyWorkflowRunId: runId,
      taskId,
    }));
  });

  test("rolls back and releases connection on insert failure", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "a-1", username: "acct", platform: "reddit", client_id: "c-1" }] })
      .mockResolvedValueOnce({ rows: [cachedArtifact()] })
      .mockResolvedValueOnce({ rows: [{ id: "33333333-3333-4333-8333-333333333333" }] })
      .mockRejectedValueOnce(new Error("task insert failed"))
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(createCreativeWorkflowRun({
      clientId: "c-1",
      accountId: "a-1",
      deviceId: "d-1",
      objective: "Scan account health",
    })).rejects.toThrow("task insert failed");

    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("ROLLBACK"))).toBe(true);
    expect(mocks.client.release).toHaveBeenCalled();
  });
});
