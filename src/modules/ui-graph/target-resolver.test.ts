import { describe, expect, it } from "vitest";
import type { UiTreeNode } from "../app-mapping/schema";
import { resolveUiTarget } from "./target-resolver";
import type { UiSelectorDefinition } from "./types";

const tree: UiTreeNode[] = [{
  bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
  children: [{
    resourceId: "com.reddit.frontpage:id/search",
    contentDescription: "Search",
    text: "Search",
    className: "android.widget.Button",
    clickable: true,
    bounds: { left: 800, top: 2200, right: 1000, bottom: 2380 },
  }],
}];

const base: Omit<UiSelectorDefinition, "id" | "strategy"> = {
  stateId: "home",
  elementKey: "search",
  priority: 100,
  dynamic: false,
  confidence: 0.9,
  status: "promoted",
  variantId: "home-default",
};

describe("resolveUiTarget", () => {
  it("resolves resource id before coordinate cache", () => {
    const result = resolveUiTarget(tree, [
      { ...base, id: "coords", strategy: "normalized_coords", coords: { x: 0.5, y: 0.5 }, confidence: 0.99 },
      { ...base, id: "rid", strategy: "resource_id", value: "com.reddit.frontpage:id/search", priority: 10 },
    ], { appId: "com.reddit.frontpage", currentStateId: "home", currentVariantId: "home-default", screenWidth: 1080, screenHeight: 2400 });
    expect(result.method).toBe("resource_id");
    expect(result.selectorId).toBe("rid");
    expect(result.coords?.x).toBeCloseTo(0.833, 2);
  });

  it("uses guarded normalized coordinates only after selector miss", () => {
    const result = resolveUiTarget(tree, [
      { ...base, id: "missing", strategy: "resource_id", value: "missing" },
      { ...base, id: "coords", strategy: "normalized_coords", coords: { x: 0.8, y: 0.9 }, confidence: 0.8 },
    ], { appId: "com.reddit.frontpage", currentStateId: "home", currentVariantId: "home-default" });
    expect(result.method).toBe("coord_cache");
    expect(result.attempted).toEqual(["resource_id", "coord_cache"]);
  });

  it("never persists a dynamic coordinate fallback into resolution", () => {
    const result = resolveUiTarget(tree, [
      { ...base, id: "dynamic", strategy: "normalized_coords", coords: { x: 0.2, y: 0.3 }, dynamic: true, confidence: 0.99 },
    ], { appId: "com.reddit.frontpage", currentStateId: "home", currentVariantId: "home-default" });
    expect(result.found).toBe(false);
  });
});
