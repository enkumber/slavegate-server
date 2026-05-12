/**
 * screen-detection/detectors/ocr.detector.ts
 * L2 detector: Screen identification via ML Kit OCR full-screen text.
 * Story: US-SCREEN-CASCADE
 *
 * NOTE: This detector uses the `ocr_full` job type which is being implemented
 * by SPARK in parallel (S-SD-01). Until then, the service handles the async
 * job dispatch and result handling.
 */

import type {
  OcrResult,
  OcrBlock,
  ScreenRule,
  DetectedScreen,
} from '../types';

// ═══════════════════════════════════════════════════════════════════
// DETECTOR
// ═══════════════════════════════════════════════════════════════════

export class OcrDetector {
  /**
   * Detect the current screen from OCR full-screen text.
   * Returns a partial DetectedScreen (no method/latencyMs — set by caller).
   */
  detect(
    ocrResult: OcrResult,
    rules: ScreenRule[],
  ): Omit<DetectedScreen, 'method' | 'latencyMs'> {
    // Only process rules that have ocrMarkers defined
    const ocrRules = rules
      .filter(r => r.ocrMarkers)
      .sort((a, b) => b.priority - a.priority);

    const fullText = ocrResult.fullText.toLowerCase();

    // ── Check critical screens first ─────────────────────────────────────────
    for (const rule of ocrRules.filter(r => r.critical)) {
      const match = this.matchOcrRule(fullText, ocrResult.blocks, rule);
      if (match.matches) {
        return {
          screenId:   rule.id,
          confidence: match.confidence,
          markers:    match.matchedTexts,
          navBar:     { visible: rule.navBar.visible, selectedTab: rule.navBar.selectedTab ?? null },
          overlays:   [],
          rawData:    { ocrTextLength: ocrResult.fullText.length },
        };
      }
    }

    // ── Check remaining rules ────────────────────────────────────────────────
    for (const rule of ocrRules.filter(r => !r.critical)) {
      const match = this.matchOcrRule(fullText, ocrResult.blocks, rule);
      if (match.matches) {
        return {
          screenId:   rule.id,
          confidence: match.confidence,
          markers:    match.matchedTexts,
          navBar:     { visible: rule.navBar.visible, selectedTab: rule.navBar.selectedTab ?? null },
          overlays:   [],
          rawData:    { ocrTextLength: ocrResult.fullText.length },
        };
      }
    }

    return {
      screenId:   'UNKNOWN',
      confidence: 0,
      markers:    [],
      navBar:     { visible: false, selectedTab: null },
      overlays:   [],
      rawData:    { ocrTextLength: ocrResult.fullText.length },
    };
  }

  // ─── Rule matching ───────────────────────────────────────────────────────────

  private matchOcrRule(
    fullText: string,
    _blocks: OcrBlock[], // reserved for spatial matching (e.g. relative position checks)
    rule: ScreenRule,
  ): { matches: boolean; confidence: number; matchedTexts: string[] } {
    const { ocrMarkers } = rule;
    if (!ocrMarkers) return { matches: false, confidence: 0, matchedTexts: [] };

    const matchedTexts: string[] = [];

    // ── Check required (ALL must be present, case-insensitive) ────────────────
    if (ocrMarkers.required && ocrMarkers.required.length > 0) {
      for (const text of ocrMarkers.required) {
        if (!fullText.includes(text.toLowerCase())) {
          return { matches: false, confidence: 0, matchedTexts: [] };
        }
        matchedTexts.push(text);
      }
    }

    // ── Check anyOf (at least ONE must be present) ─────────────────────────────
    if (ocrMarkers.anyOf && ocrMarkers.anyOf.length > 0) {
      let found = false;
      for (const text of ocrMarkers.anyOf) {
        if (fullText.includes(text.toLowerCase())) {
          found = true;
          matchedTexts.push(text);
        }
      }
      if (!found) {
        return { matches: false, confidence: 0, matchedTexts: [] };
      }
    }

    // ── Check exclude (NONE must be present) ─────────────────────────────────
    if (ocrMarkers.exclude && ocrMarkers.exclude.length > 0) {
      for (const text of ocrMarkers.exclude) {
        if (fullText.includes(text.toLowerCase())) {
          return { matches: false, confidence: 0, matchedTexts: [] };
        }
      }
    }

    // ── Check regex pattern ───────────────────────────────────────────────────
    if (ocrMarkers.required_pattern) {
      const pattern = new RegExp(ocrMarkers.required_pattern, 'i');
      if (!pattern.test(fullText)) {
        return { matches: false, confidence: 0, matchedTexts: [] };
      }
      matchedTexts.push(`pattern:${ocrMarkers.required_pattern}`);
    }

    // Nothing matched at all (no markers defined)
    if (
      (!ocrMarkers.required || ocrMarkers.required.length === 0) &&
      (!ocrMarkers.anyOf    || ocrMarkers.anyOf.length    === 0) &&
      !ocrMarkers.required_pattern
    ) {
      return { matches: false, confidence: 0, matchedTexts: [] };
    }

    // ── Confidence based on match count ──────────────────────────────────────
    // More matched terms → higher confidence, capped at 0.90
    const baseConfidence = 0.80;
    const bonus = Math.min(matchedTexts.length * 0.02, 0.10);
    const confidence = baseConfidence + bonus;

    return { matches: true, confidence, matchedTexts };
  }
}

export const ocrDetector = new OcrDetector();
