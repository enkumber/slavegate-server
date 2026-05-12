/**
 * data-pipeline/parser-interface.ts
 * Contract that every platform parser must implement.
 * Adding a new platform = create a folder under parsers/, implement this interface.
 * Zero changes to core code required.
 */

// ─── Core types ───────────────────────────────────────────────────────────────

export interface UiNode {
  resourceId?: string;
  contentDescription?: string;
  className?: string;
  text?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  isClickable?: boolean;
  children?: UiNode[];
}

export interface VlmResult {
  elements: Array<{
    type: string;
    text: string | null;
    bounds: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  sceneDescription: string;
  detectedState?: string;
}

export interface ExtractedContent {
  platform: string;
  contentType: "post" | "video" | "comment" | "story" | "profile" | "reel";
  /** SHA256 of (platform + author + textContent) — dedup key */
  contentHash: string;
  author: string;
  textContent: string | null;
  engagement: Partial<{
    likes: number;
    comments: number;
    shares: number;
    views: number;
    saves: number;
    reposts: number;
  }>;
  mediaUrls: string[];
  /** 1.0 = UI tree (reliable), 0.0-1.0 = VLM output (variable) */
  confidence: number;
  parserVersion: string;
  rawData?: unknown;
}

export type ScreenType =
  | "feed"
  | "profile"
  | "post_detail"
  | "story"
  | "reels"
  | "search"
  | "notifications"
  | "messages"
  | "unknown";

export interface KnownElement {
  name: string;          // e.g. "like_button", "feed_tab", "comment_input"
  strategies: Array<{
    type: "resource_id" | "content_description" | "class_position" | "text_pattern";
    value: string;
  }>;
  compatibleVersions?: string[];
}

// ─── Parser interface ─────────────────────────────────────────────────────────

export interface PlatformParser {
  readonly platform: string;
  readonly version: string;
  readonly compatibleAppVersions: string[];

  /** Returns true if this parser can handle the given app version */
  isCompatible(appVersion: string): boolean;

  /** Extract structured content from AccessibilityService UI tree dump */
  parseUiTree(uiTree: UiNode[]): ExtractedContent[];

  /** Extract structured content from VLM output (fallback path) */
  parseVlmOutput(vlmResult: VlmResult): ExtractedContent[];

  /** Known UI elements for workflow navigation on this platform */
  getKnownElements(appVersion: string): KnownElement[];

  /** Detect current screen type from UI tree */
  detectScreen(uiTree: UiNode[]): ScreenType;
}
