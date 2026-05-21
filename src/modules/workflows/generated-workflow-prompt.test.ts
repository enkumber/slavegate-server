import { describe, expect, it } from "vitest";
import { buildGeneratedWorkflowPrompt } from "./generated-workflow-prompt";

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
});
