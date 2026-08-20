import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
    })),
    dbQuery: vi.fn(),
    loadRuntimeProfile: vi.fn(),
  };
});

vi.mock("../../db/client", () => ({
  getDb: () => ({ query: mocks.dbQuery, connect: mocks.connect }),
}));

vi.mock("../app-mapping/runtime-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-mapping/runtime-profile")>()),
  loadRuntimeProfile: mocks.loadRuntimeProfile,
}));

import { materializeAllLegacyAppMaps } from "./materializer";

const rawMap = {
  appId: "com.example.app",
  appName: "Example",
  version: "map-1",
  appVersion: "1.0",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  pages: {
    search_entry: {
      name: "Search entry",
      discoveryOrder: 0,
      detection: {
        signatureHash: "hash-1",
        anchors: ["resourceId:toolbar"],
        optionalAnchors: ["contentDescription:Search"],
      },
      elements: {},
    },
  },
};

describe("runtime-profile-aware UI graph materialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbQuery.mockResolvedValue({ rows: [{ app_id: rawMap.appId, map_data: rawMap }] });
    mocks.loadRuntimeProfile.mockResolvedValue({
      appId: rawMap.appId,
      appName: rawMap.appName,
      packageName: rawMap.appId,
      profileVersion: 7,
      resetRecipe: [],
      mappingRecipe: [],
      safetyPolicy: { mode: "read_only_navigation", allowedActions: [] },
      metadata: {
        stateDetectionOverrides: {
          search_entry: {
            requiredAnchors: ["resourceId:toolbar", "resourceId:collapsed_content"],
            optionalAnchors: ["contentDescription:Search"],
            forbiddenAnchors: ["resourceId:search_results"],
          },
        },
      },
    });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO ui_graph_states")) return { rows: [{ id: "state-1" }] };
      if (sql.includes("INSERT INTO ui_graph_state_variants")) return { rows: [{ id: "variant-1" }] };
      return { rows: [] };
    });
  });

  it("projects all anchor classes with auditable profile provenance and stays idempotent", async () => {
    await materializeAllLegacyAppMaps();
    await materializeAllLegacyAppMaps();

    const variantCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO ui_graph_state_variants"),
    );
    expect(variantCalls).toHaveLength(2);
    for (const [, params] of variantCalls) {
      expect(JSON.parse(params[3])).toEqual(["resourceId:toolbar", "resourceId:collapsed_content"]);
      expect(JSON.parse(params[4])).toEqual(["contentDescription:Search"]);
      expect(JSON.parse(params[5])).toEqual(["resourceId:search_results"]);
      expect(JSON.parse(params[10])).toMatchObject({
        source: "legacy_app_map",
        appMapVersion: "map-1",
        runtimeProfileSource: "postgresql",
        runtimeProfileVersion: 7,
        runtimeStateDetectionOverrideKeys: ["search_entry"],
      });
    }
  });
});
