import { beforeEach, describe, expect, it, vi } from "vitest";
import { humanWorkflowCompileJobService } from "./compile-job.service";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

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
    result: null,
    llm_started_at: new Date(Date.now() - 10_000).toISOString(),
    llm_completed_at: null,
    retry_count: 0,
    last_retried_at: null,
    timeout_ms: 120000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

describe("humanWorkflowCompileJobService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUMAN_WORKFLOW_COMPILE_JOB_STALE_MS = "1000";
  });

  it("marks stale running jobs as retryable failed when fetched by id", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [jobRow()] })
      .mockResolvedValueOnce({ rows: [{ terminal: false }] })
      .mockResolvedValueOnce({
        rows: [jobRow({
          status: "failed",
          error: "compile job worker expired; retry compile",
          llm_started_at: new Date(Date.now() - 10_000).toISOString(),
          completed_at: new Date().toISOString(),
        })],
      });

    const job = await humanWorkflowCompileJobService.getById("66666666-6666-4666-8666-666666666666");

    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("compile job worker expired; retry compile");
    expect(job?.errorClass).toBe("timeout");
    expect(mocks.db.query.mock.calls[2][0]).toContain("lifecycle_transitions");
    expect(mocks.db.query.mock.calls[2][0]).not.toContain("status = 'failed'");
    expect(JSON.parse(mocks.db.query.mock.calls[2][1][1])).toMatchObject({
      targetTerminal: true,
      targetRetryable: true,
      transitionAutomatic: true,
    });
  });

  it("does not mark fresh running jobs as stale", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [jobRow({ llm_started_at: new Date().toISOString() })],
    });

    const job = await humanWorkflowCompileJobService.getByRequestKey("requestkey00000000000001");

    expect(job?.status).toBe("running");
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });

  it("stores configured timeout when creating compile jobs", async () => {
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "90000";
    mocks.db.query.mockResolvedValueOnce({
      rows: [jobRow({ status: "queued", llm_started_at: null, timeout_ms: 90000 })],
    });

    const job = await humanWorkflowCompileJobService.createOrGet({
      requestKey: "requestkey00000000000001",
      deviceId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      intent: "open reddit",
      platform: "reddit",
    });

    expect(job.timeoutMs).toBe(90000);
    expect(mocks.db.query.mock.calls[0][1]).toContain(90000);
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
  });

  it("requeues failed jobs and increments retry metadata", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [jobRow({
        status: "queued",
        error: null,
        retry_count: 2,
        last_retried_at: "2026-06-18T10:01:00.000Z",
        llm_completed_at: null,
        completed_at: null,
      })],
    });

    const job = await humanWorkflowCompileJobService.requeueFailed("66666666-6666-4666-8666-666666666666");

    expect(job?.status).toBe("queued");
    expect(job?.retryCount).toBe(2);
    expect(job?.lastRetriedAt).toBe("2026-06-18T10:01:00.000Z");
    expect(mocks.db.query.mock.calls[0][0]).toContain("lifecycle_transitions");
    expect(mocks.db.query.mock.calls[0][0]).not.toContain("status = 'queued'");
    expect(JSON.parse(mocks.db.query.mock.calls[0][1][1])).toMatchObject({
      targetInitial: true,
      targetDispatchable: true,
      transitionClearCompleted: true,
      transitionClearFailure: true,
    });
    expect(JSON.parse(mocks.db.query.mock.calls[0][1][2])).toMatchObject({
      incrementRetry: true,
      markRetried: true,
    });
  });

  it("persists raw LLM debug output and appends it to job history on failure", async () => {
    const llmDebug = {
      sensitive: true,
      compilerCacheVersion: "test-v1",
      failure: "human workflow undercompiled",
      attempts: [{
        attempt: 1,
        provider: "openai_compatible",
        model: "qwen-test",
        endpoint: "http://gx10.example/v1",
        maxTokens: 4096,
        rawResponse: "{\"steps\":[{\"action\":\"screen_wake\"}]}",
        responseTruncated: false,
        capturedAt: "2026-07-20T08:00:00.000Z",
      }],
    };
    mocks.db.query
      .mockResolvedValueOnce({ rows: [jobRow({ llm_started_at: null })] })
      .mockResolvedValueOnce({ rows: [jobRow({ llm_started_at: new Date().toISOString() })] })
      .mockResolvedValueOnce({ rows: [] });

    humanWorkflowCompileJobService.runInProcess(
      "66666666-6666-4666-8666-666666666666",
      async () => {
        throw Object.assign(new Error("human workflow undercompiled"), {
          debugPayload: { llmDebug },
        });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.db.query).toHaveBeenCalledTimes(3);
    expect(mocks.db.query.mock.calls[2][0]).toContain("llmDebugHistory");
    expect(JSON.parse(mocks.db.query.mock.calls[2][1][2])).toMatchObject({
      error: "human workflow undercompiled",
      appendDebug: { llmDebug },
    });
  });
});
