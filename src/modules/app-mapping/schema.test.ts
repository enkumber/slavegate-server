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

  it("marks maps with pages but zero elements unusable", () => {
    const report = validateAppMapQuality(makeMap({
      pageCount: 4,
      pages: {
        page_0: {
          name: "home",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["text:Home"],
            signatureHash: "hash-home",
          },
          elements: {},
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("app map has pages but no bindable elements");
    expect(report.stats).toMatchObject({
      elementCount: 0,
    });
  });

  it("marks zero selector coverage unusable", () => {
    const report = validateAppMapQuality(makeMap({
      pages: {
        page_0: {
          name: "bad selectors",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["text:Home"],
            signatureHash: "hash-home",
          },
          elements: {
            anonymous: {
              type: "button",
              bounds: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
              resourceId: "",
              text: "",
              contentDescription: "",
              clickable: true,
              leadsTo: null,
            },
          },
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("app map has zero selector coverage");
    expect(report.stats.elementsMissingSelector).toBe(1);
  });

  it("marks zero bounds coverage unusable", () => {
    const report = validateAppMapQuality(makeMap({
      pages: {
        page_0: {
          name: "bad bounds",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["text:Home"],
            signatureHash: "hash-home",
          },
          elements: {
            anonymous: {
              type: "button",
              bounds: { x: 1.2, y: 0.1, w: 0.1, h: 0.1 },
              resourceId: "bad_bounds",
              text: "",
              contentDescription: "",
              clickable: true,
              leadsTo: null,
            },
          },
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("app map has zero bounds coverage");
    expect(report.stats.elementsInvalidBounds).toBe(1);
  });

  it("marks empty-content signatures unusable", () => {
    const report = validateAppMapQuality(makeMap({
      pages: {
        page_0: {
          name: "empty",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: [],
            signatureHash: "e3b0c44298fc1c14",
          },
          elements: {
            search: {
              type: "button",
              bounds: { x: 0.1, y: 0.02, w: 0.8, h: 0.06 },
              resourceId: "search",
              text: "",
              contentDescription: "Search",
              clickable: true,
              leadsTo: null,
            },
          },
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("1 page(s) have empty-content signatureHash");
    expect(report.stats.pagesWithEmptyContentSignature).toBe(1);
  });

  it("marks empty signature hashes unusable", () => {
    const report = validateAppMapQuality(makeMap({
      pages: {
        page_0: {
          name: "empty hash",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["text:Home"],
            signatureHash: "",
          },
          elements: {
            search: {
              type: "button",
              bounds: { x: 0.1, y: 0.02, w: 0.8, h: 0.06 },
              resourceId: "search",
              text: "",
              contentDescription: "Search",
              clickable: true,
              leadsTo: null,
            },
          },
        },
      },
    }));

    expect(report.usable).toBe(false);
    expect(report.errors).toContain("1 page(s) missing detection.signatureHash");
  });
});
