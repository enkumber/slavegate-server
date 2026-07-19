import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../workflows/types";
import { attachDeviceVerificationContracts } from "./human-workflow-normalization";

const workflow: WorkflowTemplate = {
  id: "browser-workflow",
  name: "Browser workflow",
  platform: "android",
  description: "Wake, unlock and open a URL",
  version: "1.0.0",
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 7,
  steps: [
    { id: "wake", type: "action", action: "screen_wake" },
    { id: "unlock", type: "action", action: "unlock" },
    { id: "open", type: "action", action: "intent_send", params: { uri: "https://example.com" } },
    { id: "tree", type: "action", action: "ui_tree_dump", params: { outputVariable: "_finalUiTree" } },
  ],
};

describe("device verification contract normalization", () => {
  it("adds generic local contracts without merging workflow steps", () => {
    const normalized = attachDeviceVerificationContracts(workflow, {
      source: "dashboard_human",
      intent: "Open https://example.com in Chrome",
    });

    expect(normalized.steps.map((step) => step.id)).toEqual(["wake", "unlock", "open", "tree"]);
    expect(normalized.steps[0]).toMatchObject({
      deviceVerification: { required: true, postconditions: [{ path: "screen.interactive", expected: true }] },
    });
    expect(normalized.steps[1]).toMatchObject({
      deviceVerification: {
        required: true,
        preconditions: [{ path: "screen.interactive", expected: true }],
        postconditions: [{ path: "keyguard.locked", expected: false }],
        retryPolicy: { maxAttempts: 3 },
      },
    });
    expect(normalized.steps[2]).toMatchObject({
      deviceVerification: {
        required: true,
        postconditions: [{ path: "foreground.package", expected: "com.android.chrome" }],
      },
    });
    expect(normalized.steps[3]).toMatchObject({
      deviceVerification: { required: true, postconditions: [{ path: "result.uiTreeValid", expected: true }] },
    });
  });

  it("preserves an explicit compiler supplied contract", () => {
    const explicit = {
      ...workflow,
      steps: [{
        id: "custom",
        type: "action" as const,
        action: "semantic_tap",
        deviceVerification: {
          required: true,
          postconditions: [{ path: "ui.exists", expected: "feed" }],
        },
      }],
    };
    expect(attachDeviceVerificationContracts(explicit).steps[0]).toEqual(explicit.steps[0]);
  });
});
