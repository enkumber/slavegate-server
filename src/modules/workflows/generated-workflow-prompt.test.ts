import { describe, expect, it } from "vitest";
import {
  buildGeneratedWorkflowAppMapHints,
  buildGeneratedWorkflowPrompt,
  computeGeneratedWorkflowRequestKey,
  resolveGeneratedWorkflowScreens,
} from "./generated-workflow-prompt";

describe("buildGeneratedWorkflowPrompt", () => {
  it("builds an agent prompt tied to the generated workflow validation contract", () => {
    const prompt = buildGeneratedWorkflowPrompt({
      platform: "reddit",
      packageName: "com.reddit.frontpage",
      goal: "Open Reddit home and verify the feed is loaded.",
      clientContext: "No posting or voting. Navigation-only smoke workflow.",
      availableScreens: ["REDDIT_HOME_FEED", "REDDIT_LOGIN", "REDDIT_RATE_LIMITED"],
      appMapHints: ["page_0 contains main_top_app_bar_search and bottom_nav_button"],
    });

    expect(prompt).toContain("Return ONLY valid JSON");
    expect(prompt).toContain("WorkflowTemplate");
    expect(prompt).toContain("POST /api/workflows/generated/validate");
    expect(prompt).toContain("platform: reddit");
    expect(prompt).toContain("packageName: com.reddit.frontpage");
    expect(prompt).toContain("REDDIT_HOME_FEED");
    expect(prompt).toContain("Keep runtime LLM calls at zero on the happy path");
    expect(prompt).toContain("requestKey");
    expect(prompt).toContain("cache compiledPlan.cacheKey");
    expect(prompt).toContain("Do not include client secrets");
  });

  it("computes a stable request key before LLM generation", () => {
    const first = computeGeneratedWorkflowRequestKey({
      platform: "Reddit",
      packageName: "com.reddit.frontpage",
      goal: "Open Reddit home and verify the feed is loaded.",
      clientContext: "Navigation-only",
      availableScreens: ["REDDIT_RATE_LIMITED", "REDDIT_HOME_FEED"],
      appMapHints: ["page_0", "page_1"],
    });
    const second = computeGeneratedWorkflowRequestKey({
      platform: "reddit",
      packageName: "com.reddit.frontpage",
      goal: "  open   reddit home and verify the feed is loaded. ",
      clientContext: "navigation-only",
      availableScreens: ["REDDIT_HOME_FEED", "REDDIT_RATE_LIMITED"],
      appMapHints: ["page_1", "page_0"],
    });

    expect(first).toMatch(/^[a-f0-9]{24}$/);
    expect(second).toBe(first);
  });

  it("summarizes app maps into compact prompt hints", () => {
    const hintSet = buildGeneratedWorkflowAppMapHints({
      appId: "com.reddit.frontpage",
      appName: "Reddit",
      version: "3.0.0",
      appVersion: "2026.20.0",
      deviceProfile: { width: 1080, height: 2400 },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      pageCount: 1,
      transitionCount: 1,
      pages: {
        page_0: {
          name: "home",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["home_screen_surface", "feed_lazy_column"],
            signatureHash: "abc123",
          },
          elements: {
            main_top_app_bar_search: {
              type: "button",
              bounds: { x: 0.1, y: 0.02, w: 0.8, h: 0.06 },
              resourceId: "main_top_app_bar_search",
              text: "",
              contentDescription: "Search",
              clickable: true,
              leadsTo: "page_1",
            },
          },
        },
      },
    });
    const hints = hintSet.hints;

    expect(hintSet.mapUsable).toBe(true);
    expect(hints[0]).toContain("Reddit (com.reddit.frontpage)");
    expect(hints).toContain("page_0: home; signature=abc123; anchors=home_screen_surface, feed_lazy_column");
    expect(hints.join("\n")).toContain("main_top_app_bar_search");
    expect(hints.join("\n")).toContain("selector=main_top_app_bar_search");
    expect(hints.join("\n")).toContain("bounds=0.1,0.02,0.8,0.06");
    expect(hints.join("\n")).toContain("-> page_1");
  });

  it("marks legacy app-map elements without bounds unusable", () => {
    const hintSet = buildGeneratedWorkflowAppMapHints({
      appId: "com.reddit.frontpage",
      appName: "Reddit",
      version: "3.0.0",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      pageCount: 1,
      transitionCount: 0,
      pages: {
        page_0: {
          name: "home",
          discoveryOrder: 0,
          detection: {
            method: "ui_tree_signature",
            anchors: ["home_screen_surface"],
            signatureHash: "abc123",
          },
          elements: {
            legacy_search: {
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
    });

    expect(hintSet.mapUsable).toBe(false);
    expect(hintSet.reasons).toContain("1 element(s) missing normalized bounds");
    expect(hintSet.hints.join("\n")).toContain("mapUsable=false");
    expect(hintSet.hints.join("\n")).not.toContain("legacy_search: button; label=Search");
  });

  it("uses only caller/catalog supplied state identifiers", () => {
    expect(resolveGeneratedWorkflowScreens("catalog_app")).toEqual([]);
    expect(resolveGeneratedWorkflowScreens("catalog_app", ["CUSTOM_SCREEN"])).toEqual(["CUSTOM_SCREEN"]);
  });
});
