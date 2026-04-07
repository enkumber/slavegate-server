/**
 * skills/cascadeCore.ts
 * Shared cascade tap logic — used by both skill.service.ts and skill.cascade.ts
 *
 * This module consolidates the duplicated cascade logic:
 * - skill.service.ts::cascadeTap() — high-level, provider-based API
 * - skill.cascade.ts::executeCascadeTap() — workflow-integrated, job-based API
 *
 * Both call into this core for consistent behavior.
 */

import type { SkillElement, NormalizedCoords, TapMethod } from "./types";
import { MIN_CONFIDENCE_FOR_COORDS } from "./types";
import { CD_MAP } from "./constants";

// Re-export isElementFixed from the fixed-elements registry
// so both cascade implementations can use it without circular imports
export { isElementFixed, loadFixedElements } from "./fixed-elements/fixed-elements";

export interface CascadeContext {
  elementName: string;
  element: SkillElement | null;
  fallbackChain: string[];
}

export interface A11ySearchParams {
  resourceId?: string;
  text?: string;
  className?: string;
  contentDescription?: string;
  partialMatch?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if element coords are usable based on confidence threshold.
 * Uses MIN_CONFIDENCE_FOR_COORDS from types.ts (0.85).
 */
export function shouldUseCoordsFromElement(element: SkillElement | null): boolean {
  if (!element) return false;
  if (element.type === "variable") return false;
  
  const coords = (element as { coords?: NormalizedCoords }).coords;
  const confidence = (element as { confidence?: number }).confidence ?? 0;
  
  return coords !== undefined && confidence >= MIN_CONFIDENCE_FOR_COORDS;
}

/**
 * Get coords from element if available and confident enough.
 */
export function getElementCoords(element: SkillElement | null): NormalizedCoords | null {
  if (!shouldUseCoordsFromElement(element)) return null;
  return (element as { coords?: NormalizedCoords }).coords ?? null;
}

/**
 * Get confidence from element.
 */
export function getElementConfidence(element: SkillElement | null): number {
  if (!element) return 0;
  return (element as { confidence?: number }).confidence ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A11Y PARAMS BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build A11y search params from a skill element's selector.
 * Handles both object selectors (new format) and string selectors (legacy).
 */
export function buildA11yParamsFromElement(element: SkillElement | null): A11ySearchParams {
  const params: A11ySearchParams = {};
  
  if (!element?.selector) return params;
  
  const selector = element.selector;
  
  // Handle object selectors (new format from .skill files)
  if (typeof selector === "object" && selector !== null) {
    const selectorObj = selector as Record<string, unknown>;
    
    if (selectorObj.resourceId) {
      params.resourceId = selectorObj.resourceId as string;
    }
    if (selectorObj.text) {
      params.text = selectorObj.text as string;
      params.partialMatch = (selectorObj.partialMatch as boolean) ?? true;
    }
    if (selectorObj.text_starts_with) {
      params.text = selectorObj.text_starts_with as string;
      params.partialMatch = true;
    }
    if (selectorObj.text_contains) {
      params.text = selectorObj.text_contains as string;
      params.partialMatch = true;
    }
    if (selectorObj.className) {
      params.className = selectorObj.className as string;
    }
    if (selectorObj.contentDescription) {
      params.contentDescription = selectorObj.contentDescription as string;
      params.partialMatch = (selectorObj.partialMatch as boolean) ?? true;
    }
  }
  // Handle string selectors (legacy format)
  else if (typeof selector === "string") {
    if (selector.includes(":id/")) {
      params.resourceId = selector;
    } else if (selector.startsWith("android.") || selector.includes(".widget.")) {
      params.className = selector;
    } else {
      params.text = selector;
      params.partialMatch = true;
    }
  }
  
  return params;
}

/**
 * Try alt_selectors if primary selector didn't yield params.
 */
export function buildA11yParamsFromAltSelectors(element: SkillElement | null): A11ySearchParams {
  const params: A11ySearchParams = {};
  
  const altSelectors = element ? (element as { alt_selectors?: unknown[] }).alt_selectors : null;
  if (!altSelectors || !Array.isArray(altSelectors)) return params;
  
  for (const altSel of altSelectors) {
    if (typeof altSel === "object" && altSel !== null) {
      const alt = altSel as Record<string, unknown>;
      if (alt.resourceId) params.resourceId = alt.resourceId as string;
      if (alt.text) {
        params.text = alt.text as string;
        params.partialMatch = true;
      }
      if (alt.text_starts_with) {
        params.text = alt.text_starts_with as string;
        params.partialMatch = true;
      }
      if (alt.className) params.className = alt.className as string;
      if (alt.contentDescription) {
        params.contentDescription = alt.contentDescription as string;
        params.partialMatch = true;
      }
      // Stop at first valid alt selector
      if (Object.keys(params).length > 0) break;
    }
  }
  
  return params;
}

/**
 * Derive contentDescription from visual_hint or elementName using CD_MAP.
 * Returns null if no match found.
 */
export function deriveContentDescriptionFromHint(
  element: SkillElement | null,
  elementName: string
): string | null {
  const hint = element
    ? (element as { visual_hint?: string }).visual_hint ?? elementName
    : elementName;
  const hintLower = hint.toLowerCase();
  
  for (const entry of CD_MAP) {
    if (hintLower.includes(entry.pattern)) {
      return entry.cd;
    }
  }
  
  return null;
}

/**
 * Build complete A11y params, trying all fallbacks.
 * Order: primary selector → alt_selectors → CD_MAP derivation
 */
export function buildCompleteA11yParams(
  element: SkillElement | null,
  elementName: string
): A11ySearchParams {
  // Try primary selector
  let params = buildA11yParamsFromElement(element);
  
  // Try alt_selectors if primary didn't yield results
  if (Object.keys(params).length === 0) {
    params = buildA11yParamsFromAltSelectors(element);
  }
  
  // Derive from CD_MAP if still no params
  if (Object.keys(params).length === 0) {
    const cd = deriveContentDescriptionFromHint(element, elementName);
    if (cd) {
      params.contentDescription = cd;
      params.partialMatch = true;
    }
  }
  
  return params;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OCR TEXT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract OCR search text from a skill element.
 * Returns null for icon-only elements (no searchable text).
 */
export function buildOcrSearchText(element: SkillElement | null): string | null {
  if (!element) return null;
  
  // From selector if it's plain text (not a resourceId or className)
  if (element.selector) {
    if (typeof element.selector === "string") {
      const sel = element.selector;
      // Skip resourceIds and classNames
      if (!sel.includes(":id/") && !sel.includes(".widget.") && !sel.startsWith("android.")) {
        return sel;
      }
    }
    if (typeof element.selector === "object" && (element.selector as Record<string, unknown>)?.text) {
      return (element.selector as Record<string, unknown>).text as string;
    }
  }
  
  // Skip icon-only elements
  const visualHint = (element as { visual_hint?: string }).visual_hint;
  if (visualHint?.match(/\b(icon|arrow|symbol|logo|avatar|image)\b/i)) {
    return null;
  }
  
  return null;
}
