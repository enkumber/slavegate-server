/**
 * screen-detection/rules/rule-engine.ts
 * YAML parser for `detection_rules:` section in skill files + generic rule matching logic.
 * Story: US-SCREEN-CASCADE
 */

import yaml from 'js-yaml';
import type { ScreenRule, UiMarker, ScreenId } from '../types';

// ═══════════════════════════════════════════════════════════════════
// YAML PARSER
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse `detection_rules:` section from a skill file YAML string.
 * Returns sorted array (highest priority first).
 */
export function parseDetectionRules(skillFileContent: string): ScreenRule[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(skillFileContent) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[rule-engine] Failed to parse skill YAML: ${(err as Error).message}`);
  }

  const detectionRules = parsed?.detection_rules as Record<string, unknown> | undefined;
  if (!detectionRules || typeof detectionRules !== 'object') {
    return [];
  }

  const rules: ScreenRule[] = [];

  for (const [screenId, rawConfig] of Object.entries(detectionRules)) {
    const config = rawConfig as Record<string, unknown>;
    if (!config || typeof config !== 'object') continue;

    const uiTree = config.ui_tree as Record<string, unknown> | undefined;
    const ocr    = config.ocr    as Record<string, unknown> | undefined;
    const navBar = config.nav_bar as Record<string, unknown> | undefined;

    const rule: ScreenRule = {
      id:       screenId as ScreenId,
      priority: (config.priority as number) ?? 50,
      critical: (config.critical as boolean) ?? false,
      overlay:  (config.overlay  as boolean) ?? false,

      uiTreeMarkers: {
        required: parseUiMarkerList((uiTree?.required as unknown[]) ?? []),
        anyOf:    parseUiMarkerList((uiTree?.anyOf    as unknown[]) ?? []),
        exclude:  parseUiMarkerList((uiTree?.exclude  as unknown[]) ?? []),
      },

      ocrMarkers: ocr ? {
        required:         asStringArray(ocr.required),
        anyOf:            asStringArray(ocr.anyOf),
        exclude:          asStringArray(ocr.exclude),
        required_pattern: (ocr.required_pattern as string) ?? undefined,
      } : undefined,

      navBar: {
        visible:     (navBar?.visible    as boolean)        ?? true,
        selectedTab: (navBar?.selected_tab as ScreenRule['navBar']['selectedTab']) ?? null,
      },
    };

    rules.push(rule);
  }

  // Sort by priority descending (critical/overlay rules first)
  rules.sort((a, b) => b.priority - a.priority);
  return rules;
}

// ═══════════════════════════════════════════════════════════════════
// MARKER PARSING HELPERS
// ═══════════════════════════════════════════════════════════════════

function parseUiMarkerList(input: unknown[]): UiMarker[] {
  if (!Array.isArray(input)) return [];
  return input.map(parseUiMarker).filter((m): m is UiMarker => m !== null);
}

/**
 * Parse a single marker from YAML.
 * Supports:
 *   - String shorthand: "com.foo:id/bar" → { resourceId }
 *   - Object form: { text_contains: "foo" }
 *   - Mixed: value with resourceId_contains, text, etc.
 */
export function parseUiMarker(input: unknown): UiMarker | null {
  if (input === null || input === undefined) return null;

  if (typeof input === 'string') {
    // Detect resourceId pattern (contains ":id/")
    if (input.includes(':id/')) {
      return { resourceId: input };
    }
    // Plain string → text match
    return { text: input };
  }

  if (typeof input === 'object') {
    // Pass through as-is — UiMarker compatible object
    return input as UiMarker;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// RULE MATCH RESULT
// ═══════════════════════════════════════════════════════════════════

export interface RuleMatchResult {
  matches: boolean;
  confidence: number;
  matchedMarkers: string[];
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════

function asStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) {
    return val.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

/**
 * Serialize a UiMarker to a human-readable string (for debugging/logging).
 */
export function markerToString(marker: UiMarker): string {
  const parts: string[] = [];
  if (marker.resourceId)              parts.push(`resourceId=${String(marker.resourceId)}`);
  if (marker.resourceId_contains)     parts.push(`resourceId_contains=${marker.resourceId_contains}`);
  if (marker.text)                    parts.push(`text=${String(marker.text)}`);
  if (marker.text_contains)           parts.push(`text_contains=${marker.text_contains}`);
  if (marker.text_starts_with)        parts.push(`text_starts_with=${marker.text_starts_with}`);
  if (marker.contentDescription)      parts.push(`contentDescription=${String(marker.contentDescription)}`);
  if (marker.contentDescription_contains) parts.push(`contentDescription_contains=${marker.contentDescription_contains}`);
  if (marker.className)               parts.push(`className=${marker.className}`);
  if (marker.hint)                    parts.push(`hint=${marker.hint}`);
  return `{${parts.join(', ')}}`;
}
