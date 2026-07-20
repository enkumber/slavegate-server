import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query })),
}));

import { listJobExecutionEvents, recordJobExecutionEvent } from "./job-execution-events";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe("job execution events", () => {
  it("persists lifecycle metadata without params, payloads, or credentials", async () => {
    await recordJobExecutionEvent({
      jobId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      workflowId: "33333333-3333-4333-8333-333333333333",
      source: "workflow_executor",
      eventType: "dispatch_sent",
      details: {
        jobType: "open_app",
        timeoutMs: 30_000,
        params: { password: "never-store" },
        payload: "never-store",
        credentialValue: "never-store",
        error: "password: super-secret for owner@example.com",
      },
    });

    const values = query.mock.calls[0][1];
    expect(values.slice(0, 5)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "workflow_executor",
      "dispatch_sent",
    ]);
    expect(JSON.parse(values[5])).toEqual({
      jobType: "open_app",
      timeoutMs: 30_000,
      error: "password [redacted] for [redacted-email]",
    });
  });

  it("returns events in chronological order", async () => {
    query.mockResolvedValue({ rows: [{ id: 1, event_type: "job_created" }] });
    await expect(listJobExecutionEvents("11111111-1111-4111-8111-111111111111"))
      .resolves.toEqual([{ id: 1, event_type: "job_created" }]);
    expect(query.mock.calls[0][0]).toContain("ORDER BY created_at ASC, id ASC");
  });
});
