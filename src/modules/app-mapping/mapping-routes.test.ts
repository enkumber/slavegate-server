import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { a11yTapSucceeded, isUsableRedditUiTree, parseUiTreeResult } from "./mapping-routes";
import { filterRelevantElements } from "./element-filter";
import { buildPageDetection } from "./page-fingerprint";
import { validateAppMapQuality, type AppMap } from "./schema";

const mocks = vi.hoisted(() => ({
  saveMap: vi.fn(),
}));

vi.mock("./recorder.service", () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getRecorderState: vi.fn(() => ({ status: "idle" })),
  loadMap: vi.fn(),
  deleteMap: vi.fn(),
  listMaps: vi.fn(() => []),
  saveMap: mocks.saveMap,
}));

async function app() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("./mapping-routes");
  app.use("/mapping", router);
  return app;
}

async function postJson(server: express.Express, path: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("reddit app-map refresh helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a selector transition only when the agent actually found the element", () => {
    expect(a11yTapSucceeded({ status: "completed", output: { found: true } })).toBe(true);
    expect(a11yTapSucceeded({ status: "completed", output: { found: false, error: "Element not found" } })).toBe(false);
    expect(a11yTapSucceeded({ status: "failed", output: { found: true } })).toBe(false);
  });

  it("normalizes x/y/width/height UI-tree bounds into usable app-map bounds", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1000,
        screenHeight: 2000,
        appVersion: "2026.20.1",
        nodes: [
          {
            className: "android.widget.FrameLayout",
            bounds: { x: 0, y: 0, width: 1000, height: 2000 },
            children: [
              {
                resourceId: "com.reddit.frontpage:id/search",
                contentDescription: "Search Reddit",
                className: "android.widget.Button",
                clickable: true,
                bounds: { x: 100, y: 50, width: 800, height: 100 },
              },
            ],
          },
        ],
      },
    });

    const elements = filterRelevantElements(tree.nodes, tree.width, tree.height);
    const detection = buildPageDetection(tree.nodes);
    const map: AppMap = {
      appId: "com.reddit.frontpage",
      appName: "Reddit",
      version: "real-device-refresh-test",
      appVersion: tree.appVersion,
      deviceProfile: { width: tree.width, height: tree.height },
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      pageCount: 1,
      transitionCount: 0,
      pages: {
        reddit_home_feed: {
          name: "Reddit home/feed",
          discoveryOrder: 0,
          detection,
          elements: {
            search: {
              ...elements[0],
              leadsTo: "self",
            },
          },
        },
      },
    };

    expect(tree.appVersion).toBe("2026.20.1");
    expect(elements[0].bounds).toEqual({ x: 0.1, y: 0.025, w: 0.8, h: 0.05 });
    expect(validateAppMapQuality(map)).toMatchObject({
      usable: true,
      errors: [],
      warnings: [],
      stats: {
        pagesMissingSignatureHash: 0,
        elementsMissingBounds: 0,
        elementsInvalidBounds: 0,
      },
    });
  });

  it("rejects SystemUI one-node dumps before app-map generation", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        uiTree: {
          packageName: "com.android.systemui",
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [],
        },
      },
    });

    expect(tree.packageName).toBe("com.android.systemui");
    expect(tree.nodeCount).toBe(1);
    expect(isUsableRedditUiTree(tree)).toBe(false);
  });

  it("rejects multi-node dumps without positive Reddit package proof", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        uiTree: {
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              resourceId: "search",
              contentDescription: "Search Reddit",
              className: "android.widget.Button",
              clickable: true,
              bounds: { left: 80, top: 40, right: 1000, bottom: 160 },
            },
          ],
        },
      },
    });

    expect(tree.packageName).toBeUndefined();
    expect(tree.nodeCount).toBe(2);
    expect(isUsableRedditUiTree(tree)).toBe(false);
  });

  it("rejects multi-node dumps from unknown non-Reddit packages", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        uiTree: {
          packageName: "com.example.unknown",
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              packageName: "com.example.unknown",
              resourceId: "com.example.unknown:id/search",
              contentDescription: "Search Reddit",
              className: "android.widget.Button",
              clickable: true,
              bounds: { left: 80, top: 40, right: 1000, bottom: 160 },
            },
          ],
        },
      },
    });

    expect(tree.packageName).toBe("com.example.unknown");
    expect(tree.nodeCount).toBe(2);
    expect(isUsableRedditUiTree(tree)).toBe(false);
  });

  it("accepts Reddit dumps with anchors and non-empty signatures", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        uiTree: {
          packageName: "com.reddit.frontpage",
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              packageName: "com.reddit.frontpage",
              resourceId: "com.reddit.frontpage:id/search",
              contentDescription: "Search Reddit",
              className: "android.widget.Button",
              clickable: true,
              bounds: { left: 80, top: 40, right: 1000, bottom: 160 },
            },
          ],
        },
      },
    });

    expect(isUsableRedditUiTree(tree)).toBe(true);
  });

  it("falls back to selector-rich bounded nodes when Reddit exposes no clickable elements", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        uiTree: {
          packageName: "com.reddit.frontpage",
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              packageName: "com.reddit.frontpage",
              className: "androidx.recyclerview.widget.RecyclerView",
              bounds: { left: 0, top: 200, right: 1080, bottom: 2200 },
              children: [
                {
                  packageName: "com.reddit.frontpage",
                  text: "AskReddit",
                  className: "android.view.View",
                  clickable: false,
                  bounds: { left: 40, top: 220, right: 500, bottom: 300 },
                },
              ],
            },
          ],
        },
      },
    });

    const elements = filterRelevantElements(tree.nodes, tree.width, tree.height);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      text: "AskReddit",
      bounds: { x: 0.037, y: 0.0917, w: 0.4259, h: 0.0333 },
    });
  });

  it("does not treat class-derived semantic IDs as real selector evidence", () => {
    const tree = parseUiTreeResult({
      output: {
        screenWidth: 1080,
        screenHeight: 2400,
        packageName: "com.reddit.frontpage",
        uiTree: {
          packageName: "com.reddit.frontpage",
          className: "android.widget.FrameLayout",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          children: [
            {
              packageName: "com.reddit.frontpage",
              className: "android.widget.Button",
              clickable: true,
              bounds: { left: 80, top: 40, right: 1000, bottom: 160 },
            },
          ],
        },
      },
    });

    const elements = filterRelevantElements(tree.nodes, tree.width, tree.height);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      resourceId: "",
      text: "",
      contentDescription: "",
      semanticId: "",
      selectorProvenance: [],
    });
  });

  it("rejects unusable Reddit upload maps before saving", async () => {
    const server = await app();
    const response = await postJson(server, "/mapping/upload", {
      appId: "com.reddit.frontpage",
      appName: "Reddit",
      version: "generated-test",
      pages: {
        reddit_home_feed: {
          name: "Reddit home/feed",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["resourceId:feed"],
            signatureHash: "hash-feed",
          },
          elements: {},
        },
      },
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      error: "Uploaded app map is unusable; refusing to save",
      quality: {
        usable: false,
        errors: ["app map has pages but no bindable elements"],
      },
    });
    expect(mocks.saveMap).not.toHaveBeenCalled();
  });
});
