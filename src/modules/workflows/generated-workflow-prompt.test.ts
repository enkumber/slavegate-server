import { describe, expect, it } from "vitest";
import {
  buildGeneratedWorkflowAppMapHints,
  buildGeneratedWorkflowPrompt,
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
    expect(prompt).toContain("Do not include client secrets");
  });

  it("summarizes app maps into compact prompt hints", () => {
    const hints = buildGeneratedWorkflowAppMapHints({
      appId: "com.reddit.frontpage",
      appName: "Reddit",
      version: "3.0.0",
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

    expect(hints[0]).toContain("Reddit (com.reddit.frontpage)");
    expect(hints).toContain("page_0: home; signature=abc123; anchors=home_screen_surface, feed_lazy_column");
    expect(hints.join("\n")).toContain("main_top_app_bar_search");
    expect(hints.join("\n")).toContain("-> page_1");
  });

  it("resolves platform screens when the caller does not provide a screen list", () => {
    const redditScreens = resolveGeneratedWorkflowScreens("reddit");
    expect(redditScreens).toContain("REDDIT_HOME_FEED");
    expect(redditScreens).toContain("REDDIT_RATE_LIMITED");
    expect(redditScreens).toContain("ACTION_BLOCKED");
    expect(redditScreens).not.toContain("HOME_FEED");

    const instagramScreens = resolveGeneratedWorkflowScreens("instagram");
    expect(instagramScreens).toContain("HOME_FEED");
    expect(instagramScreens).toContain("ACTION_BLOCKED");
    expect(instagramScreens).not.toContain("REDDIT_HOME_FEED");

    expect(resolveGeneratedWorkflowScreens("reddit", ["CUSTOM_SCREEN"])).toEqual(["CUSTOM_SCREEN"]);
  });
});
