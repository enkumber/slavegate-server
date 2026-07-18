import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "./types";
import { canCompileDeviceBundle, compileDeviceWorkflowBundle } from "./workflow-bundle.compiler";

const makeTemplate = (platform: string, steps: WorkflowTemplate["steps"]): WorkflowTemplate => ({
  id: `test-${platform}`, name: "test", platform, description: "test bundle", version: "1",
  steps, defaultVerificationStrategy: "local_only", dataRetentionDays: 1,
});

describe("compileDeviceWorkflowBundle", () => {
  it("compiles BustaBuster/Chrome with zero HBE steps", () => {
    const input = makeTemplate("browser", [
      { type: "action", id: "wake", action: "screen_wake", params: {} },
      { type: "action", id: "unlock", action: "unlock", params: {} },
      { type: "action", id: "url", action: "intent_send", params: { uri: "https://example.com", packageName: "com.android.chrome" } },
      { type: "wait", id: "settle", duration: { min: 250, max: 250, distribution: "uniform" } },
      { type: "action", id: "dump", action: "ui_tree_dump", params: { outputVariable: "ui" } },
    ]);
    const bundle = compileDeviceWorkflowBundle(input, { workflowId: "wf-busta", now: new Date("2026-07-18T00:00:00Z") });
    expect(bundle.executionMode).toBe("device_bundle");
    expect(bundle.steps).toHaveLength(input.steps.length);
    expect(bundle.steps.some(s => s.type === "action" && s.action === "human_delay")).toBe(false);
    expect(bundle.observability.dispatchCountKey).toBe("wf-busta:device-bundle-v1");
    expect(bundle.errorPolicy.unsupportedAction).toBe("hard_fail");
  });

  it("adds HBE after visible Reddit actions but never wake/unlock", () => {
    const input = makeTemplate("reddit", [
      { type: "action", id: "wake", action: "screen_wake", params: {} },
      { type: "action", id: "unlock", action: "unlock", params: {} },
      { type: "action", id: "tap", action: "tap", params: { x: 0.5, y: 0.5 } },
      { type: "action", id: "scroll", action: "scroll", params: { direction: "down" } },
    ]);
    const bundle = compileDeviceWorkflowBundle(input, { workflowId: "wf-reddit" });
    expect(bundle.steps.map(s => s.type === "action" ? s.action : s.type))
      .toEqual(["screen_wake", "unlock", "tap", "human_delay", "scroll", "human_delay"]);
    expect(bundle.steps.filter(s => s.type === "action" && s.action === "human_delay")
      .every(s => (s as { params?: Record<string, unknown> }).params?.requiredPackage === "com.reddit.frontpage")).toBe(true);
  });

  it("keeps browser HBE explicit opt-in", () => {
    const input = makeTemplate("browser", [{ type: "action", id: "tap", action: "tap",
      params: { x: 0.2, y: 0.3, packageName: "com.android.chrome" } }]);
    expect(compileDeviceWorkflowBundle(input, { workflowId: "off" }).steps).toHaveLength(1);
    expect(compileDeviceWorkflowBundle(input, { workflowId: "on", browserSocialHbeOptIn: true }).steps).toHaveLength(2);
  });

  it("normalizes eligibility for both typing action names", () => {
    const input = makeTemplate("instagram", [
      { type: "action", id: "type-a", action: "type", params: { text: "hello" } },
      { type: "action", id: "type-b", action: "type_text", params: { text: "world" } },
    ]);
    const bundle = compileDeviceWorkflowBundle(input, { workflowId: "wf-type" });
    expect(bundle.steps.map(s => s.type === "action" ? s.action : s.type))
      .toEqual(["type", "human_delay", "type_text", "human_delay"]);
  });

  it("rejects adaptive server-only actions", () => {
    expect(canCompileDeviceBundle(makeTemplate("reddit", [
      { type: "action", action: "semantic_tap", params: { target: "post" } },
    ]))).toBe(false);
    expect(canCompileDeviceBundle(makeTemplate("reddit", [
      { type: "action", action: "detect_current_screen", params: {} },
    ]))).toBe(false);
  });
});
