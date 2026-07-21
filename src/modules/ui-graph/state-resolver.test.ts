import { describe, expect, it } from "vitest";
import { computePageSignature } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import { resolveUiState } from "./state-resolver";
import type { UiStateDefinition } from "./types";

const tree: UiTreeNode[] = [{
  packageName: "com.reddit.frontpage",
  resourceId: "com.reddit.frontpage:id/bottom_nav",
  className: "android.widget.FrameLayout",
  children: [
    { resourceId: "com.reddit.frontpage:id/home", contentDescription: "Home", className: "android.widget.Button" },
    { resourceId: "com.reddit.frontpage:id/search", contentDescription: "Search", className: "android.widget.Button" },
  ],
}];

function state(overrides: Partial<UiStateDefinition> = {}): UiStateDefinition {
  return {
    id: "home-state",
    appId: "com.reddit.frontpage",
    key: "home",
    name: "Home",
    kind: "screen",
    safetyClass: "navigation",
    variants: [{
      id: "home-default",
      key: "default",
      signatureHash: computePageSignature(tree),
      requiredAnchors: ["resourceId:com.reddit.frontpage:id/home", "contentDescription:Home"],
      optionalAnchors: ["contentDescription:Search"],
      forbiddenAnchors: ["text:Log in"],
      confidenceThreshold: 0.7,
    }],
    ...overrides,
  };
}

describe("resolveUiState", () => {
  it("prefers exact fingerprint and preserves anchor evidence", () => {
    const result = resolveUiState(tree, [state()], { appId: "com.reddit.frontpage" });
    expect(result).toMatchObject({ stateId: "home-state", variantId: "home-default", method: "exact_hash", confidence: 1 });
    expect(result.matchedAnchors).toContain("resourceid:com.reddit.frontpage:id/home");
  });

  it("resolves a stable A/B variant by weighted anchors when the hash changes", () => {
    const changed = structuredClone(tree);
    changed[0].children!.push({ text: "Popular", className: "android.widget.TextView" });
    const result = resolveUiState(changed, [state()], { appId: "com.reddit.frontpage" });
    expect(result.stateId).toBe("home-state");
    expect(result.method).toBe("anchors");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("does not let a colliding fingerprint override missing required anchors", () => {
    const colliding = state({ id: "search-state", key: "search" });
    colliding.variants = colliding.variants.map((variant) => ({
      ...variant,
      id: "search-default",
      requiredAnchors: ["resourceId:com.reddit.frontpage:id/search_surface"],
      optionalAnchors: [],
    }));

    const result = resolveUiState(tree, [state(), colliding], { appId: "com.reddit.frontpage" });
    expect(result).toMatchObject({ stateId: "home-state", method: "exact_hash", confidence: 1 });
    expect(result.ambiguousWith).toHaveLength(0);
  });

  it("fails closed when a forbidden login-wall anchor is present", () => {
    const loginWall = structuredClone(tree);
    loginWall[0].children!.push({ text: "Log in", className: "android.widget.Button" });
    const result = resolveUiState(loginWall, [state()], { appId: "com.reddit.frontpage" });
    expect(result.method).toBe("unknown");
    expect(result.stateId).toBeNull();
  });

  it("fails closed on ambiguous states", () => {
    const other = state({ id: "other-state", key: "other" });
    other.variants = other.variants.map((variant) => ({ ...variant, id: "other-default", signatureHash: null }));
    const first = state();
    first.variants = first.variants.map((variant) => ({ ...variant, signatureHash: null }));
    const result = resolveUiState(tree, [first, other], { appId: "com.reddit.frontpage" });
    expect(result.method).toBe("unknown");
    expect(result.ambiguousWith).toHaveLength(1);
  });
});
