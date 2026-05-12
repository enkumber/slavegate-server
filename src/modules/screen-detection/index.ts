/**
 * screen-detection/index.ts
 * Public exports for the Screen Detection Cascade module.
 * Story: US-SCREEN-CASCADE
 */

export { ScreenDetectionService, screenDetectionService } from './screen-detection.service';
export { resolveUiTreeResult, resolveOcrResult, resolveScreenDetectionScreenshot } from './screen-detection.service';
export { UiTreeDetector, uiTreeDetector } from './detectors/ui-tree.detector';
export { OcrDetector, ocrDetector } from './detectors/ocr.detector';
export { VlmDetector } from './detectors/vlm.detector';
export { parseDetectionRules, parseUiMarker, markerToString } from './rules/rule-engine';
export type {
  ScreenId,
  DetectionMethod,
  DetectedScreen,
  DetectionRequest,
  ScreenRule,
  UiMarker,
  UiNode,
  OcrBlock,
  OcrResult,
  DetectionCacheEntry,
} from './types';
