import type { UiTreeNode } from "../app-mapping/schema";
import type { TargetResolution, TargetResolutionMethod, UiGraphContext, UiSelectorDefinition } from "./types";

interface FlatNode {
  node: UiTreeNode;
  path: string[];
}

function clean(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function flatten(nodes: UiTreeNode[], path: string[] = []): FlatNode[] {
  const result: FlatNode[] = [];
  nodes.forEach((node, index) => {
    const className = node.className?.split(".").pop() || "node";
    const currentPath = [...path, `${className}[${index}]`];
    result.push({ node, path: currentPath });
    if (node.children?.length) result.push(...flatten(node.children, currentPath));
  });
  return result;
}

function contextMatches(selector: UiSelectorDefinition, context: UiGraphContext): boolean {
  if (selector.stateId && context.currentStateId && selector.stateId !== context.currentStateId) return false;
  // A materialized selector is scoped to the UI variant from which it was
  // observed. Do not silently widen it when runtime metadata is incomplete.
  if (selector.variantId && selector.variantId !== context.currentVariantId) return false;
  if (selector.deviceClass && clean(selector.deviceClass) !== clean(context.deviceClass)) return false;
  if (selector.appVersionPattern) {
    if (context.appVersion) {
      try {
        if (!new RegExp(selector.appVersionPattern, "i").test(context.appVersion)) return false;
      } catch {
        if (clean(selector.appVersionPattern) !== clean(context.appVersion)) return false;
      }
    } else if (!selector.variantId || selector.variantId !== context.currentVariantId) {
      // Missing package-version metadata may be replaced only by an exact
      // state-variant guard already proven from the current UI tree.
      return false;
    }
  }
  return true;
}

function nodeCenter(node: UiTreeNode, context: UiGraphContext): { x: number; y: number } | null {
  if (!node.bounds) return null;
  const { left, top, right, bottom } = node.bounds;
  const width = context.screenWidth ?? Math.max(right, 1);
  const height = context.screenHeight ?? Math.max(bottom, 1);
  if (width <= 0 || height <= 0 || right <= left || bottom <= top) return null;
  return {
    x: Math.max(0, Math.min(1, (left + (right - left) / 2) / width)),
    y: Math.max(0, Math.min(1, (top + (bottom - top) / 2) / height)),
  };
}

function semanticId(node: UiTreeNode): string {
  const source = node.resourceId || node.contentDescription || node.text || "";
  return source.split("/").pop()!.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function selectorMethod(selector: UiSelectorDefinition): TargetResolutionMethod {
  switch (selector.strategy) {
    case "resource_id": return "resource_id";
    case "content_description": return "content_description";
    case "semantic_id": return "semantic_id";
    case "text":
    case "text_contains": return "text";
    case "structural": return "structural";
    case "normalized_coords": return "coord_cache";
  }
}

function match(selector: UiSelectorDefinition, candidate: FlatNode): boolean {
  const value = clean(selector.value);
  switch (selector.strategy) {
    case "resource_id": return clean(candidate.node.resourceId) === value;
    case "content_description": return clean(candidate.node.contentDescription) === value;
    case "semantic_id": return semanticId(candidate.node) === value;
    case "text": return clean(candidate.node.text) === value;
    case "text_contains": return value.length > 0 && clean(candidate.node.text).includes(value);
    case "structural": return Boolean(selector.path?.length && selector.path.join("/") === candidate.path.join("/"));
    case "normalized_coords": return false;
  }
}

export function resolveUiTarget(
  uiTree: UiTreeNode[],
  selectors: UiSelectorDefinition[],
  context: UiGraphContext,
): TargetResolution {
  const attempted: TargetResolutionMethod[] = [];
  const candidates = flatten(uiTree);
  const eligible = selectors
    .filter((selector) => contextMatches(selector, context))
    .sort((a, b) => a.priority - b.priority || b.confidence - a.confidence);

  for (const selector of eligible.filter((item) => item.strategy !== "normalized_coords")) {
    const method = selectorMethod(selector);
    if (!attempted.includes(method)) attempted.push(method);
    const matches = candidates.filter((candidate) => match(selector, candidate));
    if (matches.length !== 1) continue;
    const coords = nodeCenter(matches[0].node, context);
    if (!coords) continue;
    return {
      found: true,
      method,
      selectorId: selector.id,
      coords,
      node: matches[0].node,
      confidence: selector.confidence,
      attempted,
    };
  }

  for (const selector of eligible.filter((item) => item.strategy === "normalized_coords" && !item.dynamic)) {
    if (!attempted.includes("coord_cache")) attempted.push("coord_cache");
    if (!selector.coords || selector.confidence < 0.7 || !selector.variantId || selector.variantId !== context.currentVariantId) continue;
    return {
      found: true,
      method: "coord_cache",
      selectorId: selector.id,
      coords: selector.coords,
      confidence: selector.confidence,
      attempted,
    };
  }

  return {
    found: false,
    method: "unknown",
    confidence: 0,
    reason: "No unique selector match or guarded coordinate cache entry",
    attempted,
  };
}
