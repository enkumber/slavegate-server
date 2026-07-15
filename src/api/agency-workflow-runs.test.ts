import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    connect: vi.fn(),
    query: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

function app() {
  const app = express();
  app.use(express.json());
  return import("./agency-routes").then(({ default: router }) => {
    app.use("/api/agency", router);
    return app;
  });
}

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
      version: "1.0.0",
      platform: "reddit",
      safetyClass: "read_only",
      intent: "reddit_account_health_scan",
      steps: [],
    },
    compiled_plan: {
      metadata: {
        safetyClass: "read_only",
        intent: "reddit_account_health_scan",
      },
      llmBudget: {
        happyPathRequests: 0,
        recoveryRequests: "only_on_failure",
      },
    },
    ...overrides,
  };
}

function hydratedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    client_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    device_id: "11111111-1111-4111-8111-111111111111",
    task_id: "22222222-2222-4222-8222-222222222222",
    workflow_id: null,
    platform: "reddit",
    intent: "reddit_account_health_scan",
    safety_class: "read_only",
    request_key: "c02c59dfbe512562f8c65c97",
    cache_key: null,
    canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
    canonical_workflow_version: "1.0.0",
    compiled_plan_hash: "a".repeat(64),
    status: "queued",
    output: {},
    token_usage: {},
    context: { source: "agency_workflow_runs" },
    recovery_requests: 0,
    error: null,
    created_at: new Date("2026-05-22T10:00:00.000Z"),
    updated_at: new Date("2026-05-22T10:00:00.000Z"),
    account_username: "acct",
    account_platform: "reddit",
    client_name: "Client",
    device_name: "Pixel",
    ...overrides,
  };
}

function workflowDefinitionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    definition_key: "reddit_account_health_scan",
    version: 1,
    status: "active",
    title: "Reddit account health scan",
    description: "Read-only workflow definition",
    platform: "reddit",
    intent: "reddit_account_health_scan",
    goal: "Classify Reddit account health without side effects",
    source: "static_seed",
    parent_definition_id: null,
    version_note: null,
    definition: {
      steps: ["open_reddit", "classify_reddit_health_scan"],
      terminalStates: ["success", "expected_failure", "quarantined"],
      sideEffects: [],
    },
    success_criteria: ["loggedIn classified", "screenState is one of the known Reddit states"],
    allowed_tools: ["open_app", "ui_tree_dump"],
    required_capabilities: ["device.online_or_approved"],
    constraints: ["read_only_only"],
    fallback_rules: ["if login wall detected classify expected_failure"],
    rollback: { required: false },
    policy: {},
    promotion_state: "not_promoted",
    promotion_scope: null,
    promotion_confidence: null,
    promotion_readiness: {},
    promotion_scope_details: {},
    rollback_preview: { available: false, wouldRollbackNow: false },
    rollback_definition_id: null,
    telemetry_summary: {},
    confidence_decay: {},
    promotion_hardening: {},
    promoted_at: null,
    promoted_by: null,
    created_by: "migration",
    created_at: new Date("2026-05-22T11:00:00.000Z"),
    updated_at: new Date("2026-05-22T11:00:00.000Z"),
    ...overrides,
  };
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function postWorkflowRun(body: Record<string, unknown>) {
  return postAgency("/api/agency/workflow-runs", body);
}

async function postAgency(path: string, body: Record<string, unknown>, headers: Record<string, string> = { "x-api-key": "test-api-key" }) {
  const server = await app();
  const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
  return response;
}

