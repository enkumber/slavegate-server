import { computePageSignature } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import type { StateResolution, UiGraphContext, UiStateDefinition, UiStateVariantDefinition } from "./types";

export interface StateResolutionPolicy {
  anchorWeights: Record<string, number>;
  defaultAnchorWeight: number;
  emptyRequiredScore: number;
  maximumFuzzyConfidence: number;
  requiredAnchorContribution: number;
  optionalAnchorContribution: number;
  ambiguityMargin: number;
}

function clean(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function token(kind: string, value: string | undefined | null): string | null {
  const normalized = clean(value);
  return normalized ? `${kind}:${normalized}` : null;
}

export function uiTreeAnchorSet(nodes: UiTreeNode[]): Set<string> {
  const anchors = new Set<string>();
  const walk = (items: UiTreeNode[]) => {
    for (const node of items) {
      const resourceId = token("resourceid", node.resourceId);
      const description = token("contentdescription", node.contentDescription);
      const text = token("text", node.text);
      const className = token("class", node.className?.split(".").pop());
      const packageName = token("package", node.packageName);
      if (resourceId) anchors.add(resourceId);
      if (description) anchors.add(description);
      if (text) anchors.add(text);
      if (className) anchors.add(className);
      if (packageName) anchors.add(packageName);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return anchors;
}

function normalizeAnchor(anchor: string): string {
  const separator = anchor.indexOf(":");
  if (separator < 0) return clean(anchor);
  const rawKind = clean(anchor.slice(0, separator)).replace(/[_-]/g, "");
  const rawValue = clean(anchor.slice(separator + 1));
  const aliases: Record<string, string> = {
    id: "resourceid",
    rid: "resourceid",
    resource: "resourceid",
    resourceid: "resourceid",
    cd: "contentdescription",
    desc: "contentdescription",
    contentdesc: "contentdescription",
    contentdescription: "contentdescription",
    text: "text",
    class: "class",
    classname: "class",
    package: "package",
    packagename: "package",
    semantic: "semantic",
    semanticid: "semantic",
  };
  return `${aliases[rawKind] ?? rawKind}:${rawValue}`;
}

function matchesPattern(value: string | null | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  if (!value) return false;
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return clean(value) === clean(pattern);
  }
}

function variantContextMatches(variant: UiStateVariantDefinition, context: UiGraphContext): boolean {
  // Missing runtime metadata must not hide a state that is otherwise proven by
  // UI evidence. When metadata is present it remains a strict variant guard.
  return (!context.appVersion || matchesPattern(context.appVersion, variant.appVersionPattern))
    && (!context.locale || matchesPattern(context.locale, variant.localePattern))
    && (!variant.deviceClass || clean(variant.deviceClass) === clean(context.deviceClass));
}

function anchorWeight(anchor: string, policy: StateResolutionPolicy): number {
  const kind = anchor.slice(0, Math.max(0, anchor.indexOf(":")));
  const configured = policy.anchorWeights[kind];
  return Number.isFinite(configured) && configured > 0
    ? configured
    : policy.defaultAnchorWeight;
}

interface ScoredVariant {
  state: UiStateDefinition;
  variant: UiStateVariantDefinition;
  confidence: number;
  exact: boolean;
  matched: string[];
  missing: string[];
  forbidden: string[];
}

function scoreVariant(
  state: UiStateDefinition,
  variant: UiStateVariantDefinition,
  fingerprint: string,
  observed: Set<string>,
  context: UiGraphContext,
  policy: StateResolutionPolicy,
): ScoredVariant | null {
  if (!variantContextMatches(variant, context)) return null;

  const required = variant.requiredAnchors.map(normalizeAnchor);
  const optional = variant.optionalAnchors.map(normalizeAnchor);
  const forbidden = variant.forbiddenAnchors.map(normalizeAnchor).filter((a) => observed.has(a));
  const matchedRequired = required.filter((a) => observed.has(a));
  const missing = required.filter((a) => !observed.has(a));
  const matchedOptional = optional.filter((a) => observed.has(a));
  // The short structural fingerprint is an index, not sufficient proof by
  // itself: multiple screens can share the same top-level container hash.
  // Exact resolution therefore still requires every mandatory anchor.
  const exact = Boolean(
    variant.signatureHash
    && variant.signatureHash === fingerprint
    && missing.length === 0
    && forbidden.length === 0
  );

  if (forbidden.length > 0) {
    return { state, variant, confidence: 0, exact: false, matched: [...matchedRequired, ...matchedOptional], missing, forbidden };
  }
  if (exact) {
    return { state, variant, confidence: 1, exact: true, matched: [...matchedRequired, ...matchedOptional], missing, forbidden };
  }

  const requiredWeight = required.reduce((sum, a) => sum + anchorWeight(a, policy), 0);
  const matchedRequiredWeight = matchedRequired.reduce((sum, a) => sum + anchorWeight(a, policy), 0);
  const optionalWeight = optional.reduce((sum, a) => sum + anchorWeight(a, policy), 0);
  const matchedOptionalWeight = matchedOptional.reduce((sum, a) => sum + anchorWeight(a, policy), 0);
  const requiredScore = requiredWeight > 0
    ? matchedRequiredWeight / requiredWeight
    : policy.emptyRequiredScore;
  const optionalScore = optionalWeight > 0 ? matchedOptionalWeight / optionalWeight : 0;
  const confidence = Math.max(
    0,
    Math.min(
      policy.maximumFuzzyConfidence,
      requiredScore * policy.requiredAnchorContribution
        + optionalScore * policy.optionalAnchorContribution,
    ),
  );

  return {
    state,
    variant,
    confidence,
    exact: false,
    matched: [...matchedRequired, ...matchedOptional],
    missing,
    forbidden,
  };
}

export function resolveUiState(
  uiTree: UiTreeNode[],
  states: UiStateDefinition[],
  context: UiGraphContext,
  policy: StateResolutionPolicy,
): StateResolution {
  const fingerprint = computePageSignature(uiTree);
  const observed = uiTreeAnchorSet(uiTree);
  const scored = states
    .filter((state) => state.appId === context.appId)
    .flatMap((state) => state.variants.map((variant) => scoreVariant(state, variant, fingerprint, observed, context, policy)))
    .filter((value): value is ScoredVariant => value !== null)
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (!best) return unknown(fingerprint);

  const threshold = best.variant.confidenceThreshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return unknown(fingerprint);
  const ambiguousWith = scored.slice(1)
    .filter((candidate) => best.confidence - candidate.confidence < policy.ambiguityMargin)
    .map((candidate) => ({
      stateId: candidate.state.id,
      variantId: candidate.variant.id,
      confidence: candidate.confidence,
    }));

  if (best.confidence < threshold || ambiguousWith.length > 0) {
    return {
      ...unknown(fingerprint),
      confidence: best.confidence,
      matchedAnchors: best.matched,
      missingAnchors: best.missing,
      unexpectedAnchors: best.forbidden,
      ambiguousWith,
    };
  }

  return {
    stateId: best.state.id,
    stateKey: best.state.key,
    variantId: best.variant.id,
    variantKey: best.variant.key,
    method: best.exact ? "exact_hash" : best.missing.length === 0 ? "anchors" : "fuzzy",
    confidence: best.confidence,
    fingerprint,
    matchedAnchors: best.matched,
    missingAnchors: best.missing,
    unexpectedAnchors: best.forbidden,
    ambiguousWith,
  };
}

function unknown(fingerprint: string): StateResolution {
  return {
    stateId: null,
    stateKey: null,
    variantId: null,
    variantKey: null,
    method: "unknown",
    confidence: 0,
    fingerprint,
    matchedAnchors: [],
    missingAnchors: [],
    unexpectedAnchors: [],
    ambiguousWith: [],
  };
}
