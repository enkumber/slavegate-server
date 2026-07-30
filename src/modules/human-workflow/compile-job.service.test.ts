import { beforeEach, describe, expect, it, vi } from "vitest";
import { HumanWorkflowCompileJobService } from "./compile-job.service";

const mocks = vi.hoisted(() => ({
  db: { query: vi.fn() },
  policy: {
    version: 7,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
    reconcileIntervalMs: 1_000,
    batchSize: 1,
    maxAttempts: 4,
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

vi.mock("./compile-job-runtime-policy", () => ({
  humanWorkflowCompileJobRuntimePolicy: vi.fn(async () => mocks.policy),
}));

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    request_key: "aaaaaaaaaaaaaaaaaaaaaaaa",
    request_payload_hash: null,
    device_id: "11111111-1111-4111-8111-111111111111",
    account_id: "22222222-2222-4222-8222-222222222222",
    intent: "open reddit",
    platform: "reddit",
    status: "queued",
    cache_key: null,
    source: "llm",
    shortcut_id: null,
    error: null,
    result: null,
    llm_started_at: null,
    llm_completed_at: null,
    retry_count: 0,
    last_retried_at: null,
    timeout_ms: 120000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    lease_owner: null,
    lease_generation: 0,
    lease_expires_at: null,
    lease_heartbeat_at: null,
    claimed_at: null,
    execution_attempt_id: null,
    ...overrides,
  };
}

const createInput = {
  requestKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
  deviceId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  intent: "open reddit",
  platform: "reddit",
};

describe("HumanWorkflowCompileJobService durable ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the canonical row for an exact request replay", async () => {
    const service = new HumanWorkflowCompileJobService();
    mocks.db.query.mockImplementationOnce((_sql, values) => ({
      rows: [jobRow({ request_payload_hash: values[6], reused: true })],
    }));

    const job = await service.createOrGet(createInput);

    expect(job.requestKey).toBe(createInput.requestKey);
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
    expect(mocks.db.query.mock.calls[0][0]).toContain("ON CONFLICT (request_key) DO NOTHING");
  });

  it("fails closed and audits a conflicting payload under the same request key", async () => {
    const service = new HumanWorkflowCompileJobService();
    mocks.db.query
      .mockResolvedValueOnce({
        rows: [jobRow({ request_payload_hash: "different", reused: true })],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.createOrGet(createInput)).rejects.toMatchObject({
      code: "COMPILE_REQUEST_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(mocks.db.query.mock.calls[1][0]).toContain("human_workflow_compile_job_events");
    expect(mocks.db.query.mock.calls[1][1][1]).toBe("idempotency_conflict");
  });

  it("backfills the canonical payload hash for an exact historical replay", async () => {
    const service = new HumanWorkflowCompileJobService();
    mocks.db.query
      .mockResolvedValueOnce({ rows: [jobRow({ reused: true })] })
      .mockImplementationOnce((_sql, values) => ({
        rows: [jobRow({ request_payload_hash: values[1] })],
      }));

    const job = await service.createOrGet(createInput);

    expect(job.requestPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.db.query.mock.calls[1][0]).toContain("request_payload_hash IS NULL");
  });

  it("claims through PostgreSQL and passes the fenced generation to the runner", async () => {
    const service = new HumanWorkflowCompileJobService();
    const claimed = jobRow({
      status: "running",
      lease_owner: "owner",
      lease_generation: 3,
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      execution_attempt_id: "77777777-7777-4777-8777-777777777777",
    });
    const runner = vi.fn(async () => ({ cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb" }));
    service.configureRunner(runner);
    mocks.db.query
      .mockResolvedValueOnce({ rows: [claimed] })
      .mockResolvedValueOnce({ rows: [jobRow({ status: "succeeded" })] });

    await expect(service.reconcileOnce()).resolves.toBe(1);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

    expect(mocks.db.query.mock.calls[0][0]).toContain("FOR UPDATE OF job SKIP LOCKED");
    expect(mocks.db.query.mock.calls[0][0]).toContain("lease_generation = job.lease_generation + 1");
    expect(mocks.db.query.mock.calls[1][0]).toContain("job.lease_generation = $3");
  });

  it("does not claim when PostgreSQL returns no eligible lifecycle row", async () => {
    const service = new HumanWorkflowCompileJobService();
    service.configureRunner(vi.fn());
    mocks.db.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.reconcileOnce()).resolves.toBe(0);
  });
});
