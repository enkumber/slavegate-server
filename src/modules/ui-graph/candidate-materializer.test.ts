import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  listStates: vi.fn(),
  selectTransition: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../runtime-policy/resource-runtime-policy.service", () => ({
  getResourceRuntimePolicy: mocks.getPolicy,
}));
vi.mock("../lifecycle/lifecycle.service", () => ({
  listResourceLifecycleStates: mocks.listStates,
  selectResourceLifecycleTransition: mocks.selectTransition,
}));

import {
  materializeCandidate,
  transitionMaterializedCandidate,
} from "./candidate-materializer";

const policy = {
  candidateMaterializers: {
    learned_surface: {
      resourceTable: "learned_surfaces",
      columns: {
        app_id: { source: "candidate", field: "app_id" },
        surface_key: { source: "payload", path: "stateKey" },
        metadata: { source: "candidate_metadata" },
        active: { source: "literal", value: true },
      },
      conflictColumns: ["app_id", "surface_key"],
      updateColumns: ["metadata", "active"],
      rollback: { mode: "patch", patch: { active: false } },
      quarantine: { mode: "patch", patch: { active: false } },
    },
    learned_route: {
      resourceTable: "learned_routes",
      columns: {
        app_id: { source: "candidate", field: "app_id" },
        route_key: { source: "payload", path: "transitionKey" },
        metadata: { source: "candidate_metadata" },
      },
      conflictColumns: ["app_id", "route_key"],
      updateColumns: ["metadata"],
      lifecycleStateColumn: "status",
      rollback: { mode: "lifecycle" },
      quarantine: { mode: "lifecycle" },
    },
  },
};

describe("data-driven UI graph candidate materializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolicy.mockResolvedValue(policy);
    mocks.query.mockResolvedValue({ rows: [{ id: "entity-1" }] });
  });

  it("materializes an arbitrary candidate type from PostgreSQL policy", async () => {
    const entityId = await materializeCandidate({
      id: "candidate-1",
      candidate_type: "learned_surface",
      app_id: "app.example",
      payload: { stateKey: "home" },
    }, { query: mocks.query } as never);

    expect(entityId).toBe("entity-1");
    expect(String(mocks.query.mock.calls[0][0])).toContain("INSERT INTO learned_surfaces");
    expect(String(mocks.query.mock.calls[0][0])).toContain("ON CONFLICT (app_id,surface_key)");
    expect(mocks.query.mock.calls[0][1]).toEqual([
      "app.example",
      "home",
      { candidateId: "candidate-1" },
      true,
    ]);
  });

  it("uses the configured dispatchable lifecycle state without naming it in code", async () => {
    mocks.listStates.mockResolvedValue([
      { status: "usable", dispatchable: true, terminal: false, administrative: false },
    ]);
    await materializeCandidate({
      id: "candidate-2",
      candidate_type: "learned_route",
      app_id: "app.example",
      payload: { transitionKey: "home_to_search" },
    }, { query: mocks.query } as never);

    expect(mocks.query.mock.calls[0][1]).toEqual([
      "app.example",
      "home_to_search",
      { candidateId: "candidate-2" },
      "usable",
    ]);
  });

  it("applies policy-driven patch rollback", async () => {
    await transitionMaterializedCandidate({
      id: "candidate-1",
      candidate_type: "learned_surface",
      promoted_entity_id: "entity-1",
    }, "retryable", { query: mocks.query } as never);

    expect(String(mocks.query.mock.calls[0][0])).toContain("UPDATE learned_surfaces");
    expect(mocks.query.mock.calls[0][1]).toEqual(["entity-1", false]);
  });

  it("uses the configured resource lifecycle for rollback", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: "usable" }] });
    mocks.selectTransition.mockResolvedValue({ toStatus: "recheck" });
    await transitionMaterializedCandidate({
      id: "candidate-2",
      candidate_type: "learned_route",
      promoted_entity_id: "entity-2",
    }, "retryable", { query: mocks.query } as never);

    expect(mocks.selectTransition).toHaveBeenCalledWith(
      "learned_routes",
      "usable",
      { targetRetryable: true, transitionAutomatic: true },
      "status",
      expect.anything(),
    );
    expect(mocks.query.mock.calls[1][1]).toEqual(["entity-2", "recheck"]);
  });
});
