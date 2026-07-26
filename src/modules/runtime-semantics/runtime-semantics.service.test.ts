import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../db/client", () => ({
  getDb: () => ({ query }),
}));

import {
  deleteRuntimeSemanticEntry,
  listRuntimeSemanticEntries,
  upsertRuntimeSemanticEntry,
} from "./runtime-semantics.service";

describe("runtime semantic control plane", () => {
  beforeEach(() => query.mockReset());

  it("lists generic entries without embedding a product namespace", async () => {
    query.mockResolvedValueOnce({ rows: [{ namespace: "configured-at-runtime" }] });
    await expect(listRuntimeSemanticEntries()).resolves.toEqual([{ namespace: "configured-at-runtime" }]);
    expect(query.mock.calls[0][1]).toEqual([null, null]);
  });

  it("upserts only against an existing PostgreSQL lifecycle state", async () => {
    query.mockResolvedValueOnce({
      rows: [{ namespace: "operator", entry_key: "queue" }],
    });
    await expect(upsertRuntimeSemanticEntry({
      namespace: "operator",
      entryKey: "queue",
      platform: "*",
      lifecycleKey: "configured-lifecycle",
      status: "configured-state",
      priority: 9,
      payload: { arbitrary: true },
    })).resolves.toMatchObject({ namespace: "operator", entry_key: "queue" });
    expect(String(query.mock.calls[0][0])).toContain("FROM lifecycle_state_definitions");
    expect(query.mock.calls[0][1]).toEqual([
      "operator",
      "queue",
      "*",
      "configured-lifecycle",
      "configured-state",
      9,
      "{\"arbitrary\":true}",
    ]);
  });

  it("rejects a missing lifecycle state", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(upsertRuntimeSemanticEntry({
      namespace: "operator",
      entryKey: "queue",
      platform: "*",
      lifecycleKey: "missing",
      status: "missing",
      priority: 0,
      payload: {},
    })).rejects.toThrow("lifecycle state does not exist");
  });

  it("deletes by generic composite identity", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(deleteRuntimeSemanticEntry("operator", "queue")).resolves.toBe(true);
    expect(query.mock.calls[0][1]).toEqual(["operator", "queue"]);
  });
});
