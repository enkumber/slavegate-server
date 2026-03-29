/**
 * screen-detection/detectors/ui-tree.detector.ts
 * L1 detector: Screen identification via Android Accessibility Service UI tree.
 * Story: US-SCREEN-CASCADE
 */

import type {
  UiNode,
  UiMarker,
  ScreenRule,
  DetectedScreen,
  ScreenId,
} from '../types';
import { markerToString } from '../rules/rule-engine';

// ═══════════════════════════════════════════════════════════════════
// DETECTOR
// ═══════════════════════════════════════════════════════════════════

export class UiTreeDetector {
  /**
   * Detect the current screen from an accessibility UI tree.
   * Returns a partial DetectedScreen (no method/latencyMs — set by caller).
   */
  detect(
    uiTree: UiNode[],
    rules: ScreenRule[],
  ): Omit<DetectedScreen, 'method' | 'latencyMs'> {
    const allNodes = this.flattenTree(uiTree);

    // Sort by priority descending (already sorted by rule-engine, but defensive)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    // ── Pass 1: Check overlays (priority 200+, overlay=true) ──────────────────
    const overlays: ScreenId[] = [];
    for (const rule of sortedRules.filter(r => r.overlay)) {
      const match = this.matchRule(allNodes, rule);
      if (match.matches) {
        overlays.push(rule.id);
      }
    }

    // ── Pass 2: Check critical screens (critical=true) ───────────────────────
    for (const rule of sortedRules.filter(r => r.critical && !r.overlay)) {
      const match = this.matchRule(allNodes, rule);
      if (match.matches) {
        return {
          screenId:   rule.id,
          confidence: match.confidence,
          markers:    match.matchedMarkers,
          navBar:     this.resolveNavBar(allNodes, rule),
          overlays,
          rawData:    { uiTreeNodeCount: allNodes.length },
        };
      }
    }

    // ── Pass 3: Check normal screens ─────────────────────────────────────────
    for (const rule of sortedRules.filter(r => !r.overlay && !r.critical)) {
      const match = this.matchRule(allNodes, rule);
      if (match.matches) {
        return {
          screenId:   rule.id,
          confidence: match.confidence,
          markers:    match.matchedMarkers,
          navBar:     this.resolveNavBar(allNodes, rule),
          overlays,
          rawData:    { uiTreeNodeCount: allNodes.length },
        };
      }
    }

    // Nothing matched
    return {
      screenId:   'UNKNOWN',
      confidence: 0,
      markers:    [],
      navBar:     { visible: false, selectedTab: null },
      overlays,
      rawData:    { uiTreeNodeCount: allNodes.length },
    };
  }

  // ─── Rule matching ───────────────────────────────────────────────────────────