async function getWorkflowRun(path: string) {
  const server = await app();
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`);
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

async function getAgency(path: string, headers: Record<string, string> = { "x-api-key": "test-api-key" }) {
  const server = await app();
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

async function patchAgency(path: string, body: Record<string, unknown>, headers: Record<string, string> = { "x-api-key": "test-api-key" }) {
  const server = await app();
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("agency workflow runs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.db.connect.mockResolvedValue(mocks.client);
  });

  it("creates a queued generated_workflow task from an existing read-only canonical artifact", async () => {
    const run = hydratedRun();
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [cachedArtifact()] })
      .mockResolvedValueOnce({ rows: [{ id: run.id }] })
      .mockResolvedValueOnce({ rows: [{ id: run.task_id }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const response = await postWorkflowRun({
      clientId: run.client_id,
      accountId: run.account_id,
      deviceId: run.device_id,
      intent: "reddit_account_health_scan",
      requestKey: run.request_key,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: run.id,
      taskId: run.task_id,
      workflowId: null,
      shortDeviceId: "11111111",
      status: "queued",
      canonicalWorkflowId: "agent_generated_reddit_account_health_scan_v1",
    });

    const cacheLookup = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("generated_workflow_plan_cache")
    );
    expect(cacheLookup?.[0]).toContain("artifact_state = 'promoted'");

    const taskInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO tasks")
    );
    expect(taskInsert).toBeDefined();
    expect(taskInsert![1][2]).toBe(JSON.stringify({
      requestKey: run.request_key,
      clientId: run.client_id,
      agencyWorkflowRunId: run.id,
      workflowRunId: run.id,
      intent: "reddit_account_health_scan",
    }));
    expect(JSON.parse(taskInsert![1][2])).not.toHaveProperty("workflow");
  });

  it("rejects openclaw_agent tokens for POST /api/agency/workflow-runs", async () => {
    mocks.db.query.mockImplementationOnce(async (_sql: string, params: string[]) => {
      expect(params).toEqual([tokenHash("agent-token")]);
      return {
        rows: [{
          id: "token-1",
          purpose: "openclaw_agent",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
        }],
      };
    });

    const response = await postAgency(
      "/api/agency/workflow-runs",
      {
        clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        deviceId: "11111111-1111-4111-8111-111111111111",
        intent: "reddit_account_health_scan",
      },
      { authorization: "Bearer agent-token" }
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("creates a product-level Reddit account health scan from the latest cache-safe artifact", async () => {
    const run = hydratedRun({ cache_key: "0123456789abcdef01234567", request_key: null });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: run.account_id,
          client_id: run.client_id,
          platform: "reddit",
          username: "Consistent-Beyond386",
        }],
      })
      .mockResolvedValueOnce({ rows: [cachedArtifact({ cache_key: run.cache_key })] })
      .mockResolvedValueOnce({ rows: [{ id: run.id }] })
      .mockResolvedValueOnce({ rows: [{ id: run.task_id }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const response = await postAgency("/api/agency/reddit/account-health-scans", {
      accountId: run.account_id,
      deviceId: run.device_id,
      context: { requestedBy: "test" },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: run.id,
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      cacheKey: "0123456789abcdef01234567",
      accountPlatform: "reddit",
    });

    const cacheLookup = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("generated_workflow_plan_cache")
    );
    expect(cacheLookup?.[0]).toContain("reddit_account_health_scan");
    expect(cacheLookup?.[0]).toContain("artifact_state = 'promoted'");

    const taskInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO tasks")
    );
    expect(taskInsert).toBeDefined();
    expect(JSON.parse(taskInsert![1][2])).toMatchObject({
      cacheKey: "0123456789abcdef01234567",
      intent: "reddit_account_health_scan",
      source: "agency_reddit_account_health_scan",
    });
  });

  it("creates a product-level Reddit account health scan with an explicit client for an unlinked account", async () => {
    const run = hydratedRun({ cache_key: "0123456789abcdef01234567", request_key: null });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: run.account_id,
          client_id: null,
          platform: "reddit",
          username: "Consistent-Beyond386",
        }],
      })
      .mockResolvedValueOnce({ rows: [cachedArtifact({ cache_key: run.cache_key })] })
      .mockResolvedValueOnce({ rows: [{ id: run.id }] })
      .mockResolvedValueOnce({ rows: [{ id: run.task_id }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const response = await postAgency("/api/agency/reddit/account-health-scans", {
      clientId: run.client_id,
      accountId: run.account_id,
      deviceId: run.device_id,
      context: { requestedBy: "test" },
    });

    expect(response.status).toBe(201);

    const runInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agency_workflow_runs")
    );
    expect(runInsert).toBeDefined();
    expect(runInsert![1][0]).toBe(run.client_id);

    const taskInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO tasks")
    );
    expect(JSON.parse(taskInsert![1][2])).toMatchObject({
      clientId: run.client_id,
      cacheKey: "0123456789abcdef01234567",
    });
  });

  it("rejects product-level Reddit account health scans when explicit client mismatches the account client", async () => {
    const run = hydratedRun();
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: run.account_id,
          client_id: run.client_id,
          platform: "reddit",
          username: "Consistent-Beyond386",
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const response = await postAgency("/api/agency/reddit/account-health-scans", {
      clientId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      accountId: run.account_id,
      deviceId: run.device_id,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("ACCOUNT_CLIENT_MISMATCH");
    expect(mocks.client.query.mock.calls.some(([sql]) =>
      String(sql).includes("generated_workflow_plan_cache")
    )).toBe(false);
  });

  it("rejects inline workflow payloads before database access", async () => {
    const response = await postWorkflowRun({
      clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "11111111-1111-4111-8111-111111111111",
      intent: "reddit_account_health_scan",
      requestKey: "c02c59dfbe512562f8c65c97",
      workflow: { id: "inline" },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("WORKFLOW_PAYLOAD_NOT_ALLOWED");
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("rejects requests with both requestKey and cacheKey", async () => {
    const response = await postWorkflowRun({
      clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "11111111-1111-4111-8111-111111111111",
      intent: "reddit_account_health_scan",
      requestKey: "c02c59dfbe512562f8c65c97",
      cacheKey: "0123456789abcdef01234567",
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EXACTLY_ONE_CANONICAL_KEY_REQUIRED");
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("rejects cached artifacts that are not read-only", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cachedArtifact({ workflow: { safetyClass: "mutating" }, compiled_plan: { metadata: { safetyClass: "mutating" } } })] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postWorkflowRun({
      clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deviceId: "11111111-1111-4111-8111-111111111111",
      intent: "reddit_account_health_scan",
      cacheKey: "0123456789abcdef01234567",
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("GENERATED_WORKFLOW_NOT_READ_ONLY");
  });

  it("supports list filters for run/account/device/status and canonical keys", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [hydratedRun({ status: "completed" })] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getWorkflowRun(
      "/api/agency/workflow-runs?status=completed&requestKey=c02c59dfbe512562f8c65c97&deviceId=11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(200);
    expect(response.body.data.items[0]).toMatchObject({
      status: "completed",
      requestKey: "c02c59dfbe512562f8c65c97",
      shortDeviceId: "11111111",
    });
    expect(mocks.db.query.mock.calls[0][0]).toContain("r.device_id = $1");
    expect(mocks.db.query.mock.calls[0][0]).toContain("COALESCE(t.status, r.status) = $2");
    expect(mocks.db.query.mock.calls[0][0]).toContain("r.request_key = $3");
  });

  it("previews failed workflow cleanup without deleting rows", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ count: 4 }] });

    const response = await postAgency("/api/agency/workflow-runs/purge-failed", {});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      dryRun: true,
      failedWorkflowRuns: 2,
      failedCompileJobs: 3,
      generatedCacheArtifacts: 4,
    });
    expect(mocks.db.connect).not.toHaveBeenCalled();
    expect(mocks.db.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM"))).toBe(false);
  });

  it("purges failed workflow runs, failed compile jobs, and failed generated artifacts when confirmed", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: "compile-job-1" }, { id: "compile-job-2" }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ id: "run-1" }, { id: "run-2" }, { id: "run-3" }], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const response = await postAgency("/api/agency/workflow-runs/purge-failed", { confirm: true });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      dryRun: false,
      failedWorkflowRuns: 3,
      failedCompileJobs: 2,
      generatedCacheArtifacts: 5,
    });
    expect(mocks.client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(mocks.client.query.mock.calls[1][0]).toContain("DELETE FROM generated_workflow_plan_cache");
    expect(mocks.client.query.mock.calls[2][0]).toContain("DELETE FROM human_workflow_compile_jobs");
    expect(mocks.client.query.mock.calls[3][0]).toContain("DELETE FROM agency_workflow_runs");
    expect(mocks.client.query.mock.calls[4][0]).toBe("COMMIT");
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects partial feedback without lastGoodStepIndex", async () => {
    const response = await postAgency(
      "/api/agency/workflow-runs/33333333-3333-4333-8333-333333333333/feedback",
      { rating: "partial" }
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("FEEDBACK_LAST_GOOD_STEP_REQUIRED");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("rejects partial feedback outside the available timeline", async () => {
    const run = hydratedRun({
      workflow_status: "failed",
      workflow_current_step: 2,
      workflow_total_steps: 2,
      cached_workflow: {
        steps: [
          { id: "open_gmail", action: "open_app" },
          { id: "tap_create_account", action: "semantic_tap" },
        ],
      },
    });
    mocks.db.query.mockResolvedValueOnce({ rows: [run] });

    const response = await postAgency(
      `/api/agency/workflow-runs/${run.id}/feedback`,
      { rating: "partial", lastGoodStepIndex: 3 }
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("FEEDBACK_LAST_GOOD_STEP_OUT_OF_RANGE");
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });

  it("records dashboard workflow feedback without changing run status", async () => {
    const run = hydratedRun({ status: "completed", workflow_status: "completed" });
    const updated = hydratedRun({
      status: "completed",
      workflow_status: "completed",
      feedback_rating: "ok",
      feedback_last_good_step_index: null,
      feedback_note: "looks good",
      feedback_source: "dashboard",
      feedback_at: new Date("2026-05-22T10:05:00.000Z"),
    });
    mocks.db.query
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [updated] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postAgency(
      `/api/agency/workflow-runs/${run.id}/feedback`,
      { rating: "ok", note: " looks good " }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: run.id,
      status: "completed",
      feedback: {
        rating: "ok",
        lastGoodStepIndex: null,
        note: "looks good",
        source: "dashboard",
        at: "2026-05-22T10:05:00.000Z",
      },
    });
    expect(response.body.data.stepCandidates).toEqual([]);
    expect(mocks.client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(mocks.client.query.mock.calls[1][0]).toContain("feedback_rating = $2");
    expect(mocks.client.query.mock.calls[1][1]).toEqual([run.id, "ok", null, "looks good"]);
    expect(mocks.client.query.mock.calls[2][0]).toBe("COMMIT");
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("agency_workflow_step_candidates"))).toBe(false);
  });

  it("creates step candidates from partial feedback without promoting steps", async () => {
    const run = hydratedRun({
      status: "failed",
      workflow_status: "failed",
      workflow_current_step: 3,
      workflow_total_steps: 3,
      workflow_error: "tap failed",
      artifact_state: "candidate",
      cached_workflow: {
        steps: [
          { id: "open_reddit", action: "open_app" },
          { id: "open_search", action: "semantic_tap" },
          { id: "type_query", action: "type_text" },
        ],
      },
    });
    const updated = hydratedRun({
      ...run,
      feedback_rating: "partial",
      feedback_last_good_step_index: 1,
      feedback_note: "first two steps looked good",
      feedback_source: "dashboard",
      feedback_at: new Date("2026-05-22T10:06:00.000Z"),
    });
    const candidates = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        run_id: run.id,
        step_index: 0,
        step_id: "open_reddit",
        label: "open_app",
        action: "open_app",
        type: null,
        step_status: "succeeded",
        candidate_state: "step_candidate",
        request_key: run.request_key,
        cache_key: null,
        canonical_workflow_id: run.canonical_workflow_id,
        canonical_workflow_version: run.canonical_workflow_version,
        last_good_step_index: 1,
        step_snapshot: { index: 0, id: "open_reddit" },
        evidence: { source: "dashboard_partial_feedback" },
        note: "first two steps looked good",
        created_at: new Date("2026-05-22T10:06:00.000Z"),
        updated_at: new Date("2026-05-22T10:06:00.000Z"),
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        run_id: run.id,
        step_index: 1,
        step_id: "open_search",
        label: "semantic_tap",
        action: "semantic_tap",
        type: null,
        step_status: "succeeded",
        candidate_state: "step_candidate",
        request_key: run.request_key,
        cache_key: null,
        canonical_workflow_id: run.canonical_workflow_id,
        canonical_workflow_version: run.canonical_workflow_version,
        last_good_step_index: 1,
        step_snapshot: { index: 1, id: "open_search" },
        evidence: { source: "dashboard_partial_feedback" },
        note: "first two steps looked good",
        created_at: new Date("2026-05-22T10:06:00.000Z"),
        updated_at: new Date("2026-05-22T10:06:00.000Z"),
      },
    ];
    mocks.db.query
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [updated] })
      .mockResolvedValueOnce({ rows: candidates });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postAgency(
      `/api/agency/workflow-runs/${run.id}/feedback`,
      { rating: "partial", lastGoodStepIndex: 1, note: "first two steps looked good" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data.feedback).toMatchObject({
      rating: "partial",
      lastGoodStepIndex: 1,
      note: "first two steps looked good",
    });
    expect(response.body.data.stepCandidates).toHaveLength(2);
    expect(response.body.data.stepCandidates[0]).toMatchObject({
      stepIndex: 0,
      stepId: "open_reddit",
      candidateState: "step_candidate",
      lastGoodStepIndex: 1,
    });
    const candidateInserts = mocks.client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO agency_workflow_step_candidates")
    );
    expect(candidateInserts).toHaveLength(2);
    expect(candidateInserts[0][0]).toContain("candidate_state");
    expect(candidateInserts[0][0]).not.toContain("promoted");
    expect(mocks.client.query.mock.calls[4][0]).toBe("COMMIT");
  });

  it("returns a workflow run by id with task and operator context", async () => {
    const run = hydratedRun({
      status: "failed",
      workflow_status: "failed",
      workflow_current_step: 2,
      workflow_total_steps: 3,
      workflow_error: "RECOVERY_BUDGET_EXCEEDED",
      workflow_checkpoint: { variables: { screenState: "gmail_login_wall" } },
      artifact_state: "candidate",
      cached_workflow: {
        steps: [
          { id: "open_gmail", action: "open_app" },
          { id: "tap_create_account", action: "semantic_tap" },
          { id: "fill_form", action: "type_text" },
        ],
      },
    });
    mocks.db.query
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await getWorkflowRun(`/api/agency/workflow-runs/${run.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: run.id,
      clientId: run.client_id,
      accountId: run.account_id,
      deviceId: run.device_id,
      shortDeviceId: "11111111",
      taskId: run.task_id,
      workflowId: null,
      accountUsername: "acct",
      clientName: "Client",
      deviceName: "Pixel",
      artifactState: "candidate",
      workflowStatus: "failed",
    });
    expect(response.body.data.timeline).toEqual([
      {
        index: 0,
        id: "open_gmail",
        label: "open_app",
        action: "open_app",
        type: null,
        status: "succeeded",
        durationMs: null,
        error: null,
        state: null,
      },
      {
        index: 1,
        id: "tap_create_account",
        label: "semantic_tap",
        action: "semantic_tap",
        type: null,
        status: "failed",
        durationMs: null,
        error: "RECOVERY_BUDGET_EXCEEDED",
        state: "gmail_login_wall",
      },
      {
        index: 2,
        id: "fill_form",
        label: "type_text",
        action: "type_text",
        type: null,
        status: "pending",
        durationMs: null,
        error: null,
        state: null,
      },
    ]);
    expect(mocks.db.query.mock.calls[0][0]).toContain("FROM agency_workflow_runs r");
    expect(mocks.db.query.mock.calls[0][0]).toContain("r.id = $1");
    expect(mocks.db.query.mock.calls[0][0]).toContain("LEFT JOIN workflows w");
    expect(mocks.db.query.mock.calls[0][0]).toContain("LEFT JOIN LATERAL");
    expect(mocks.db.query.mock.calls[0][1]).toEqual([run.id]);
    expect(mocks.db.query.mock.calls[1][0]).toContain("FROM agency_workflow_step_candidates");
  });

  it("lists step candidates for dashboard review", async () => {
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 0,
      step_id: "open_reddit",
      label: "open_app",
      action: "open_app",
      type: null,
      step_status: "succeeded",
      candidate_state: "step_candidate",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 0 },
      evidence: { source: "dashboard_partial_feedback" },
      note: "first step looked good",
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      validation_contract: {},
      validation_evidence: {},
      validated_by: null,
      validated_at: null,
      run_status: "completed",
      run_intent: "reddit_account_health_scan",
      device_name: "Pixel",
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:06:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency("/api/agency/workflow-step-candidates?state=step_candidate&pageSize=10");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(response.body.data.items[0]).toMatchObject({
      id: candidate.id,
      runId: candidate.run_id,
      candidateState: "step_candidate",
      runStatus: "completed",
      runIntent: "reddit_account_health_scan",
      deviceName: "Pixel",
    });
    expect(mocks.db.query.mock.calls[0][0]).toContain("FROM agency_workflow_step_candidates c");
    expect(mocks.db.query.mock.calls[0][0]).toContain("c.candidate_state = $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual(["step_candidate", 10, 0]);
  });

  it("lists validated steps in the read-only step library without compiler reuse", async () => {
    const validated = {
      id: "55555555-5555-4555-8555-555555555555",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 1,
      step_id: "unlock",
      label: "unlock",
      action: "unlock",
      type: null,
      step_status: "succeeded",
      candidate_state: "validated_step",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 1 },
      evidence: { source: "dashboard_partial_feedback" },
      note: "second step looked good",
      review_note: "contract ok",
      reviewed_by: "dashboard",
      reviewed_at: new Date("2026-05-22T10:08:00.000Z"),
      validation_contract: {
        scope: "phase_3c_live_smoke",
        preconditions: ["screen is awake"],
        postconditions: ["device is unlocked"],
        compatibility: { serverVersion: "3.9.113" },
      },
      validation_evidence: { source: "dashboard_manual_validation" },
      validated_by: "dashboard",
      validated_at: new Date("2026-05-22T10:08:00.000Z"),
      run_status: "completed",
      run_intent: "reddit_account_health_scan",
      device_name: "Pixel",
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:08:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [validated] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency("/api/agency/step-library?pageSize=10");

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.items[0]).toMatchObject({
      id: validated.id,
      stepCandidateId: validated.id,
      name: "unlock",
      action: "unlock",
      status: "validated_step",
      libraryState: "review_only",
      reuseScope: "phase_3c_live_smoke",
      reusable: false,
      compilerEligible: false,
      confidence: 0.9,
      readiness: {
        state: "review_ready",
        score: 0.9,
        threshold: 0.9,
        blockers: ["limited_reuse_not_promoted", "compiler_auto_use_disabled"],
        gates: {
          validatedStep: true,
          preconditionsPresent: true,
          postconditionsPresent: true,
          evidencePresent: true,
          compatibilityDeclared: true,
          successfulSourceStep: true,
          successfulSourceRun: true,
          scopedReuse: true,
          limitedReusePromoted: false,
          compilerAutoUseEnabled: false,
        },
      },
      preconditions: ["screen is awake"],
      postconditions: ["device is unlocked"],
      runIntent: "reddit_account_health_scan",
      deviceName: "Pixel",
      sourceCandidate: {
        id: validated.id,
        candidateState: "validated_step",
      },
    });
    expect(mocks.db.query.mock.calls[0][0]).toContain("c.candidate_state = 'validated_step'");
    expect(mocks.db.query.mock.calls[0][0]).not.toContain("step_candidate'");
  });

  it("lists the read-only Tool Catalog without enabling compiler auto-use", async () => {
    const response = await getAgency("/api/agency/tool-catalog");

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBeGreaterThan(10);
    expect(response.body.data.policy).toEqual({
      compilerVisible: false,
      autoUseEnabled: false,
      mode: "read_only_catalog",
    });
    expect(response.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "open_app",
          source: "device_job",
          category: "navigation",
          risk: "medium",
          requiresDevice: true,
          inputSchema: expect.objectContaining({
            required: ["packageName"],
          }),
          policy: expect.objectContaining({
            compilerVisible: false,
            autoUseEnabled: false,
          }),
        }),
        expect.objectContaining({
          id: "ui_tree_dump",
          category: "observation",
          policy: expect.objectContaining({
            readOnly: true,
            mutating: false,
            compilerVisible: false,
            autoUseEnabled: false,
          }),
        }),
      ])
    );
    expect(response.body.data.items.every((item: any) => item.policy.compilerVisible === false)).toBe(true);
    expect(response.body.data.items.every((item: any) => item.policy.autoUseEnabled === false)).toBe(true);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("filters the Tool Catalog by risk and category", async () => {
    const response = await getAgency("/api/agency/tool-catalog?risk=high&category=input");

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBeGreaterThan(0);
    expect(response.body.data.items.every((item: any) => item.risk === "high")).toBe(true);
    expect(response.body.data.items.every((item: any) => item.category === "input")).toBe(true);
    expect(response.body.data.items.map((item: any) => item.id)).toEqual(
      expect.arrayContaining(["tap", "semantic_tap", "type_text"])
    );
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("lists the read-only Compiler Knowledge Base without enabling compiler auto-use", async () => {
    const response = await getAgency("/api/agency/compiler-knowledge");

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBeGreaterThan(5);
    expect(response.body.data.policy).toEqual({
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      mode: "read_only_knowledge_base",
    });
    expect(response.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workflow-failure-never-promotes",
          type: "rule",
          domain: "workflow_lifecycle",
          risk: "high",
          policy: expect.objectContaining({
            compilerVisible: false,
            autoUseEnabled: false,
            executionChanging: false,
          }),
        }),
        expect.objectContaining({
          id: "partial-feedback-creates-step-candidates-only",
          type: "rule",
          domain: "step_library",
          source: "qa_guardrail",
        }),
        expect.objectContaining({
          id: "login-wall-is-not-success",
          type: "anti_pattern",
          domain: "app_navigation",
        }),
      ])
    );
    expect(response.body.data.items.every((item: any) => item.policy.compilerVisible === false)).toBe(true);
    expect(response.body.data.items.every((item: any) => item.policy.autoUseEnabled === false)).toBe(true);
    expect(response.body.data.items.every((item: any) => item.policy.executionChanging === false)).toBe(true);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("filters the Compiler Knowledge Base by domain and type", async () => {
    const response = await getAgency("/api/agency/compiler-knowledge?domain=step_library&type=rule");

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBeGreaterThan(0);
    expect(response.body.data.items.every((item: any) => item.domain === "step_library")).toBe(true);
    expect(response.body.data.items.every((item: any) => item.type === "rule")).toBe(true);
    expect(response.body.data.items.map((item: any) => item.id)).toEqual(
      expect.arrayContaining(["partial-feedback-creates-step-candidates-only"])
    );
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("lists read-only Compiler Policy Gates without enabling auto-use", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [{
        gate_id: "compiler_auto_use",
        state: "blocked",
        version: 2,
        owner: "product",
        risk: "high",
        config: { source: "test" },
        updated_by: "test",
        updated_at: new Date("2026-05-22T10:30:00.000Z"),
      }],
    });

    const response = await getAgency("/api/agency/compiler-policy-gates");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toEqual({
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      mode: "read_only_compiler_policy_gates",
    });
    expect(response.body.data.total).toBeGreaterThanOrEqual(6);
    expect(response.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "compiler_auto_use",
          state: "blocked",
          risk: "high",
          blocks: expect.arrayContaining(["compiler_auto_use_disabled"]),
          requiredPolicyChanges: expect.arrayContaining(["compiler_auto_use"]),
          remediation: expect.objectContaining({
            state: "manual_review_required",
            safeToAutoApply: false,
          }),
          version: 2,
          configState: "blocked",
        }),
        expect.objectContaining({
          id: "step_compiler_eligibility",
          state: "blocked",
          blocks: expect.arrayContaining(["step_not_compiler_eligible"]),
          requiredPolicyChanges: expect.arrayContaining(["step_compiler_eligibility"]),
        }),
        expect.objectContaining({
          id: "execution_path_change",
          state: "blocked",
          blocks: expect.arrayContaining(["execution_changing_disabled"]),
        }),
      ])
    );
    expect(response.body.data.items.every((gate: any) => gate.remediation.safeToAutoApply === false)).toBe(true);
    expect(response.body.data.items.every((gate: any) => gate.state !== "enabled")).toBe(true);
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_compiler_policy_gate_config");
  });

  it("filters Compiler Policy Gates by category and risk", async () => {
    mocks.db.query.mockResolvedValueOnce({ rows: [] });

    const response = await getAgency("/api/agency/compiler-policy-gates?category=auto_use&risk=high");

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBe(1);
    expect(response.body.data.items[0]).toMatchObject({
      id: "compiler_auto_use",
      category: "auto_use",
      risk: "high",
      state: "blocked",
    });
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });

  it("updates Compiler Policy Gates with explicit audit and no execution enablement", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "blocked",
          version: 2,
          owner: "product",
          risk: "high",
          config: {},
          updated_by: "migration",
          updated_at: new Date("2026-05-22T10:30:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "enabled",
          version: 3,
          owner: "product",
          risk: "high",
          config: { explicitApproval: true },
          updated_by: "dashboard",
          updated_at: new Date("2026-05-22T10:35:00.000Z"),
        }],
      });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ gate_id: "compiler_auto_use", state: "enabled", version: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await patchAgency(
      "/api/agency/compiler-policy-gates/compiler_auto_use",
      { state: "enabled", note: "Dry-run only approval", config: { explicitApproval: true } }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      previousState: "blocked",
      nextState: "enabled",
      policy: expect.objectContaining({
        manualOnly: true,
        editableGates: true,
        autoUseEnabled: true,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
      gate: expect.objectContaining({
        id: "compiler_auto_use",
        state: "enabled",
        version: 3,
        remediation: expect.objectContaining({ safeToAutoApply: false }),
      }),
    });
    expect(String(mocks.client.query.mock.calls[1][0])).toContain("agency_compiler_policy_gate_config");
    expect(String(mocks.client.query.mock.calls[2][0])).toContain("agency_compiler_policy_gate_events");
    expect(mocks.client.query.mock.calls[3][0]).toBe("COMMIT");
  });

  it("creates a new Workflow Definition version with diff and impact preview only", async () => {
    const source = workflowDefinitionRow();
    const created = workflowDefinitionRow({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      version: 2,
      status: "draft",
      title: "Reddit account health scan v2",
      parent_definition_id: source.id,
      version_note: "Tighten read-only classifier",
      allowed_tools: ["open_app", "ui_tree_dump", "wait_for_idle"],
      source: "dashboard_version",
      created_by: "dashboard",
    });
    mocks.db.query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [{ next_version: "2" }] })
      .mockResolvedValueOnce({ rows: [
        { id: created.id, version: 2, status: "draft", promotion_state: "not_promoted", promotion_scope: null, promotion_confidence: null, updated_at: created.updated_at },
        { id: source.id, version: 1, status: "active", promotion_state: "not_promoted", promotion_scope: null, promotion_confidence: null, updated_at: source.updated_at },
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postAgency(
      `/api/agency/workflow-definitions/${source.id}/versions`,
      {
        status: "draft",
        title: "Reddit account health scan v2",
        note: "Tighten read-only classifier",
        allowedTools: ["open_app", "ui_tree_dump", "wait_for_idle"],
      }
    );

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      definition: {
        id: created.id,
        version: 2,
        status: "draft",
        parentDefinitionId: source.id,
        versionNote: "Tighten read-only classifier",
      },
      diff: {
        mode: "workflow_definition_version_diff",
        summary: expect.objectContaining({
          changedFields: expect.any(Number),
          allowedToolDelta: ["wait_for_idle"],
        }),
        wouldExecuteWorkflow: false,
        wouldChangeWorkflowCache: false,
      },
      impactPreview: expect.objectContaining({
        mode: "workflow_definition_impact_preview",
        wouldExecuteWorkflow: false,
        wouldChangeWorkflowCache: false,
      }),
      policy: expect.objectContaining({
        versioningEnabled: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
    });
    expect(String(mocks.client.query.mock.calls[1][0])).toContain("INSERT INTO agency_workflow_definitions");
    expect(String(mocks.client.query.mock.calls[2][0])).toContain("agency_workflow_definition_version_events");
    expect(mocks.client.query.mock.calls[3][0]).toBe("COMMIT");
  });

  it("lists Step Library promotion audit events without enabling reuse", async () => {
    const event = {
      id: "66666666-6666-4666-8666-666666666666",
      step_candidate_id: "55555555-5555-4555-8555-555555555555",
      action: "promote_limited",
      library_state: "limited_reuse",
      promotion_scope: "device:11111111-1111-4111-8111-111111111111",
      note: "safe for this device only",
      actor: "dashboard",
      metadata: { compilerEligible: false, autoUseEnabled: false },
      created_at: new Date("2026-05-22T10:10:00.000Z"),
      step_name: "unlock",
      step_action: "unlock",
      run_intent: "reddit_account_health_scan",
      device_name: "Pixel",
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency(
      "/api/agency/step-library/promotion-events?entryId=55555555-5555-4555-8555-555555555555&pageSize=20"
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(response.body.data.items[0]).toMatchObject({
      id: event.id,
      stepCandidateId: event.step_candidate_id,
      action: "promote_limited",
      libraryState: "limited_reuse",
      promotionScope: event.promotion_scope,
      actor: "dashboard",
      stepName: "unlock",
      runIntent: "reddit_account_health_scan",
    });
    expect(mocks.db.query.mock.calls[0][0]).toContain("agency_workflow_step_library_promotion_events e");
    expect(mocks.db.query.mock.calls[0][0]).toContain("e.step_candidate_id = $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual([
      "55555555-5555-4555-8555-555555555555",
      20,
      0,
    ]);
  });

  it("promotes a review-ready Step Library entry for limited reuse only", async () => {
    const validated = {
      id: "55555555-5555-4555-8555-555555555555",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 1,
      step_id: "unlock",
      label: "unlock",
      action: "unlock",
      type: null,
      step_status: "succeeded",
      candidate_state: "validated_step",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 1 },
      evidence: { source: "dashboard_partial_feedback" },
      note: "second step looked good",
      review_note: "contract ok",
      reviewed_by: "dashboard",
      reviewed_at: new Date("2026-05-22T10:08:00.000Z"),
      validation_contract: {
        scope: "phase_3c_live_smoke",
        preconditions: ["screen is awake"],
        postconditions: ["device is unlocked"],
        compatibility: { serverVersion: "3.9.113" },
      },
      validation_evidence: { source: "dashboard_manual_validation" },
      validated_by: "dashboard",
      validated_at: new Date("2026-05-22T10:08:00.000Z"),
      library_state: "review_only",
      promotion_scope: null,
      promotion_note: null,
      promoted_by: null,
      promoted_at: null,
      revoked_by: null,
      revoked_at: null,
      run_status: "completed",
      run_intent: "reddit_account_health_scan",
      device_name: "Pixel",
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:08:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [validated] })
      .mockResolvedValueOnce({
        rows: [{
          ...validated,
          library_state: "limited_reuse",
          promotion_scope: "device:11111111-1111-4111-8111-111111111111",
          promotion_note: "safe for this device only",
          promoted_by: "dashboard",
          promoted_at: new Date("2026-05-22T10:10:00.000Z"),
        }],
      });

    const response = await patchAgency(
      `/api/agency/step-library/${validated.id}/promotion`,
      {
        action: "promote_limited",
        scope: "device:11111111-1111-4111-8111-111111111111",
        note: "safe for this device only",
      }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: validated.id,
      libraryState: "limited_reuse",
      promotionScope: "device:11111111-1111-4111-8111-111111111111",
      reusable: true,
      compilerEligible: false,
      readiness: {
        state: "limited_reuse_ready",
        score: 1,
        blockers: ["compiler_auto_use_disabled"],
        gates: {
          limitedReusePromoted: true,
          compilerAutoUseEnabled: false,
        },
      },
    });
    expect(mocks.db.query.mock.calls[1][0]).toContain("library_state = 'limited_reuse'");
    expect(mocks.db.query.mock.calls[1][0]).not.toContain("compiler");
    expect(mocks.db.query.mock.calls[2][0]).toContain("agency_workflow_step_library_promotion_events");
    expect(mocks.db.query.mock.calls[2][1]).toEqual([
      validated.id,
      "promote_limited",
      "limited_reuse",
      "device:11111111-1111-4111-8111-111111111111",
      "safe for this device only",
      JSON.stringify({
        source: "dashboard",
        compilerEligible: false,
        autoUseEnabled: false,
      }),
    ]);
  });

  it("does not allow global Step Library promotion scope", async () => {
    const response = await patchAgency(
      "/api/agency/step-library/55555555-5555-4555-8555-555555555555/promotion",
      { action: "promote_limited", scope: "global" }
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("STEP_LIBRARY_GLOBAL_SCOPE_DISABLED");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("revokes limited Step Library reuse without demoting validation", async () => {
    const validated = {
      id: "55555555-5555-4555-8555-555555555555",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 1,
      step_id: "unlock",
      label: "unlock",
      action: "unlock",
      type: null,
      step_status: "succeeded",
      candidate_state: "validated_step",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 1 },
      evidence: { source: "dashboard_partial_feedback" },
      note: null,
      review_note: null,
      reviewed_by: "dashboard",
      reviewed_at: new Date("2026-05-22T10:08:00.000Z"),
      validation_contract: {
        scope: "phase_3c_live_smoke",
        preconditions: ["screen is awake"],
        postconditions: ["device is unlocked"],
        compatibility: { serverVersion: "3.9.113" },
      },
      validation_evidence: { source: "dashboard_manual_validation" },
      validated_by: "dashboard",
      validated_at: new Date("2026-05-22T10:08:00.000Z"),
      library_state: "limited_reuse",
      promotion_scope: "device:11111111-1111-4111-8111-111111111111",
      promotion_note: "safe for this device only",
      promoted_by: "dashboard",
      promoted_at: new Date("2026-05-22T10:10:00.000Z"),
      revoked_by: null,
      revoked_at: null,
      run_status: "completed",
      run_intent: "reddit_account_health_scan",
      device_name: "Pixel",
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:10:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [validated] })
      .mockResolvedValueOnce({
        rows: [{
          ...validated,
          library_state: "revoked",
          promotion_note: "scope no longer trusted",
          revoked_by: "dashboard",
          revoked_at: new Date("2026-05-22T10:12:00.000Z"),
        }],
      });

    const response = await patchAgency(
      `/api/agency/step-library/${validated.id}/promotion`,
      { action: "revoke", note: "scope no longer trusted" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: validated.id,
      status: "validated_step",
      libraryState: "revoked",
      reusable: false,
      compilerEligible: false,
      revokedBy: "dashboard",
    });
    expect(mocks.db.query.mock.calls[1][0]).toContain("library_state = 'revoked'");
    expect(mocks.db.query.mock.calls[1][0]).toContain("promotion_note = $2");
    expect(mocks.db.query.mock.calls[1][0]).not.toContain("$3");
    expect(mocks.db.query.mock.calls[1][1]).toEqual([
      validated.id,
      "scope no longer trusted",
    ]);
    expect(mocks.db.query.mock.calls[1][0]).not.toContain("candidate_state =");
    expect(mocks.db.query.mock.calls[2][0]).toContain("agency_workflow_step_library_promotion_events");
    expect(mocks.db.query.mock.calls[2][1]).toEqual([
      validated.id,
      "revoke",
      "revoked",
      "device:11111111-1111-4111-8111-111111111111",
      "scope no longer trusted",
      JSON.stringify({
        source: "dashboard",
        compilerEligible: false,
        autoUseEnabled: false,
      }),
    ]);
  });

  it("rejects a step candidate without promoting it", async () => {
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 0,
      step_id: "open_reddit",
      label: "open_app",
      action: "open_app",
      type: null,
      step_status: "succeeded",
      candidate_state: "step_candidate",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 0 },
      evidence: { source: "dashboard_partial_feedback" },
      note: "first step looked good",
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      validation_contract: {},
      validation_evidence: {},
      validated_by: null,
      validated_at: null,
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:06:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({
        rows: [{
          ...candidate,
          candidate_state: "rejected",
          review_note: "bad boundary",
          reviewed_by: "dashboard",
          reviewed_at: new Date("2026-05-22T10:07:00.000Z"),
        }],
      });

    const response = await patchAgency(
      `/api/agency/workflow-step-candidates/${candidate.id}/review`,
      { action: "reject", note: "bad boundary" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: candidate.id,
      candidateState: "rejected",
      reviewNote: "bad boundary",
      reviewedBy: "dashboard",
    });
    expect(mocks.db.query.mock.calls[1][0]).toContain("candidate_state = $2");
    expect(mocks.db.query.mock.calls[1][1]).toEqual([candidate.id, "rejected", "bad boundary"]);
    expect(mocks.db.query.mock.calls[1][0]).not.toContain("validated_step");
  });

  it("does not review validated steps from the lightweight candidate UI", async () => {
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      candidate_state: "validated_step",
    };
    mocks.db.query.mockResolvedValueOnce({ rows: [candidate] });

    const response = await patchAgency(
      `/api/agency/workflow-step-candidates/${candidate.id}/review`,
      { action: "reject", note: "do not reject" }
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VALIDATED_STEP_REVIEW_LOCKED");
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });

  it("validates a step candidate only with contract and evidence", async () => {
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      run_id: "33333333-3333-4333-8333-333333333333",
      step_index: 0,
      step_id: "open_reddit",
      label: "open_app",
      action: "open_app",
      type: null,
      step_status: "succeeded",
      candidate_state: "step_candidate",
      request_key: "c02c59dfbe512562f8c65c97",
      cache_key: null,
      canonical_workflow_id: "agent_generated_reddit_account_health_scan_v1",
      canonical_workflow_version: "1.0.0",
      last_good_step_index: 1,
      step_snapshot: { index: 0 },
      evidence: { source: "dashboard_partial_feedback" },
      note: "first step looked good",
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      validation_contract: {},
      validation_evidence: {},
      validated_by: null,
      validated_at: null,
      created_at: new Date("2026-05-22T10:06:00.000Z"),
      updated_at: new Date("2026-05-22T10:06:00.000Z"),
    };
    const contract = {
      preconditions: ["Reddit is installed"],
      postconditions: ["Reddit home or login surface is visible"],
      sideEffects: ["opens app"],
    };
    const evidence = {
      source: "dashboard_manual_validation",
      runId: candidate.run_id,
      stepIndex: candidate.step_index,
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({
        rows: [{
          ...candidate,
          candidate_state: "validated_step",
          validation_contract: contract,
          validation_evidence: evidence,
          review_note: "contract ok",
          reviewed_by: "dashboard",
          reviewed_at: new Date("2026-05-22T10:08:00.000Z"),
          validated_by: "dashboard",
          validated_at: new Date("2026-05-22T10:08:00.000Z"),
        }],
      });

    const response = await patchAgency(
      `/api/agency/workflow-step-candidates/${candidate.id}/validate`,
      { contract, evidence, note: "contract ok" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: candidate.id,
      candidateState: "validated_step",
      validationContract: contract,
      validationEvidence: evidence,
      validatedBy: "dashboard",
    });
    expect(mocks.db.query.mock.calls[1][0]).toContain("candidate_state = 'validated_step'");
    expect(mocks.db.query.mock.calls[1][1]).toEqual([candidate.id, contract, evidence, "contract ok"]);
  });

  it("requires validation preconditions postconditions and evidence", async () => {
    const response = await patchAgency(
      "/api/agency/workflow-step-candidates/44444444-4444-4444-8444-444444444444/validate",
      { contract: { preconditions: [], postconditions: ["done"] }, evidence: {} }
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_PRECONDITIONS_REQUIRED");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("does not validate rejected candidates", async () => {
    const candidate = {
      id: "44444444-4444-4444-8444-444444444444",
      candidate_state: "rejected",
    };
    mocks.db.query.mockResolvedValueOnce({ rows: [candidate] });

    const response = await patchAgency(
      `/api/agency/workflow-step-candidates/${candidate.id}/validate`,
      {
        contract: { preconditions: ["known input"], postconditions: ["known output"] },
        evidence: { source: "test" },
      }
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STEP_CANDIDATE_NOT_IN_REVIEW");
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });

  it("exposes compiler awareness without enabling step auto-use", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [{
        id: "55555555-5555-4555-8555-555555555555",
        label: "unlock",
        action: "unlock",
        type: null,
        candidate_state: "validated_step",
        library_state: "limited_reuse",
        promotion_scope: "device:test-device",
        validation_contract: {
          preconditions: ["device screen is awake"],
          postconditions: ["device unlocked"],
        },
        validation_evidence: { source: "test" },
        run_intent: "unlock device",
        device_name: "Pixel",
        validated_at: new Date("2026-05-22T10:08:00.000Z"),
      }],
    }).mockResolvedValueOnce({ rows: [] });

    const response = await getAgency("/api/agency/compiler-awareness?intent=unlock%20device");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      mode: "read_only_compiler_awareness",
    });
    expect(response.body.data.summary.stepCandidates).toBe(1);
    expect(response.body.data.candidates.steps[0]).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      action: "unlock",
      compilerEligible: false,
      wouldUse: false,
      reason: "compiler_auto_use_disabled",
      eligibility: {
        state: "blocked",
        gates: {
          validatedStep: true,
          limitedReusePromoted: true,
          notRevoked: true,
          scopedReuseDeclared: true,
          compilerEligiblePolicy: false,
          autoUseEnabled: false,
        },
        blockers: expect.arrayContaining(["compiler_auto_use_disabled", "step_not_compiler_eligible"]),
        policyGates: expect.arrayContaining([
          expect.objectContaining({ id: "compiler_auto_use", state: "blocked", safeToAutoApply: false }),
          expect.objectContaining({ id: "step_compiler_eligibility", state: "blocked", safeToAutoApply: false }),
        ]),
        remediation: {
          state: "manual_review_required",
          safeToAutoApply: false,
          nextActions: expect.arrayContaining([
            expect.stringContaining("auto-use"),
            expect.stringContaining("compilerEligible=false"),
          ]),
          requiredPolicyChanges: expect.arrayContaining(["compiler_auto_use", "step_compiler_eligibility"]),
        },
      },
    });
    expect(response.body.data.decision).toMatchObject({
      outcome: "blocked_by_policy",
      wouldChangePlan: false,
      wouldExecuteStepLibrary: false,
      blockers: expect.arrayContaining(["compiler_auto_use_disabled"]),
      policyGateSummary: expect.arrayContaining([
        expect.objectContaining({ id: "compiler_auto_use", state: "blocked", safeToAutoApply: false }),
      ]),
      remediation: {
        state: "manual_review_required",
        safeToAutoApply: false,
        requiredPolicyChanges: expect.arrayContaining(["compiler_auto_use"]),
      },
    });
    expect(response.body.data.policyGateSummary).toMatchObject({
      total: 4,
      blocked: 4,
      highRisk: 2,
      safeToAutoApply: 0,
      gates: expect.arrayContaining([
        expect.objectContaining({ id: "compiler_tool_visibility", state: "blocked", safeToAutoApply: false }),
        expect.objectContaining({ id: "compiler_knowledge_application", state: "blocked", safeToAutoApply: false }),
        expect.objectContaining({ id: "step_compiler_eligibility", state: "blocked", safeToAutoApply: false }),
        expect.objectContaining({ id: "compiler_auto_use", state: "blocked", safeToAutoApply: false }),
      ]),
    });
    expect(response.body.data.candidates.tools.some((tool: any) => tool.id === "unlock" && tool.wouldUse === false)).toBe(true);
    expect(response.body.data.candidates.knowledge.every((entry: any) => entry.wouldApply === false)).toBe(true);
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("c.candidate_state = 'validated_step'");
    expect(String(mocks.db.query.mock.calls[1][0])).toContain("agency_compiler_awareness_events");
    expect(mocks.db.query.mock.calls[1][1][0]).toBe("unlock device");
    expect(mocks.db.query.mock.calls[1][1][4]).toContain("\"autoUseEnabled\":false");
    expect(mocks.db.query.mock.calls[1][1][5]).toContain("\"wouldUse\":false");
    expect(mocks.db.query.mock.calls[1][1][5]).toContain("\"eligibility\"");
    expect(mocks.db.query.mock.calls[1][1][5]).toContain("\"policyGates\"");
    expect(mocks.db.query.mock.calls[1][1][5]).toContain("\"remediation\"");
    expect(mocks.db.query.mock.calls[1][1][5]).toContain("\"step_not_compiler_eligible\"");
    expect(mocks.db.query.mock.calls[1][1][6]).toContain("\"outcome\":\"blocked_by_policy\"");
    expect(mocks.db.query.mock.calls[1][1][6]).toContain("\"policyGateSummary\"");
    expect(mocks.db.query.mock.calls[1][1][6]).toContain("\"safeToAutoApply\":false");
  });

  it("exposes Compiler Control Plane dry-run without changing execution", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          label: "unlock",
          action: "unlock",
          type: null,
          candidate_state: "validated_step",
          library_state: "limited_reuse",
          promotion_scope: "device:test-device",
          validation_contract: {
            preconditions: ["device screen is awake"],
            postconditions: ["device unlocked"],
          },
          validation_evidence: { source: "test" },
          run_intent: "unlock device",
          device_name: "Pixel",
          validated_at: new Date("2026-05-22T10:08:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "blocked",
          version: 3,
          owner: "product",
          risk: "high",
          config: { source: "test" },
          updated_by: "test",
          updated_at: new Date("2026-05-22T10:35:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          friendly_name: "Pixel",
          model: "Pixel 8",
          android_version: "15",
          agent_version: "4.0.24",
          status: "online",
          last_seen_at: new Date("2026-05-22T10:34:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await getAgency("/api/agency/compiler-control-plane?intent=unlock%20device&scope=device:test-device");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
      mode: "compiler_control_plane_read_only",
    });
    expect(response.body.data.policyGates.summary).toMatchObject({
      total: expect.any(Number),
      blocked: expect.any(Number),
      safeToAutoApply: 0,
    });
    expect(response.body.data.dryRun).toMatchObject({
      mode: "scoped_compiler_dry_run_read_only",
      wouldUseStepLibrary: false,
      wouldChangePlan: false,
      wouldExecuteStepLibrary: false,
      selectedStepIds: [],
      selectedToolIds: [],
      safeToAutoApply: false,
      outcome: "blocked_by_policy",
    });
    expect(response.body.data.capabilityManifest).toMatchObject({
      source: "server_inferred_manifest",
      publishedByDevice: false,
      deviceSelected: true,
      deviceName: "Pixel",
      compatibility: expect.objectContaining({ state: "known_device" }),
    });
    expect(response.body.data.limitedReusePlan).toMatchObject({
      mode: "limited_reuse_planning_read_only",
      requestedScope: "device:test-device",
      summary: expect.objectContaining({
        candidates: 1,
        wouldUse: 0,
        safeToAutoApply: 0,
      }),
    });
    expect(response.body.data.limitedReusePlan.items[0]).toMatchObject({
      action: "unlock",
      scopeMatch: true,
      capabilityMatch: true,
      wouldUse: false,
      safeToAutoApply: false,
      blockers: expect.arrayContaining(["compiler_auto_use_disabled", "step_not_compiler_eligible"]),
    });
    expect(String(mocks.db.query.mock.calls[1][0])).toContain("agency_compiler_policy_gate_config");
    expect(String(mocks.db.query.mock.calls[3][0])).toContain("agency_compiler_control_plane_events");
    expect(mocks.db.query.mock.calls[3][1][5]).toContain("\"autoUseEnabled\":false");
    expect(mocks.db.query.mock.calls[3][1][6]).toContain("\"wouldExecuteStepLibrary\":false");
    expect(mocks.db.query.mock.calls[3][1][8]).toContain("\"wouldUse\":0");
  });

  it("lists Workflow Definition Registry entries without enabling compiler use", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [{
        id: "99999999-9999-4999-8999-999999999999",
        definition_key: "reddit_account_health_scan",
        version: 1,
        status: "active",
        title: "Reddit account health scan",
        description: "Read-only workflow definition",
        platform: "reddit",
        intent: "reddit_account_health_scan",
        goal: "Classify Reddit account health without side effects",
        source: "static_seed",
        definition: { steps: ["open_reddit", "classify_reddit_health_scan"] },
        success_criteria: ["loggedIn classified", "screenState classified"],
        allowed_tools: ["open_app", "ui_tree_dump"],
        required_capabilities: ["device.online_or_approved"],
        constraints: ["read_only_only"],
        fallback_rules: ["if login wall detected classify expected_failure"],
        rollback: { required: false },
        policy: {
          readOnly: true,
          compilerVisible: false,
          autoUseEnabled: false,
          executionChanging: false,
          workflowCacheChanging: false,
        },
        created_by: "migration",
        created_at: new Date("2026-05-22T11:00:00.000Z"),
        updated_at: new Date("2026-05-22T11:00:00.000Z"),
      }],
    });

    const response = await getAgency("/api/agency/workflow-definitions?platform=reddit&status=active");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
      mode: "workflow_definition_registry_read_only",
    });
    expect(response.body.data.summary).toMatchObject({ active: 1, draft: 0 });
    expect(response.body.data.items[0]).toMatchObject({
      key: "reddit_account_health_scan",
      version: 1,
      status: "active",
      platform: "reddit",
      intent: "reddit_account_health_scan",
      allowedTools: ["open_app", "ui_tree_dump"],
      policy: expect.objectContaining({
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
      }),
      summary: {
        successCriteria: 2,
        allowedTools: 2,
        requiredCapabilities: 1,
        constraints: 1,
        fallbackRules: 1,
      },
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_workflow_definitions");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("status = $1");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("platform = $2");
    expect(mocks.db.query.mock.calls[0][1]).toEqual(["active", "reddit"]);
  });

  it("previews Workflow Definition resolution without changing plans or cache", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "99999999-9999-4999-8999-999999999999",
          definition_key: "reddit_account_health_scan",
          version: 1,
          status: "active",
          title: "Reddit account health scan",
          description: "Read-only workflow definition",
          platform: "reddit",
          intent: "reddit_account_health_scan",
          goal: "Classify Reddit account health without side effects",
          source: "static_seed",
          definition: {
            steps: ["open_reddit", "classify_reddit_health_scan"],
            terminalStates: ["success", "expected_failure", "quarantined"],
            sideEffects: [],
          },
          success_criteria: ["loggedIn classified", "screenState is one of the known Reddit states"],
          allowed_tools: ["open_app", "ui_tree_dump"],
          required_capabilities: ["device.online_or_approved"],
          constraints: ["read_only_only"],
          fallback_rules: ["if login wall detected classify expected_failure"],
          rollback: { required: false },
          policy: {},
          created_by: "migration",
          created_at: new Date("2026-05-22T11:00:00.000Z"),
          updated_at: new Date("2026-05-22T11:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "blocked",
          version: 1,
          owner: "product",
          risk: "high",
          config: {},
          updated_by: "migration",
          updated_at: new Date("2026-05-22T11:00:00.000Z"),
        }],
      });

    const response = await getAgency("/api/agency/workflow-definitions/resolve?intent=reddit_account_health_scan&platform=reddit");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      outcome: "blocked_by_policy",
      wouldUseDefinition: false,
      wouldChangePlan: false,
      wouldChangeWorkflowCache: false,
      wouldExecuteWorkflow: false,
      selectedDefinitionId: null,
      blockers: expect.arrayContaining([
        "compiler_visibility_gate_disabled",
        "limited_reuse_scope_gate_disabled",
        "compiler_auto_use_disabled",
        "execution_changing_disabled",
        "workflow_definition_not_limited_reuse",
      ]),
      candidateDefinition: expect.objectContaining({
        key: "reddit_account_health_scan",
        platform: "reddit",
      }),
      rollbackPreview: expect.objectContaining({
        available: true,
        wouldRollback: false,
      }),
      policyGateSummary: expect.objectContaining({
        safeToAutoApply: 0,
      }),
      controlledDecision: expect.objectContaining({
        wouldUseDefinition: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_workflow_definitions");
    expect(String(mocks.db.query.mock.calls[1][0])).toContain("agency_compiler_policy_gate_config");
  });

  it("can dry-run a controlled Workflow Definition auto-use decision without execution or cache changes", async () => {
    const definition = workflowDefinitionRow({
      promotion_state: "limited_reuse",
      promotion_scope: "device:pixel-1",
      promotion_confidence: "0.86",
      promotion_readiness: { state: "manual_limited_promotion_ready", validation: "passed" },
      promotion_scope_details: { type: "device", value: "pixel-1", globalBlocked: true },
      rollback_preview: { available: true, wouldRollbackNow: false },
      promoted_at: new Date("2026-05-22T11:30:00.000Z"),
      promoted_by: "dashboard",
    });
    mocks.db.query
      .mockResolvedValueOnce({ rows: [definition] })
      .mockResolvedValueOnce({
        rows: [
          {
            gate_id: "compiler_knowledge_application",
            state: "enabled",
            version: 2,
            owner: "product",
            risk: "medium",
            config: { explicitApproval: true },
            updated_by: "dashboard",
            updated_at: new Date("2026-05-22T11:35:00.000Z"),
          },
          {
            gate_id: "limited_reuse_scope_match",
            state: "enabled",
            version: 2,
            owner: "product",
            risk: "medium",
            config: { explicitApproval: true },
            updated_by: "dashboard",
            updated_at: new Date("2026-05-22T11:35:00.000Z"),
          },
          {
            gate_id: "compiler_auto_use",
            state: "enabled",
            version: 2,
            owner: "product",
            risk: "high",
            config: { explicitApproval: true },
            updated_by: "dashboard",
            updated_at: new Date("2026-05-22T11:35:00.000Z"),
          },
        ],
      });

    const response = await getAgency(
      "/api/agency/workflow-definitions/resolve?intent=reddit_account_health_scan&platform=reddit&scope=device:pixel-1"
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      outcome: "would_use_definition_dry_run_only",
      requestedScope: "device:pixel-1",
      wouldUseDefinition: true,
      wouldChangePlan: true,
      wouldChangeWorkflowCache: false,
      wouldExecuteWorkflow: false,
      selectedDefinitionId: definition.id,
      blockers: ["execution_changing_disabled"],
      controlledDecision: expect.objectContaining({
        wouldUseDefinition: true,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
    });
  });

  it("previews Workflow Validation Pipeline without promotion, cache, or execution changes", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "99999999-9999-4999-8999-999999999999",
          definition_key: "reddit_account_health_scan",
          version: 1,
          status: "active",
          title: "Reddit account health scan",
          description: "Read-only workflow definition",
          platform: "reddit",
          intent: "reddit_account_health_scan",
          goal: "Classify Reddit account health without side effects",
          source: "static_seed",
          definition: {
            steps: ["open_reddit", "classify_reddit_health_scan"],
            terminalStates: ["success", "expected_failure", "quarantined"],
            sideEffects: [],
          },
          success_criteria: ["loggedIn classified", "screenState is one of the known Reddit states"],
          allowed_tools: ["open_app", "ui_tree_dump"],
          required_capabilities: ["device.online_or_approved"],
          constraints: ["read_only_only"],
          fallback_rules: ["if login wall detected classify expected_failure"],
          rollback: { required: false },
          policy: {},
          created_by: "migration",
          created_at: new Date("2026-05-22T11:00:00.000Z"),
          updated_at: new Date("2026-05-22T11:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "blocked",
          version: 1,
          owner: "product",
          risk: "high",
          config: {},
          updated_by: "migration",
          updated_at: new Date("2026-05-22T11:00:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await getAgency("/api/agency/workflow-validation-pipeline?intent=reddit_account_health_scan&platform=reddit");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      validationOnly: true,
      autoPromotionEnabled: false,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
      mode: "workflow_validation_pipeline_read_only",
    });
    expect(response.body.data.summary).toMatchObject({
      definitions: 1,
      staticPassed: 1,
      staticWarnings: 0,
      dryRunBlocked: 1,
      dryRunFixtures: 4,
      branchCoveragePercent: 50,
      wouldPromoteDefinition: 0,
      wouldUseDefinition: 0,
      wouldExecuteWorkflow: 0,
      safeToAutoApply: 0,
    });
    expect(response.body.data.items[0]).toMatchObject({
      definition: expect.objectContaining({
        key: "reddit_account_health_scan",
        platform: "reddit",
      }),
      staticValidation: expect.objectContaining({
        state: "passed",
        errors: 0,
        warnings: 0,
        contract: expect.objectContaining({
          terminalStates: 3,
          sideEffects: 0,
        }),
      }),
      dryRun: expect.objectContaining({
        mode: "workflow_definition_dry_run_preview",
        branchCoverage: expect.objectContaining({
          coveragePercent: 50,
          coveredBranches: 2,
        }),
        wouldUseDefinition: false,
        wouldChangePlan: false,
        wouldChangeWorkflowCache: false,
        wouldExecuteWorkflow: false,
        selectedDefinitionId: null,
        outcome: "blocked_by_policy",
      }),
      smokeReadiness: expect.objectContaining({
        state: "blocked",
        score: expect.any(Number),
      }),
      decision: expect.objectContaining({
        outcome: "blocked_by_policy",
        validationScore: 58,
        promotionReadiness: "not_ready",
        wouldPromoteDefinition: false,
        wouldUseDefinition: false,
        wouldExecuteWorkflow: false,
        wouldChangePlan: false,
        wouldChangeWorkflowCache: false,
        safeToAutoApply: false,
        selectedDefinitionId: null,
      }),
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_workflow_definitions");
    expect(String(mocks.db.query.mock.calls[1][0])).toContain("agency_compiler_policy_gate_config");
    expect(String(mocks.db.query.mock.calls[2][0])).toContain("agency_workflow_validation_events");
    expect(mocks.db.query.mock.calls[2][1][6]).toContain("\"autoPromotionEnabled\":false");
    expect(mocks.db.query.mock.calls[2][1][8]).toContain("\"wouldExecuteWorkflow\":false");
    expect(mocks.db.query.mock.calls[2][1][12]).toContain("\"wouldPromoteDefinition\":false");
  });

  it("lists Workflow Validation Pipeline events without enabling execution", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "88888888-8888-4888-8888-888888888888",
          definition_id: "99999999-9999-4999-8999-999999999999",
          definition_key: "reddit_account_health_scan",
          definition_version: 1,
          intent: "reddit_account_health_scan",
          platform: "reddit",
          summary: { definitions: 1, safeToAutoApply: 0 },
          policy: { readOnly: true, autoPromotionEnabled: false },
          static_validation: { state: "passed" },
          dry_run: { wouldExecuteWorkflow: false },
          smoke_readiness: { state: "blocked" },
          canary_readiness: { state: "blocked" },
          regression_readiness: { state: "blocked" },
          decision: { outcome: "blocked_by_policy", wouldPromoteDefinition: false },
          actor: "dashboard",
          source: "dashboard",
          created_at: new Date("2026-05-22T11:15:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency("/api/agency/workflow-validation-pipeline/events?key=reddit_account_health_scan");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      autoPromotionEnabled: false,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
    });
    expect(response.body.data.items[0]).toMatchObject({
      definitionKey: "reddit_account_health_scan",
      definitionVersion: 1,
      dryRun: expect.objectContaining({ wouldExecuteWorkflow: false }),
      decision: expect.objectContaining({ wouldPromoteDefinition: false }),
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_workflow_validation_events");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("definition_key = $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual(["reddit_account_health_scan", 50, 0]);
  });

  it("promotes a workflow definition to limited reuse without enabling compiler or execution", async () => {
    const definitionRow = {
      id: "99999999-9999-4999-8999-999999999999",
      definition_key: "device_unlock",
      version: 1,
      status: "active",
      title: "Device unlock",
      description: "Unlock device definition",
      platform: "android",
      intent: "device_unlock",
      goal: "Unlock the device without changing workflow cache",
      source: "static_seed",
      definition: {
        steps: ["wake_device", "swipe_unlock", "verify_home"],
        terminalStates: ["success", "expected_failure", "needs_review", "quarantined"],
        sideEffects: [],
      },
      success_criteria: ["home screen visible", "no challenge detected"],
      allowed_tools: ["wake_device", "gesture_swipe", "ui_tree_dump"],
      required_capabilities: ["device.online_or_approved"],
      constraints: ["read_only_validation", "limited_scope_only"],
      fallback_rules: [
        "if device unavailable or timeout classify needs_review",
        "if manual review is required record partial boundary",
      ],
      rollback: { required: false },
      policy: {},
      promotion_state: "review_only",
      promotion_scope: null,
      promotion_note: null,
      promoted_by: null,
      promoted_at: null,
      revoked_by: null,
      revoked_at: null,
      created_by: "migration",
      created_at: new Date("2026-05-22T11:00:00.000Z"),
      updated_at: new Date("2026-05-22T11:00:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [definitionRow] })
      .mockResolvedValueOnce({
        rows: [{
          gate_id: "compiler_auto_use",
          state: "blocked",
          version: 1,
          owner: "product",
          risk: "high",
          config: {},
          updated_by: "migration",
          updated_at: new Date("2026-05-22T11:00:00.000Z"),
        }],
      });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          ...definitionRow,
          promotion_state: "limited_reuse",
          promotion_scope: "device:test-device",
          promotion_note: "Manual approval for one device",
          promotion_confidence: 0.83,
          promotion_readiness: { state: "manual_limited_promotion_ready", validationScore: 75, branchCoveragePercent: 100 },
          promotion_scope_details: { scope: "device:test-device", scopeType: "device", globalScopeAllowed: false },
          rollback_preview: { available: false, wouldRollbackNow: false },
          promoted_by: "dashboard",
          promoted_at: new Date("2026-05-22T11:10:00.000Z"),
          updated_at: new Date("2026-05-22T11:10:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await patchAgency(
      "/api/agency/workflow-definitions/99999999-9999-4999-8999-999999999999/promotion",
      { action: "promote_limited", scope: "device:test-device", note: "Manual approval for one device" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      action: "promote_limited",
      previousState: "review_only",
      nextState: "limited_reuse",
      policy: {
        manualOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldUseDefinition: false,
        wouldChangePlan: false,
        wouldChangeWorkflowCache: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      },
      definition: expect.objectContaining({
        key: "device_unlock",
        promotion: expect.objectContaining({
          state: "limited_reuse",
          scope: "device:test-device",
          confidence: 0.83,
          readiness: expect.objectContaining({
            state: "manual_limited_promotion_ready",
            validationScore: 75,
            branchCoveragePercent: 100,
          }),
          scopeDetails: expect.objectContaining({
            scopeType: "device",
            globalScopeAllowed: false,
          }),
          reusable: true,
          compilerEligible: false,
          wouldUseDefinition: false,
          autoUseEnabled: false,
        }),
      }),
      validationSnapshot: expect.objectContaining({
        decision: expect.objectContaining({
          wouldPromoteDefinition: false,
          wouldUseDefinition: false,
          wouldExecuteWorkflow: false,
          safeToAutoApply: false,
        }),
      }),
      promotionConfidence: 0.83,
      promotionReadiness: expect.objectContaining({
        state: "manual_limited_promotion_ready",
        validationScore: 75,
      }),
      promotionScopeDetails: expect.objectContaining({
        scope: "device:test-device",
        globalScopeAllowed: false,
      }),
      rollbackPreview: expect.objectContaining({
        wouldRollbackNow: false,
        wouldExecuteWorkflow: false,
      }),
    });
    expect(mocks.client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(String(mocks.client.query.mock.calls[1][0])).toContain("SET promotion_state = 'limited_reuse'");
    expect(mocks.client.query.mock.calls[1][1].slice(0, 4)).toEqual([
      "99999999-9999-4999-8999-999999999999",
      "device:test-device",
      "Manual approval for one device",
      0.83,
    ]);
    expect(mocks.client.query.mock.calls[1][1][4]).toContain("\"state\":\"manual_limited_promotion_ready\"");
    expect(mocks.client.query.mock.calls[1][1][5]).toContain("\"scopeType\":\"device\"");
    expect(mocks.client.query.mock.calls[1][1][6]).toContain("\"wouldRollbackNow\":false");
    expect(String(mocks.client.query.mock.calls[2][0])).toContain("agency_workflow_definition_promotion_events");
    expect(mocks.client.query.mock.calls[2][1][3]).toBe("promote_limited");
    expect(mocks.client.query.mock.calls[2][1][4]).toBe("review_only");
    expect(mocks.client.query.mock.calls[2][1][5]).toBe("limited_reuse");
    expect(mocks.client.query.mock.calls[2][1][8]).toContain("\"manualOnly\":true");
    expect(mocks.client.query.mock.calls[2][1][9]).toContain("\"wouldExecuteWorkflow\":false");
    expect(mocks.client.query.mock.calls[2][1][10]).toBe(0.83);
    expect(mocks.client.query.mock.calls[2][1][11]).toContain("\"state\":\"manual_limited_promotion_ready\"");
    expect(mocks.client.query.mock.calls[2][1][12]).toContain("\"scopeType\":\"device\"");
    expect(mocks.client.query.mock.calls[2][1][13]).toContain("\"wouldRollbackNow\":false");
    expect(mocks.client.query.mock.calls[3][0]).toBe("COMMIT");
  });

  it("rejects global workflow definition promotion scope", async () => {
    const response = await patchAgency(
      "/api/agency/workflow-definitions/99999999-9999-4999-8999-999999999999/promotion",
      { action: "promote_limited", scope: "global" }
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "WORKFLOW_DEFINITION_GLOBAL_SCOPE_DISABLED",
    });
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("revokes workflow definition promotion and records an audit event", async () => {
    const definitionRow = {
      id: "99999999-9999-4999-8999-999999999999",
      definition_key: "device_unlock",
      version: 1,
      status: "active",
      title: "Device unlock",
      description: "Unlock device definition",
      platform: "android",
      intent: "device_unlock",
      goal: "Unlock the device without changing workflow cache",
      source: "static_seed",
      definition: {
        steps: ["wake_device", "swipe_unlock", "verify_home"],
        terminalStates: ["success", "expected_failure", "needs_review", "quarantined"],
        sideEffects: [],
      },
      success_criteria: ["home screen visible", "no challenge detected"],
      allowed_tools: ["wake_device", "gesture_swipe", "ui_tree_dump"],
      required_capabilities: ["device.online_or_approved"],
      constraints: ["read_only_validation", "limited_scope_only"],
      fallback_rules: [
        "if device unavailable or timeout classify needs_review",
        "if manual review is required record partial boundary",
      ],
      rollback: { required: false },
      policy: {},
      promotion_state: "limited_reuse",
      promotion_scope: "device:test-device",
      promotion_note: "Manual approval",
      promoted_by: "dashboard",
      promoted_at: new Date("2026-05-22T11:10:00.000Z"),
      revoked_by: null,
      revoked_at: null,
      created_by: "migration",
      created_at: new Date("2026-05-22T11:00:00.000Z"),
      updated_at: new Date("2026-05-22T11:10:00.000Z"),
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [definitionRow] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          ...definitionRow,
          promotion_state: "revoked",
          promotion_scope: null,
          promotion_note: "Bad scope",
          promotion_confidence: 0,
          promotion_readiness: { state: "revoked" },
          promotion_scope_details: { globalScopeAllowed: false },
          rollback_preview: { available: false, wouldRollbackNow: false },
          revoked_by: "dashboard",
          revoked_at: new Date("2026-05-22T11:20:00.000Z"),
          updated_at: new Date("2026-05-22T11:20:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await patchAgency(
      "/api/agency/workflow-definitions/99999999-9999-4999-8999-999999999999/promotion",
      { action: "revoke", note: "Bad scope" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      action: "revoke",
      previousState: "limited_reuse",
      nextState: "revoked",
      definition: expect.objectContaining({
        promotion: expect.objectContaining({
          state: "revoked",
          confidence: 0,
          readiness: expect.objectContaining({ state: "revoked" }),
          reusable: false,
          compilerEligible: false,
          wouldUseDefinition: false,
        }),
      }),
      policy: expect.objectContaining({
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
    });
    expect(mocks.client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(String(mocks.client.query.mock.calls[1][0])).toContain("SET promotion_state = 'revoked'");
    expect(String(mocks.client.query.mock.calls[2][0])).toContain("agency_workflow_definition_promotion_events");
    expect(mocks.client.query.mock.calls[2][1][3]).toBe("revoke");
    expect(mocks.client.query.mock.calls[2][1][4]).toBe("limited_reuse");
    expect(mocks.client.query.mock.calls[2][1][5]).toBe("revoked");
    expect(mocks.client.query.mock.calls[2][1][10]).toBe(0);
    expect(mocks.client.query.mock.calls[2][1][11]).toContain("\"state\":\"revoked\"");
    expect(mocks.client.query.mock.calls[3][0]).toBe("COMMIT");
  });

  it("previews workflow definition rollback without changing compiler or execution", async () => {
    const current = {
      id: "99999999-9999-4999-8999-999999999999",
      definition_key: "device_unlock",
      version: 2,
      status: "active",
      title: "Device unlock",
      description: "Unlock device definition",
      platform: "android",
      intent: "device_unlock",
      goal: "Unlock the device without changing workflow cache",
      source: "static_seed",
      definition: {
        steps: ["wake_device", "swipe_unlock", "verify_home"],
        terminalStates: ["success", "expected_failure", "needs_review", "quarantined"],
        sideEffects: [],
      },
      success_criteria: ["home screen visible", "no challenge detected"],
      allowed_tools: ["wake_device", "gesture_swipe", "ui_tree_dump"],
      required_capabilities: ["device.online_or_approved"],
      constraints: ["read_only_validation", "limited_scope_only"],
      fallback_rules: ["if device unavailable or timeout classify needs_review"],
      rollback: { required: true },
      policy: {},
      promotion_state: "limited_reuse",
      promotion_scope: "device:test-device",
      promotion_note: "Manual approval",
      promotion_confidence: 0.83,
      promotion_readiness: { state: "manual_limited_promotion_ready" },
      promotion_scope_details: { scopeType: "device" },
      rollback_preview: {},
      created_by: "migration",
      created_at: new Date("2026-05-22T11:00:00.000Z"),
      updated_at: new Date("2026-05-22T11:10:00.000Z"),
    };
    const previous = {
      ...current,
      id: "88888888-8888-4888-8888-888888888888",
      version: 1,
      promotion_state: "review_only",
      promotion_scope: null,
      promotion_confidence: 0.5,
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [previous] });

    const response = await getAgency("/api/agency/workflow-definitions/99999999-9999-4999-8999-999999999999/rollback-preview");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      mode: "workflow_definition_rollback_preview",
      available: true,
      wouldRollbackNow: false,
      wouldChangePlan: false,
      wouldChangeWorkflowCache: false,
      wouldExecuteWorkflow: false,
      requiresManualRollback: true,
      selectedTarget: expect.objectContaining({
        id: "88888888-8888-4888-8888-888888888888",
        version: 1,
      }),
      policy: expect.objectContaining({
        readOnly: true,
        rollbackPreviewOnly: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
      }),
    });
  });

  it("rolls back workflow definition promotion metadata without changing execution", async () => {
    const current = {
      id: "99999999-9999-4999-8999-999999999999",
      definition_key: "device_unlock",
      version: 2,
      status: "active",
      title: "Device unlock",
      description: "Unlock device definition",
      platform: "android",
      intent: "device_unlock",
      goal: "Unlock the device without changing workflow cache",
      source: "static_seed",
      definition: {
        steps: ["wake_device", "swipe_unlock", "verify_home"],
        terminalStates: ["success", "expected_failure", "needs_review", "quarantined"],
        sideEffects: [],
      },
      success_criteria: ["home screen visible", "no challenge detected"],
      allowed_tools: ["wake_device", "gesture_swipe", "ui_tree_dump"],
      required_capabilities: ["device.online_or_approved"],
      constraints: ["read_only_validation", "limited_scope_only"],
      fallback_rules: ["if device unavailable or timeout classify needs_review"],
      rollback: { required: true },
      policy: {},
      promotion_state: "limited_reuse",
      promotion_scope: "device:test-device",
      promotion_note: "Manual approval",
      promotion_confidence: 0.83,
      promotion_readiness: { state: "manual_limited_promotion_ready" },
      promotion_scope_details: { scopeType: "device" },
      rollback_preview: {},
      created_by: "migration",
      created_at: new Date("2026-05-22T11:00:00.000Z"),
      updated_at: new Date("2026-05-22T11:10:00.000Z"),
    };
    const previous = {
      ...current,
      id: "88888888-8888-4888-8888-888888888888",
      version: 1,
      promotion_state: "review_only",
      promotion_scope: null,
      promotion_confidence: 0.5,
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [previous] })
      .mockResolvedValueOnce({ rows: [previous] });
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          ...current,
          promotion_state: "revoked",
          promotion_scope: null,
          promotion_note: "Rollback after review",
          promotion_confidence: 0,
          promotion_readiness: { state: "rolled_back_from" },
          promotion_scope_details: { globalScopeAllowed: false },
          rollback_definition_id: previous.id,
          rollback_preview: { available: true, wouldRollbackNow: false },
          revoked_by: "dashboard",
          revoked_at: new Date("2026-05-22T11:20:00.000Z"),
          updated_at: new Date("2026-05-22T11:20:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          ...previous,
          promotion_state: "limited_reuse",
          promotion_scope: "device:test-device",
          promotion_note: "Rollback after review",
          promotion_confidence: 0.5,
          promotion_readiness: { state: "manual_rollback_applied" },
          promotion_scope_details: { scopeType: "device", globalScopeAllowed: false },
          rollback_preview: { available: true, wouldRollbackNow: false },
          promoted_by: "dashboard",
          promoted_at: new Date("2026-05-22T11:20:00.000Z"),
          updated_at: new Date("2026-05-22T11:20:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postAgency(
      "/api/agency/workflow-definitions/99999999-9999-4999-8999-999999999999/rollback",
      { note: "Rollback after review" }
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      action: "rollback",
      previousState: "limited_reuse",
      nextState: "limited_reuse",
      sourceDefinition: expect.objectContaining({
        promotion: expect.objectContaining({
          state: "revoked",
          rollbackDefinitionId: previous.id,
          compilerEligible: false,
          wouldUseDefinition: false,
        }),
      }),
      targetDefinition: expect.objectContaining({
        id: previous.id,
        promotion: expect.objectContaining({
          state: "limited_reuse",
          scope: "device:test-device",
          compilerEligible: false,
          wouldUseDefinition: false,
        }),
      }),
      policy: expect.objectContaining({
        manualOnly: true,
        rollbackAction: true,
        autoUseEnabled: false,
        executionChanging: false,
        workflowCacheChanging: false,
        wouldChangePlan: false,
        wouldChangeWorkflowCache: false,
        wouldExecuteWorkflow: false,
        safeToAutoApply: false,
      }),
      promotionReadiness: expect.objectContaining({
        state: "manual_rollback_applied",
        safeToAutoApply: false,
      }),
      rollbackPreview: expect.objectContaining({
        available: true,
        wouldRollbackNow: false,
      }),
    });
    expect(mocks.client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(String(mocks.client.query.mock.calls[1][0])).toContain("rollback_definition_id = $5");
    expect(String(mocks.client.query.mock.calls[2][0])).toContain("promotion_state = 'limited_reuse'");
    expect(String(mocks.client.query.mock.calls[3][0])).toContain("agency_workflow_definition_promotion_events");
    expect(mocks.client.query.mock.calls[3][1][3]).toBe("limited_reuse");
    expect(mocks.client.query.mock.calls[3][1][6]).toContain("\"rollbackAction\":true");
    expect(mocks.client.query.mock.calls[3][1][7]).toContain("\"wouldExecuteWorkflow\":false");
    expect(mocks.client.query.mock.calls[4][0]).toBe("COMMIT");
  });

  it("lists workflow definition promotion audit events without enabling auto-use", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "77777777-7777-4777-8777-777777777777",
          definition_id: "99999999-9999-4999-8999-999999999999",
          definition_key: "device_unlock",
          definition_version: 1,
          action: "promote_limited",
          previous_state: "review_only",
          next_state: "limited_reuse",
          promotion_scope: "device:test-device",
          note: "Manual approval",
          actor: "dashboard",
          policy: { manualOnly: true, autoUseEnabled: false },
          validation_snapshot: { decision: { wouldExecuteWorkflow: false } },
          promotion_confidence: 0.83,
          promotion_readiness: { state: "manual_limited_promotion_ready" },
          promotion_scope_details: { scopeType: "device", globalScopeAllowed: false },
          rollback_preview: { available: false, wouldRollbackNow: false },
          created_at: new Date("2026-05-22T11:15:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency("/api/agency/workflow-definitions/promotion-events?key=device_unlock&pageSize=20");

    expect(response.status).toBe(200);
    expect(response.body.data.policy).toMatchObject({
      readOnly: true,
      auditOnly: true,
      autoUseEnabled: false,
      executionChanging: false,
      workflowCacheChanging: false,
    });
    expect(response.body.data.items[0]).toMatchObject({
      definitionKey: "device_unlock",
      action: "promote_limited",
      previousState: "review_only",
      nextState: "limited_reuse",
      promotionScope: "device:test-device",
      promotionConfidence: 0.83,
      promotionReadiness: expect.objectContaining({ state: "manual_limited_promotion_ready" }),
      promotionScopeDetails: expect.objectContaining({ scopeType: "device" }),
      rollbackPreview: expect.objectContaining({ wouldRollbackNow: false }),
      policy: expect.objectContaining({ autoUseEnabled: false }),
      validationSnapshot: expect.objectContaining({
        decision: expect.objectContaining({ wouldExecuteWorkflow: false }),
      }),
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_workflow_definition_promotion_events");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("definition_key = $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual(["device_unlock", 20, 0]);
  });

  it("lists compiler awareness audit events without changing execution", async () => {
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [{
          id: "77777777-7777-4777-8777-777777777777",
          intent: "unlock device",
          action: null,
          terms: ["unlock", "device"],
          summary: { toolCandidates: 2, stepCandidates: 1, knowledgeCandidates: 3 },
          policy: {
            readOnly: true,
            compilerVisible: false,
            autoUseEnabled: false,
            executionChanging: false,
            mode: "read_only_compiler_awareness",
          },
          candidates: {
            tools: [{ id: "unlock", wouldUse: false }],
            steps: [{ id: "55555555-5555-4555-8555-555555555555", wouldUse: false }],
            knowledge: [{ id: "workflow-failure-never-promotes", wouldApply: false }],
          },
          decision: {
            outcome: "blocked_by_policy",
            wouldChangePlan: false,
            wouldExecuteStepLibrary: false,
            blockers: ["compiler_auto_use_disabled"],
            policyGateSummary: [
              {
                id: "compiler_auto_use",
                category: "auto_use",
                state: "blocked",
                risk: "high",
                owner: "product",
                safeToAutoApply: false,
              },
            ],
          },
          actor: "dashboard",
          source: "dashboard",
          created_at: new Date("2026-05-22T10:20:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await getAgency("/api/agency/compiler-awareness/events?intent=unlock&pageSize=10");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      policy: {
        readOnly: true,
        compilerVisible: false,
        autoUseEnabled: false,
        executionChanging: false,
        mode: "read_only_compiler_awareness_events",
      },
    });
    expect(response.body.data.items[0]).toMatchObject({
      id: "77777777-7777-4777-8777-777777777777",
      intent: "unlock device",
      summary: { toolCandidates: 2, stepCandidates: 1, knowledgeCandidates: 3 },
      decision: { outcome: "blocked_by_policy" },
      policyGateSummary: {
        total: 1,
        blocked: 1,
        highRisk: 1,
        safeToAutoApply: 0,
        gates: [
          expect.objectContaining({
            id: "compiler_auto_use",
            state: "blocked",
            risk: "high",
            safeToAutoApply: false,
          }),
        ],
      },
      source: "dashboard",
    });
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("agency_compiler_awareness_events");
    expect(String(mocks.db.query.mock.calls[0][0])).toContain("intent ILIKE $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual(["%unlock%", 10, 0]);
  });
});
