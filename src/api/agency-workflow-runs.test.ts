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

async function postWorkflowRun(body: Record<string, unknown>) {
  return postAgency("/api/agency/workflow-runs", body);
}

async function postAgency(path: string, body: Record<string, unknown>) {
  const server = await app();
  const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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

describe("agency workflow runs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns a workflow run by id with task and operator context", async () => {
    const run = hydratedRun();
    mocks.db.query.mockResolvedValueOnce({ rows: [run] });

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
    });
    expect(mocks.db.query.mock.calls[0][0]).toContain("FROM agency_workflow_runs r");
    expect(mocks.db.query.mock.calls[0][0]).toContain("r.id = $1");
    expect(mocks.db.query.mock.calls[0][1]).toEqual([run.id]);
  });
});
