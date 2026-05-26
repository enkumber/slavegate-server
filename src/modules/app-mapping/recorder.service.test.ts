import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMap } from "./schema";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    mkdir: mocks.mkdir,
  },
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));

const seedMap: AppMap = {
  appId: "com.example.seed",
  appName: "Seed",
  version: "1.0.0",
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
  pageCount: 1,
  transitionCount: 0,
  pages: {
    page_0: {
      name: "home",
      detection: {
        method: "ui_tree_signature",
        anchors: ["text:Home"],
        signatureHash: "hash-home",
      },
      elements: {},
      discoveryOrder: 0,
    },
  },
};

describe("app-map recorder persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("imports a seed app-map into the DB before returning it on DB miss", async () => {
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.readFile.mockResolvedValueOnce(JSON.stringify(seedMap));

    const { loadMap } = await import("./recorder.service");
    const loaded = await loadMap(seedMap.appId);

    expect(loaded).toMatchObject({ appId: seedMap.appId, version: seedMap.version });
    expect(mocks.db.query).toHaveBeenCalledTimes(2);
    expect(mocks.db.query.mock.calls[0][0]).toContain("SELECT map_data FROM app_maps");
    expect(mocks.db.query.mock.calls[1][0]).toContain("INSERT INTO app_maps");
    expect(mocks.db.query.mock.calls[1][1]).toEqual([
      seedMap.appId,
      seedMap.appName,
      JSON.stringify(seedMap),
      seedMap.version,
      seedMap.pageCount,
      seedMap.transitionCount,
    ]);
  });
});
