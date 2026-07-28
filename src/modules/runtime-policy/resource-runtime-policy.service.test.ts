import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

import {
  deleteResourceRuntimePolicy,
  getResourceRuntimePolicy,
  ResourceRuntimePolicyUnavailableError,
  upsertResourceRuntimePolicy,
} from "./resource-runtime-policy.service";

describe("resource runtime policy control plane", () => {
  beforeEach(() => query.mockReset());

  it("fails closed when PostgreSQL has no policy", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(getResourceRuntimePolicy("segment_build_jobs"))
      .rejects.toBeInstanceOf(ResourceRuntimePolicyUnavailableError);
  });

  it("returns an enabled PostgreSQL policy", async () => {
    query.mockResolvedValue({ rows: [{ policy: { enabled: true, limit: 7 } }] });
    await expect(getResourceRuntimePolicy("segment_build_jobs"))
      .resolves.toEqual({ enabled: true, limit: 7 });
  });

  it("upserts only an existing PostgreSQL resource", async () => {
    query.mockResolvedValue({
      rows: [{
        resource_table: "segment_build_jobs",
        policy: { enabled: true },
        version: 2,
        updated_by: "operator",
        updated_at: new Date("2026-07-28T00:00:00Z"),
      }],
    });
    await expect(upsertResourceRuntimePolicy({
      resourceTable: "segment_build_jobs",
      policy: { enabled: true },
      updatedBy: "operator",
    })).resolves.toMatchObject({
      resourceTable: "segment_build_jobs",
      version: 2,
    });
  });

  it("deletes a policy without deleting its resource", async () => {
    query.mockResolvedValue({ rows: [{ resource_table: "segment_build_jobs" }], rowCount: 1 });
    await expect(deleteResourceRuntimePolicy("segment_build_jobs")).resolves.toBe(true);
  });
});
