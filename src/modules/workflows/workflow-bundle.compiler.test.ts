import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "./types";
import {
  canCompileDeviceBundle,
  compileDeviceWorkflowBundle,
} from "./workflow-bundle.compiler";

function template(platform: string, steps: WorkflowTemplate["steps"]): WorkflowTemplate {
  return {
    id: `test-${platform}`,
    name: "test",
    platform,
    description: "test bundle",
    version: "1",
    steps,
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 1,
  };
}

describe("compileDeviceWorkflowBundle", () => {
  it("compiles BustaBuster/Chrome as one device bundle with no HBE delays", () => {
    const input = template("browser", [
      { type: "action", id: "wake", action: "screen_wake", params: {} },
      { type: "action", id: "unlock", action: "unlock", params: {} },
      { type: "action", id: "url", action: "intent_send", params: { uri: "https://example.com", packageName: "com.android.chrome" } },
      { type: "wait", id: "settle", duration: { min: 250, max: 250, distribution: "uniform" } },
      { type: "action", id: "dump", action: "ui_tree_dump", params: { outputVariable: "ui" } },
    ]);

    const bundle = compileDeviceWorkflowBundle(input, {
      workflowId: "wf-busta",
      now: new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(bundle.executionMode).toBe("device_bundle");
    expect(bundle.hbeCompiled).toBe(true);
    expect(bundle.steps).toHaveLength(input.steps.length);
    expect(bundle.steps.some(s => s.type === "action" && s.action === "human_delay")).toBe(false);
  });

  it("inserts explicit HBE only after visible actions in a native social app", () => {
    const input = template("reddit", [
      { type: "action", id: "wake", action: "screen_wake", params: {} },
      { type: "action", id: "unlock", action: "unlock", params: {} },
      { type: "action", id: "tap", action: "tap", params: { x: 0.5, y: 0.5 } },
      { type: "action", id: "scroll", action: "scroll", params: { direction: "down" } },
    ]);

    const bundle = compileDeviceWorkflowBundle(input, { workflowId: "wf-reddit" });
    const actions = bundle.steps.map(s => s.type === "action" ? s.action : s.type);
    expect(actions).toEqual([
      "screen_wake", "unlock", "tap", "human_delay", "scroll", "human_delay",
    ]);
    const delays = bundle.steps.filter((s): s is Extract<WorkflowTemplate["steps"][number], { type: "action" }> =>
      s.type === "action" && s.action === "human_delay",
    );
    expect(delays.every(s => s.params?.requiredPackage === "com.reddit.frontpage")).toBe(true);
  });

  it("keeps browser HBE opt-in and package fenced", () => {
    const input = template("browser", [
      { type: "action", id: "tap", action: "tap", params: { x: 0.2, y: 0.3, packageName: "com.android.chrome" } },
    ]);
    expect(compileDeviceWorkflowBundle(input, { workflowId: "off" }).steps).toHaveLength(1);
    const enabled = compileDeviceWorkflowBundle(input, {
      workflowId: "on",
      browserSocialHbeOptIn: true,
    });
    expect(enabled.steps).toHaveLength(2);
    expect((enabled.steps[1] as { params?: Record<string, unknown> }).params?.requiredPackage)
      .toBe("com.android.chrome");
  });

  it("falls back for adaptive or LLM actions", () => {
    const input = template("reddit", [
      { type: "action", action: "semantic_tap", params: { target: "post" } },
    ]);
    expect(canCompileDeviceBundle(input)).toBe(false);
  });
});
