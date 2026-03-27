/**
 * skills/types.ts
 * Type definitions for skill files and cascade navigation (P2)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATES
// ═══════════════════════════════════════════════════════════════════════════════

export interface NormalizedCoords {
  x: number;  // 0.0 - 1.0 (percentage of screen width)
  y: number;  // 0.0 - 1.0 (percentage of screen height)
}

export interface PixelCoords {
  x: number;  // absolute pixels
  y: number;  // absolute pixels
}

export interface ScreenResolution {
  width: number;
  height: number;
}

// Standard resolution buckets
export const RESOLUTION_BUCKETS: ScreenResolution[] = [
  { width: 1080, height: 1920 },
  { width: 1080, height: 2340 },
  { width: 1080, height: 2400 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ELEMENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ElementType = 'fixed' | 'contextual' | 'variable';

export interface BaseElement {
  type: ElementType;
  selector: string;           // e.g., "com.instagram:id/tab_home"
  visual_hint: string;        // e.g., "house icon, bottom left"
  last_verified?: Date;
  confidence?: number;        // 0.0 - 1.0
}

export interface FixedElement extends BaseElement {
  type: 'fixed';
  coords: NormalizedCoords;
}

export interface ContextualElement extends BaseElement {
  type: 'contextual';
  screen: string;             // e.g., "profile_view"
  coords: NormalizedCoords;
}

export interface VariableElement extends BaseElement {
  type: 'variable';
  // NO coords — always ui_tree or vision
}

export type SkillElement = FixedElement | ContextualElement | VariableElement;

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION MAP
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScreenNode {
  from: string[];             // how to reach this screen (e.g., ["app_open", "bottom_nav.home"])
  elements: string[];         // elements visible on this screen (e.g., ["bottom_nav.*", "feed.post_item"])
  reaches: Record<string, string>;  // where you can go from here (e.g., { "profile_view": "tap username in feed" })
}

export type NavigationMap = Record<string, ScreenNode>;

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL FILE
// ═══════════════════════════════════════════════════════════════════════════════

export interface SkillFile {
  platform: string;           // e.g., "instagram"
  app_version: string;        // e.g., "v320.0.0"
  updated_at: Date;
  
  button_map: {
    fixed_elements: Record<string, FixedElement>;
    contextual_elements: Record<string, ContextualElement>;
    variable_elements: Record<string, VariableElement>;
    // Also support nested structure like nav.search, profile.follow, etc.
    [key: string]: any;
  };
  
  navigation?: NavigationMap;
  
  flows?: Record<string, any>;  // business flows, not auto-modified
  
  learned_coords?: Record<string, { x: number; y: number; confidence?: number; learned_at?: string; device?: string }>;  // auto-learned coordinates
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE TAP
// ═══════════════════════════════════════════════════════════════════════════════

export type TapMethod = 'coords' | 'ui_tree' | 'ocr' | 'vision';

export interface TapRequest {
  element_name: string;       // e.g., "bottom_nav.home"
  device_id: string;
  app: string;
  current_screen?: string;    // for contextual elements
}

export interface TapResult {
  success: boolean;
  method_used: TapMethod;
  method_attempted_first: TapMethod;
  fallback_chain: string[];   // e.g., ["coords_failed", "ui_tree_success"]
  coords_used?: NormalizedCoords;
  latency_ms: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE VERIFY
// ═══════════════════════════════════════════════════════════════════════════════

export type VerifyMethod = 'ui_tree' | 'vision';

export interface VerifyRequest {
  expected_screen: string;
  device_id: string;
  app: string;
}

export interface VerifyResult {
  success: boolean;
  method_used: VerifyMethod;
  latency_ms: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-LEARN
// ═══════════════════════════════════════════════════════════════════════════════

export interface CoordinateUpdate {
  app: string;
  element_name: string;
  device_id: string;
  old_coords?: NormalizedCoords;
  new_coords: NormalizedCoords;
  app_version: string;
  screen_resolution: string;
  occurrence_count: number;
  applied_to_skill: boolean;
}

export const AUTO_LEARN_THRESHOLD = 3;  // occurrences needed before applying
export const MIN_CONFIDENCE_FOR_COORDS = 0.85;

// ═══════════════════════════════════════════════════════════════════════════════
// FIRST-RUN MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

export interface MappingReport {
  device_id: string;
  app: string;
  app_version: string;
  elements_mapped: number;
  elements_failed: number;
  unmapped_elements: string[];
  screen_resolution: string;
  created_at: Date;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED CASCADE (P2.1)
// ═══════════════════════════════════════════════════════════════════════════════

export type RelationType = "inline" | "right-of" | "below" | "near";

export interface UnifiedCascadeRequest {
  target: string;           // "@nav.home" sau "diana"
  deviceId: string;
  platform?: string;        // Required for skill refs
  workflowId?: string;
  stepIndex?: number;
  near?: string;            // Spatial anchor: "@profile.avatar"
  relation?: RelationType;
  verify?: string;          // Post-tap verification
  learn?: boolean;          // Override auto-learn
  timeoutMs?: number;
}

// Note: ParsedTarget is defined in target-parser.ts to avoid duplication