  private matchRule(
    allNodes: UiNode[],
    rule: ScreenRule,
  ): { matches: boolean; confidence: number; matchedMarkers: string[] } {
    const { uiTreeMarkers } = rule;
    const matchedMarkers: string[] = [];

    // ── Check exclude first (fail-fast) ────────────────────────────────────────
    if (uiTreeMarkers.exclude && uiTreeMarkers.exclude.length > 0) {
      for (const marker of uiTreeMarkers.exclude) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          return { matches: false, confidence: 0, matchedMarkers: [] };
        }
      }
    }

    // ── Check required (ALL must match) ────────────────────────────────────────
    let requiredMatched = 0;
    const requiredTotal = uiTreeMarkers.required?.length ?? 0;

    if (requiredTotal > 0) {
      for (const marker of uiTreeMarkers.required!) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          requiredMatched++;
          matchedMarkers.push(markerToString(marker));
        }
      }
      // All required markers must match
      if (requiredMatched < requiredTotal) {
        return { matches: false, confidence: 0, matchedMarkers };
      }
    }

    // ── Check anyOf (at least ONE must match) ──────────────────────────────────
    let anyOfMatched = 0;
    const anyOfTotal = uiTreeMarkers.anyOf?.length ?? 0;

    if (anyOfTotal > 0) {
      for (const marker of uiTreeMarkers.anyOf!) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          anyOfMatched++;
          matchedMarkers.push(markerToString(marker));
        }
      }
      if (anyOfMatched === 0) {
        return { matches: false, confidence: 0, matchedMarkers };
      }
    }

    // If no markers defined at all — rule is too generic, skip
    if (requiredTotal === 0 && anyOfTotal === 0) {
      return { matches: false, confidence: 0, matchedMarkers };
    }

    const confidence = this.calculateConfidence(
      requiredMatched, requiredTotal,
      anyOfMatched,    anyOfTotal,
    );

    return { matches: true, confidence, matchedMarkers };
  }

  /**
   * Confidence calculation:
   * - All required + any anyOf matched → 0.95
   * - All required, no anyOf defined   → 0.90
   * - Only anyOf matched (no required) → 0.85
   * - Partial anyOf                    → 0.80
   */
  private calculateConfidence(
    requiredMatched: number,
    requiredTotal:   number,
    anyOfMatched:    number,
    anyOfTotal:      number,
  ): number {
    if (requiredTotal > 0 && anyOfTotal > 0) {
      return (requiredMatched === requiredTotal && anyOfMatched > 0) ? 0.95 : 0.85;
    }
    if (requiredTotal > 0) {
      return requiredMatched === requiredTotal ? 0.90 : 0.80;
    }
    // Only anyOf
    if (anyOfTotal > 0) {
      return anyOfMatched >= 2 ? 0.90 : 0.85;
    }
    return 0;
  }

  // ─── Node matching ───────────────────────────────────────────────────────────

  /**
   * Check if any node in the flattened tree satisfies ALL constraints in marker.
   * All constraints in one UiMarker are ANDed together.
   */
  private nodeMatchesMarker(nodes: UiNode[], marker: UiMarker): boolean {
    return nodes.some(node => this.singleNodeMatchesMarker(node, marker));
  }

  private singleNodeMatchesMarker(node: UiNode, marker: UiMarker): boolean {
    // resourceId exact / pattern
    if (marker.resourceId !== undefined) {
      if (!node.resourceId) return false;
      const pattern = typeof marker.resourceId === 'string'
        ? new RegExp(`^${escapeRegex(marker.resourceId)}$`)
        : marker.resourceId;
      if (!pattern.test(node.resourceId)) return false;
    }

    // resourceId_contains
    if (marker.resourceId_contains !== undefined) {
      if (!node.resourceId) return false;
      if (!node.resourceId.toLowerCase().includes(marker.resourceId_contains.toLowerCase())) return false;
    }

    // text exact / pattern
    if (marker.text !== undefined) {
      if (!node.text) return false;
      const pattern = typeof marker.text === 'string'
        ? new RegExp(`^${escapeRegex(marker.text)}$`, 'i')
        : marker.text;
      if (!pattern.test(node.text)) return false;
    }

    // text_contains
    if (marker.text_contains !== undefined) {
      if (!node.text) return false;
      if (!node.text.toLowerCase().includes(marker.text_contains.toLowerCase())) return false;
    }

    // text_starts_with
    if (marker.text_starts_with !== undefined) {
      if (!node.text) return false;
      if (!node.text.toLowerCase().startsWith(marker.text_starts_with.toLowerCase())) return false;
    }

    // contentDescription exact / pattern
    if (marker.contentDescription !== undefined) {
      if (!node.contentDescription) return false;
      const pattern = typeof marker.contentDescription === 'string'
        ? new RegExp(`^${escapeRegex(marker.contentDescription)}$`, 'i')
        : marker.contentDescription;
      if (!pattern.test(node.contentDescription)) return false;
    }

    // contentDescription_contains
    if (marker.contentDescription_contains !== undefined) {
      if (!node.contentDescription) return false;
      if (!node.contentDescription.toLowerCase().includes(marker.contentDescription_contains.toLowerCase())) return false;
    }

    // className exact match
    if (marker.className !== undefined) {
      if (node.className !== marker.className) return false;
    }

    // hint
    if (marker.hint !== undefined) {
      if (!node.hint) return false;
      if (!node.hint.toLowerCase().includes(marker.hint.toLowerCase())) return false;
    }

    return true;
  }

  // ─── NavBar resolution ───────────────────────────────────────────────────────

  private resolveNavBar(
    _nodes: UiNode[],
    rule: ScreenRule,
  ): DetectedScreen['navBar'] {
    return {
      visible:     rule.navBar.visible,
      selectedTab: rule.navBar.selectedTab ?? null,
    };
  }

  // ─── Tree flattening ─────────────────────────────────────────────────────────

  flattenTree(nodes: UiNode[]): UiNode[] {
    const result: UiNode[] = [];
    const stack: UiNode[] = [...nodes];
    while (stack.length > 0) {
      const node = stack.pop()!;
      result.push(node);
      if (node.children && node.children.length > 0) {
        stack.push(...node.children);
      }
    }
    return result;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const uiTreeDetector = new UiTreeDetector();
