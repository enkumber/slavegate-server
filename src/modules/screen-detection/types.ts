/**
 * screen-detection/types.ts
 * TypeScript interfaces for the Screen Detection Cascade module.
 * Story: US-SCREEN-CASCADE
 */

// ═══════════════════════════════════════════════════════════════════
// SCREEN IDs
// ═══════════════════════════════════════════════════════════════════

export type ScreenId =
  // Instagram screens
  | 'HOME_FEED'
  | 'SEARCH_EXPLORE'
  | 'SEARCH_RESULTS'
  | 'REELS_TAB'
  | 'REELS_FULLSCREEN'
  | 'CREATE_POST'
  | 'PROFILE_OWN'
  | 'PROFILE_OTHER'
  | 'NOTIFICATIONS'
  | 'DM_INBOX'
  | 'DM_CONVERSATION'
  | 'HASHTAG_FEED'
  | 'POST_DETAIL'
  | 'COMMENTS_OPEN'
  | 'STORY_VIEWER'
  | 'STORY_CAMERA'
  | 'FOLLOWERS_LIST'
  | 'FOLLOWING_LIST'
  | 'SETTINGS'
  // Reddit screens
  | 'REDDIT_HOME_FEED'
  | 'REDDIT_SUBREDDIT'
  | 'REDDIT_POST_DETAIL'
  | 'REDDIT_COMMENTS'
  | 'REDDIT_COMMENT_COMPOSE'
  | 'REDDIT_SEARCH'
  | 'REDDIT_SEARCH_RESULTS'
  | 'REDDIT_PROFILE_OWN'
  | 'REDDIT_PROFILE_OTHER'
  | 'REDDIT_INBOX'
  | 'REDDIT_SETTINGS'
  | 'REDDIT_RATE_LIMITED'
  | 'REDDIT_BANNED'
  | 'REDDIT_LOGIN'
  | 'REDDIT_CREATE_POST'
  // Overlay states
  | 'KEYBOARD_OPEN'
  | 'ACTION_SHEET'
  | 'CONFIRMATION_DIALOG'
  | 'SUGGESTIONS_POPUP'
  | 'LOGIN_REQUIRED'
  | 'ACTION_BLOCKED'
  // Fallback
  | 'UNKNOWN';

/**
 * All valid ScreenId values as a runtime array.
 * Used to build dynamic regex patterns (e.g. in VLM detector fallback).
 */
export const ALL_SCREEN_IDS: ScreenId[] = [
  // Instagram
  'HOME_FEED', 'SEARCH_EXPLORE', 'SEARCH_RESULTS', 'REELS_TAB', 'REELS_FULLSCREEN',
  'CREATE_POST', 'PROFILE_OWN', 'PROFILE_OTHER', 'NOTIFICATIONS', 'DM_INBOX',
  'DM_CONVERSATION', 'HASHTAG_FEED', 'POST_DETAIL', 'COMMENTS_OPEN', 'STORY_VIEWER',
  'STORY_CAMERA', 'FOLLOWERS_LIST', 'FOLLOWING_LIST', 'SETTINGS',
  // Reddit
  'REDDIT_HOME_FEED', 'REDDIT_SUBREDDIT', 'REDDIT_POST_DETAIL', 'REDDIT_COMMENTS',
  'REDDIT_COMMENT_COMPOSE', 'REDDIT_SEARCH', 'REDDIT_SEARCH_RESULTS',
  'REDDIT_PROFILE_OWN', 'REDDIT_PROFILE_OTHER', 'REDDIT_INBOX', 'REDDIT_SETTINGS',
  'REDDIT_RATE_LIMITED', 'REDDIT_BANNED', 'REDDIT_LOGIN', 'REDDIT_CREATE_POST',
  // Shared overlays
  'KEYBOARD_OPEN', 'ACTION_SHEET', 'CONFIRMATION_DIALOG', 'SUGGESTIONS_POPUP',
  'LOGIN_REQUIRED', 'ACTION_BLOCKED', 'UNKNOWN',
];

export type DetectionMethod = 'ui_tree' | 'ocr' | 'vlm';

export interface DetectedScreen {
  screenId: ScreenId;
  confidence: number;           // 0.0 - 1.0
  method: DetectionMethod;
  markers: string[];            // What matched (for debugging)
  navBar: {
    visible: boolean;
    selectedTab: 'home' | 'search' | 'create' | 'reels' | 'profile' | null;
  };
  overlays: ScreenId[];         // Active overlays (keyboard, dialog, etc.)
  latencyMs: number;
  rawData?: {
    uiTreeNodeCount?: number;
    ocrTextLength?: number;
    vlmTokens?: number;
  };
  error?: string;               // Present if all levels failed
}

export interface DetectionRequest {
  deviceId: string;
  platform: string;
  packageName?: string;         // Used to resolve platform="*" wildcard
  timeoutMs?: number;           // Default: 10000
  skipCache?: boolean;          // Force fresh detection
  preferredMethod?: DetectionMethod; // Force specific level
}

// ═══════════════════════════════════════════════════════════════════
// RULE DEFINITIONS (from skill file detection_rules: section)
// ═══════════════════════════════════════════════════════════════════

export interface UiMarker {
  resourceId?: string | RegExp;
  resourceId_contains?: string;
  text?: string | RegExp;
  text_contains?: string;
  text_starts_with?: string;
  contentDescription?: string | RegExp;
  contentDescription_contains?: string;
  className?: string;
  hint?: string;
}

export interface ScreenRule {
  id: ScreenId;
  priority: number;             // Higher = checked first (0-255)
  critical?: boolean;           // ACTION_BLOCKED, LOGIN — immediate return
  overlay?: boolean;            // Affects other screen detection

  uiTreeMarkers: {
    required?: UiMarker[];      // ALL must match
    anyOf?: UiMarker[];         // At least ONE must match
    exclude?: UiMarker[];       // NONE must match
  };

  ocrMarkers?: {
    required?: string[];        // Text that MUST be visible (case-insensitive)
    anyOf?: string[];           // At least one must be visible
    exclude?: string[];         // Text that must NOT be visible
    required_pattern?: string;  // Regex pattern (e.g., "^#[a-z0-9]+")
  };

  navBar: {
    visible: boolean;
    selectedTab?: 'home' | 'search' | 'create' | 'reels' | 'profile' | null;
  };
}

// ═══════════════════════════════════════════════════════════════════
// UI TREE NODE (from device A11y dump)
// ═══════════════════════════════════════════════════════════════════

export interface UiNode {
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  className?: string;
  hint?: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  clickable?: boolean;
  focusable?: boolean;
  children?: UiNode[];
}

// ═══════════════════════════════════════════════════════════════════
// OCR RESULT (from ML Kit)
// ═══════════════════════════════════════════════════════════════════

export interface OcrBlock {
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface OcrResult {
  blocks: OcrBlock[];
  fullText: string;
}

// ═══════════════════════════════════════════════════════════════════
// CACHE ENTRY (in-memory)
// ═══════════════════════════════════════════════════════════════════

export interface DetectionCacheEntry {
  result: DetectedScreen;
  ts: number;
}
