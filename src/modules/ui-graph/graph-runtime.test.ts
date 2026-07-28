import { describe, expect, it, vi } from "vitest";
import { computePageSignature } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import { GraphRuntimeEngine } from "./graph-runtime";
import type { UiStateDefinition, UiTransitionDefinition } from "./types";
import type { StateResolutionPolicy } from "./state-resolver";

const resolutionPolicy: StateResolutionPolicy = {
  anchorWeights: { resourceid: 1 },
  defaultAnchorWeight: 1,
  emptyRequiredScore: 0,
  maximumFuzzyConfidence: 1,
  requiredAnchorContribution: 1,
  optionalAnchorContribution: 0,
  ambiguityMargin: 0.01,
};

function tree(label: string): UiTreeNode[] {
  return [{ resourceId: `app:id/${label}`, text: label, className: "android.widget.Button" }];
}

function state(id: string): UiStateDefinition {
  const nodes = tree(id);
  return {
    id, appId: "app", key: id, name: id, kind: id === "popup" ? "overlay" : "screen", safetyClass: "navigation",
    variants: [{
      id: `${id}-variant`,
      key: "default",
      signatureHash: computePageSignature(nodes),
      requiredAnchors: [`resourceId:app:id/${id}`],
      optionalAnchors: [],
      forbiddenAnchors: [],
      confidenceThreshold: 0.7,
    }],
  };
}

function transition(id: string, source: string, target: string): UiTransitionDefinition {
  return { id, key: id, appId: "app", sourceStateId: source, targetStateId: target, action: { type: "tap" }, cost: 1, safetyClass: "navigation", confidence: 0.95 };
}

describe("GraphRuntimeEngine", () => {
  it("replans from a known popup overlay without invoking AI", async () => {
    const observations = [tree("home"), tree("popup"), tree("target")];
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const save = vi.fn().mockResolvedValue(undefined);
    const engine = new GraphRuntimeEngine(
      [state("home"), state("popup"), state("target")],
      [transition("home-target", "home", "target"), transition("dismiss", "popup", "home"), transition("popup-target", "popup", "target")],
      { appId: "app" },
      { allowedSafetyClasses: ["navigation"], minimumConfidence: 0.7, maxTransitions: 20 },
      resolutionPolicy,
      {
        captureUiTree: async () => observations.shift() ?? tree("target"),
        executeTransition: execute,
        saveCheckpoint: save,
      },
      { maxTransitions: 30, maxReplans: 8, maxDurationMs: 180_000 },
    );
    const result = await engine.run("target");
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.checkpoint.completedTransitionIds).toEqual(["home-target", "popup-target"]);
  });

  it("fails closed on an unknown state", async () => {
    const engine = new GraphRuntimeEngine(
      [state("home")], [], { appId: "app" }, { allowedSafetyClasses: ["navigation"], minimumConfidence: 0.7, maxTransitions: 20 },
      resolutionPolicy,
      { captureUiTree: async () => tree("unknown"), executeTransition: async () => ({ ok: true }), saveCheckpoint: async () => undefined },
      { maxTransitions: 30, maxReplans: 8, maxDurationMs: 180_000 },
    );
    const result = await engine.run("home");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });
});
