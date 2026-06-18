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
    expect(mocks.db.query.mock.calls[1][0]).toContain("status = 'failed'");
  });

  it("does not mark fresh running jobs as stale", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [jobRow({ llm_started_at: new Date().toISOString() })],
    });

    const job = await humanWorkflowCompileJobService.getByRequestKey("requestkey00000000000001");

    expect(job?.status).toBe("running");
    expect(mocks.db.query).toHaveBeenCalledTimes(1);
  });
});
