import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMap } from "./schema";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
  fs: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
  loadRuntimeProfile: vi.fn(),
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

vi.mock("fs/promises", () => ({
  default: mocks.fs,
}));

vi.mock("../../transport/transport", () => ({
  sendJobToDevice: vi.fn(),
  isDeviceOnline: vi.fn(() => true),
  waitForResult: vi.fn(),
}));

vi.mock("../dispatcher/dispatcher.service", () => ({
  dispatcherService: {
    dispatch: vi.fn(),
  },
}));

vi.mock("./runtime-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-profile")>()),
  loadRuntimeProfile: mocks.loadRuntimeProfile,
}));

const seedMap: AppMap = {
  appId: "com.example.seed",
  appName: "Seed App",
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
      discoveryOrder: 0,
      elements: {
        button_continue: {
          type: "button",
          bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
          resourceId: "continue",
          text: "Continue",
          contentDescription: "",
          clickable: true,
          leadsTo: "self",
        },
      },
    },
  },
};

describe("app-mapping recorder persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRuntimeProfile.mockResolvedValue(null);
  });

  it("imports seed fallback maps into DB before returning them", async () => {
    const { loadMap } = await import("./recorder.service");
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mocks.fs.readFile.mockResolvedValueOnce(JSON.stringify(seedMap));
    mocks.fs.mkdir.mockResolvedValueOnce(undefined);
    mocks.fs.writeFile.mockResolvedValueOnce(undefined);

    const loaded = await loadMap(seedMap.appId);

    expect(loaded).toEqual(seedMap);
    expect(mocks.db.query).toHaveBeenNthCalledWith(
      1,
      "SELECT map_data FROM app_maps WHERE app_id = $1",
      [seedMap.appId],
    );
    expect(String(mocks.db.query.mock.calls[1][0])).toContain("INSERT INTO app_maps");
    expect(mocks.db.query.mock.calls[1][1]).toEqual([
      seedMap.appId,
      seedMap.appName,
      JSON.stringify(seedMap),
      seedMap.version,
      seedMap.pageCount,
      seedMap.transitionCount,
    ]);
  });

  it("returns null instead of a seed-only map when DB import fails", async () => {
    const { loadMap } = await import("./recorder.service");
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("insert failed"));
    mocks.fs.readFile.mockResolvedValueOnce(JSON.stringify(seedMap));

    const loaded = await loadMap(seedMap.appId);

    expect(loaded).toBeNull();
  });

  it("applies runtime detection overrides after importing a seed fallback", async () => {
    const { loadMap } = await import("./recorder.service");
    mocks.db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mocks.fs.readFile.mockResolvedValueOnce(JSON.stringify(seedMap));
    mocks.fs.mkdir.mockResolvedValueOnce(undefined);
    mocks.fs.writeFile.mockResolvedValueOnce(undefined);
    mocks.loadRuntimeProfile.mockResolvedValueOnce({
      metadata: {
        stateDetectionOverrides: {
          page_0: { forbiddenAnchors: ["text:Results"] },
        },
      },
    });

    const loaded = await loadMap(seedMap.appId);

    expect(loaded?.pages.page_0.detection.forbiddenAnchors).toEqual(["text:Results"]);
    expect(seedMap.pages.page_0.detection.forbiddenAnchors).toBeUndefined();
  });
});
