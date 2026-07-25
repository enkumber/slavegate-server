import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => ({ query: mocks.query })),
}));

import {
  expireStaleJobs,
  transitionJob,
  transitionJobFromExternalStatus,
  transitionJobManually,
} from "./job-lifecycle.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("dispatcher job lifecycle", () => {
  it("selects action transitions from the DB registry", async () => {
    await transitionJob("job-1", "claim");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("JOIN lifecycle_transitions transition"),
      ["job-1", "claim", "{}", "dispatcher_job", null],
    );
  });

  it("fences device-originated actions to the owning device in SQL", async () => {
    await transitionJob("job-1", "claim", {}, undefined, "device-1");
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("j.device_id = $5");
    expect(params).toEqual(["job-1", "claim", "{}", "dispatcher_job", "device-1"]);
  });

  it("accepts a device target status only through an external-enabled DB transition", async () => {
    await transitionJobFromExternalStatus("job-1", "operator_defined_terminal", {
      durationMs: 7,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("transition.external_allowed"),
      ["job-1", "operator_defined_terminal", "{\"durationMs\":7}", "dispatcher_job", null],
    );
  });

  it("fences external results to the owning device in SQL", async () => {
    await transitionJobFromExternalStatus(
      "job-1",
      "operator_defined_terminal",
      {},
      undefined,
      "device-1",
    );
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("j.device_id = $5");
    expect(params).toEqual([
      "job-1",
      "operator_defined_terminal",
      "{}",
      "dispatcher_job",
      "device-1",
    ]);
  });

  it("discovers stale states and expiry actions from lifecycle metadata", async () => {
    await expireStaleJobs();
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toContain("state.stale_after_ms");
    expect(sql).toContain("transition.action_key = state.stale_action_key");
    expect(sql).toContain("transition.automatic");
    expect(sql).not.toContain("j.status IN");
  });

  it("allows operator-added manual states without a code change", async () => {
    await transitionJobManually("job-1", "operator_terminal");
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("transition.manual_allowed");
    expect(String(sql)).toContain("target.manual");
    expect(params).toEqual(["job-1", "operator_terminal", "dispatcher_job"]);
  });
});
