import { describe, expect, it } from "vitest";
import { validateAppMapQuality, type AppMap } from "./schema";

function makeMap(overrides: Partial<AppMap> = {}): AppMap {
  return {
    appId: "com.reddit.frontpage",
    appName: "Reddit",
    version: "recorded-2026-05-28T00:00:00.000Z",
    appVersion: "2026.20.0",
    deviceProfile: { width: 1080, height: 2400 },
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    pageCount: 1,
    transitionCount: 0,
    pages: {
      page_0: {
        name: "home",
        discoveryOrder: 0,
        detection: {
          method: "ui_tree_signature",
          anchors: ["resourceId:main_top_app_bar_search"],
          signatureHash: "hash-home",
        },
        elements: {
          main_top_app_bar_search: {
            type: "button",
            bounds: { x: 0.1, y: 0.02, w: 0.8, h: 0.06 },
            resourceId: "main_top_app_bar_search",
            text: "",
            contentDescription: "Search",
            clickable: true,
            leadsTo: null,
          },
        },
      },
    },
    ...overrides,
  };
}

describe("validateAppMapQuality", () => {
  it("accepts maps with page signatures and normalized element bounds", () => {
    const report = validateAppMapQuality(makeMap());

    expect(report.usable).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.stats).toMatchObject({
      pageCount: 1,
      elementCount: 1,
      pagesMissingSignatureHash: 0,
      elementsMissingBounds: 0,
    });
  });

  it("reports concrete unusable-map counts", () => {
    const report = validateAppMapQuality(makeMap({
      pages: {
        page_0: {
          name: "legacy",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: [],
            signatureHash: "",
          },
          elements: {
            search: {
              type: "button",
              resourceId: "main_top_app_bar_search",
              text: "",
              contentDescription: "Search",
              clickable: true,
              leadsTo: null,
            } as any,
          },
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("1 page(s) missing detection.signatureHash");
    expect(report.errors).toContain("1 element(s) missing normalized bounds");
    expect(report.stats.pagesMissingSignatureHash).toBe(1);
    expect(report.stats.elementsMissingBounds).toBe(1);
  });
});
