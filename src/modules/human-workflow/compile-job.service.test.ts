import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HumanWorkflowCompileJobConflictError,
  HumanWorkflowCompileJobPolicyUnavailableError,
  humanWorkflowCompileJobService,
} from "./compile-job.service";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

function policy() {
  return {
    enabled: true,
    claimLimit: 1,
    leaseMs: 1000,
    heartbeatIntervalMs: 100,
    reconcileIntervalMs: 1000,
    maxAttempts: 3,
    serverActor: "test",
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    request_key: "requestkey00000000000001",
    device_id: "11111111-1111-4111-8111-111111111111",
    account_id: "22222222-2222-4222-8222-222222222222",
    intent: "open reddit",
    platform: "reddit",
    status: "running",
    cache_key: null,
    source: "llm",
    shortcut_id: null,
    error: null,
    provider_error_code: null,
    result: null,
    llm_started_at: new Date().toISOString(),
    llm_completed_at: null,
    retry_count: 0,
    last_retried_at: null,
    timeout_ms: 120000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    owner_token: "claim-token",
    owner_generation: 1,
    lease_expires_at: new Date(Date.now() + 1000).toISOString(),
    worker_attempt_count: 1,
    last_worker_heartbeat_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("humanWorkflowCompileJobService", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.db.connect.mockResolvedValue(mocks.client);
    await humanWorkflowCompileJobService.stopReconciler();
  });

  it("fails closed when PostgreSQL runtime policy is missing", async () => {
    mocks.db.query.mockResolvedValueOnce({ rows: [] });

    await expect(humanWorkflowCompileJobService.claimNext("test"))
      .rejects.toBeInstanceOf(HumanWorkflowCompileJobPolicyUnavailableError);
  });

  it("uses row locking and owner generation when claiming eligible work", async () => {
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("resource_runtime_policies")) return { rows: [{ policy: policy() }] };
      if (sql.includes("UPDATE human_workflow_compile_jobs job")) return { rows: [jobRow()] };
      return { rows: [] };
    });

    const claim = await humanWorkflowCompileJobService.claimNext("test");

    expect(claim?.ownerGeneration).toBe(1);
    const claimSql = mocks.db.query.mock.calls.find((call) => String(call[0]).includes("FOR UPDATE OF job SKIP LOCKED"))?.[0];
    expect(claimSql).toContain("owner_generation = job.owner_generation + 1");
    expect(claimSql).toContain("lease_expires_at = NOW()");
  });

  it("returns existing rows for the same idempotency payload", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const job = await humanWorkflowCompileJobService.createOrGet({
      requestKey: "requestkey00000000000001",
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      intent: "open reddit",
      platform: "reddit",
    });

    expect(job.id).toBe("66666666-6666-4666-8666-666666666666");
  });

  it("rejects conflicting payloads under the same idempotency key", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ intent: "other intent" })] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(humanWorkflowCompileJobService.createOrGet({
      requestKey: "requestkey00000000000001",
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      intent: "open reddit",
      platform: "reddit",
    })).rejects.toBeInstanceOf(HumanWorkflowCompileJobConflictError);
  });

  it("fences stale owner writes by token and generation", async () => {
    mocks.db.query.mockResolvedValueOnce({ rows: [] });
    await expect(humanWorkflowCompileJobService.completeClaim({
      job: jobRow(),
      ownerToken: "old",
      ownerGeneration: 1,
    }, {
      ready: true,
      cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
    })).rejects.toMatchObject({ code: "HUMAN_WORKFLOW_COMPILE_JOB_LEASE_FENCE" });
  });
});
