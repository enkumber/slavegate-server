import { describe, expect, it } from "vitest";
import { isUsableRedditUiTree, parseUiTreeResult } from "./mapping-routes";
import { filterRelevantElements } from "./element-filter";
import { buildPageDetection } from "./page-fingerprint";
import { validateAppMapQuality, type AppMap } from "./schema";

describe("reddit app-map refresh helpers", () => {
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
});
