/**
 * screen-detection/detectors/vlm.detector.ts
 * L3 detector: Screen identification via Vision Language Model (GPT-5.5/VLM).
 * Story: US-SCREEN-CASCADE
 *
 * Calls visionService.handleVisionRequest() with a screen_classification requestType.
 * The VLM prompt instructs the model to return JSON with screenId, confidence, navBar, overlays.
 */

import { v4 as uuidv4 } from 'uuid';
import type { DetectedScreen, ScreenId } from '../types';
import { ALL_SCREEN_IDS } from '../types';
import type { VisionService } from '../../vision/vision.service';

// ═══════════════════════════════════════════════════════════════════
// VLM RESPONSE SHAPE
// ═══════════════════════════════════════════════════════════════════

interface VlmScreenResponse {
  screen: string;
  confidence: number;
  navBar: {
    visible: boolean;
    selectedTab: string | null;
  };
  overlays: string[];
}

// ═══════════════════════════════════════════════════════════════════
// DETECTOR
// ═══════════════════════════════════════════════════════════════════

export class VlmDetector {
  constructor(private readonly visionService: VisionService) {}

  /**
   * Detect the current screen using a Vision Language Model.
   * Returns a partial DetectedScreen (no method/latencyMs — set by caller).
   */
  async detect(
    screenshotBase64: string,
    platform: string,
    deviceId: string,
  ): Promise<Omit<DetectedScreen, 'method' | 'latencyMs'>> {
    const jobId = uuidv4();

    const result = await this.visionService.handleVisionRequest({
      jobId,
      deviceId,
      screenshotBase64,
      requestType: 'screen_classification' as import('../../vision/templates/prompt-templates').RequestType,
      actionType: `detect_screen_${platform}`,
    });

    const parsed = this.parseResponse(result.sceneDescription, platform);

    return {
      screenId:   parsed.screenId,
      confidence: parsed.confidence,
      markers:    ['vlm_classification'],
      navBar:     {
        visible:     parsed.navBar.visible,
        selectedTab: (parsed.navBar.selectedTab ?? null) as DetectedScreen['navBar']['selectedTab'],
      },
      overlays:   parsed.overlays,
      rawData:    { vlmTokens: result.tokensUsed },
    };
  }

  // ─── Response parsing ────────────────────────────────────────────────────────

  private parseResponse(
    response: string,
    _platform: string,
  ): {
    screenId:   ScreenId;
    confidence: number;
    navBar:     { visible: boolean; selectedTab: string | null };
    overlays:   ScreenId[];
  } {
    // Attempt JSON parse first
    try {
      // Handle markdown code blocks from some VLM outputs
      const jsonStr = extractJson(response);
      const json = JSON.parse(jsonStr) as Partial<VlmScreenResponse>;

      return {
        screenId:   (json.screen as ScreenId) || 'UNKNOWN',
        confidence: typeof json.confidence === 'number' ? json.confidence : 0.85,
        navBar:     {
          visible:     json.navBar?.visible ?? false,
          selectedTab: json.navBar?.selectedTab ?? null,
        },
        overlays:   (json.overlays ?? []) as ScreenId[],
      };
    } catch {
      // Fallback: extract screen name from free-form text (built dynamically from ALL_SCREEN_IDS)
      const screenIdsPattern = ALL_SCREEN_IDS.join('|');
      const screenMatch = response.match(new RegExp(`\\b(${screenIdsPattern})\\b`, 'i'));

      return {
        screenId:   (screenMatch?.[1]?.toUpperCase() as ScreenId) ?? 'UNKNOWN',
        confidence: 0.70, // Lower confidence for text extraction fallback
        navBar:     { visible: false, selectedTab: null },
        overlays:   [],
      };
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Extract JSON content from a string, handling markdown code blocks.
 */
function extractJson(text: string): string {
  // Remove markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  // Find first { ... } block
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return text;
}
