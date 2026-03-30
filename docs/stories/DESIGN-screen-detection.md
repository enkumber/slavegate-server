# DESIGN: Screen Detection Cascade

**Story:** US-SCREEN-CASCADE  
**Author:** FORGE  
**Date:** 2026-03-29  
**Status:** READY FOR IMPLEMENTATION

---

## 1. Executive Summary

Acest document definește arhitectura tehnică pentru **Screen Detection Cascade** — un sistem de identificare a ecranului curent cu 3 niveluri de fallback:

| Level | Method | Cost | Latency | Confidence |
|-------|--------|------|---------|------------|
| L1 | UI Tree (A11y) | Free | ~150ms | 0.90-0.95 |
| L2 | OCR (ML Kit) | Free | ~400ms | 0.80-0.90 |
| L3 | VLM (Claude/GPT-4V) | ~$0.03 | ~2500ms | 0.85-0.95 |

**Obiectiv:** Reducere 80%+ a VLM calls prin detectarea ecranelor la L1/L2.

---

## 2. Module Architecture

### 2.1 Directory Structure

```
src/modules/screen-detection/
├── index.ts                    # Public exports
├── types.ts                    # TypeScript interfaces
├── screen-detection.service.ts # Main service class
├── rules/
│   ├── index.ts                # Rule engine exports
│   ├── rule-engine.ts          # Generic matching logic
│   └── instagram.rules.ts      # Instagram-specific rules (generated from skill file)
├── detectors/
│   ├── ui-tree.detector.ts     # L1: AccessibilityService parsing
│   ├── ocr.detector.ts         # L2: ML Kit OCR matching
│   └── vlm.detector.ts         # L3: Vision model classification
└── __tests__/
    ├── rule-engine.test.ts
    ├── ui-tree.detector.test.ts
    └── screen-detection.service.test.ts
```

### 2.2 Integration Points

```
┌───────────────────────────────────────────────────────────────────┐
│                        orchestrator.ts                             │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ ensureAppHomeScreen()                                        │  │
│  │   └── screenDetectionService.detectScreen(deviceId, platform)│  │
│  │       └── if not HOME_FEED → navigate                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│              screen-detection.service.ts                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
│  │ L1 UI Tree  │──▶│  L2 OCR    │──▶│  L3 VLM    │                │
│  │ detector    │  │  detector   │  │  detector   │                │
│  └─────────────┘  └─────────────┘  └─────────────┘                │
│         │                │                │                        │
│         ▼                ▼                ▼                        │
│    wsServer         wsServer        visionService                  │
│  (ui_tree_dump)  (ocr_full job)   (screenshot + VLM)              │
└───────────────────────────────────────────────────────────────────┘
```

---

## 3. Interface Definitions

### 3.1 Core Types (`types.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════════
// SCREEN DETECTION TYPES
// ═══════════════════════════════════════════════════════════════════

export type ScreenId = 
  // Primary screens
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
  // Secondary screens
  | 'HASHTAG_FEED'
  | 'POST_DETAIL'
  | 'COMMENTS_OPEN'
  | 'STORY_VIEWER'
  | 'STORY_CAMERA'
  | 'FOLLOWERS_LIST'
  | 'FOLLOWING_LIST'
  | 'SETTINGS'
  // Overlay states
  | 'KEYBOARD_OPEN'
  | 'ACTION_SHEET'
  | 'CONFIRMATION_DIALOG'
  | 'SUGGESTIONS_POPUP'
  | 'LOGIN_REQUIRED'
  | 'ACTION_BLOCKED'
  // Fallback
  | 'UNKNOWN';

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
  overlays: ScreenId[];         // Active overlays (keyboard, dialog)
  latencyMs: number;
  rawData?: {
    uiTreeNodeCount?: number;
    ocrTextLength?: number;
    vlmTokens?: number;
  };
}

export interface DetectionRequest {
  deviceId: string;
  platform: string;
  timeoutMs?: number;           // Default: 10000
  skipCache?: boolean;          // Force fresh detection
  preferredMethod?: DetectionMethod; // Force specific level
}

// ═══════════════════════════════════════════════════════════════════
// RULE DEFINITIONS (from skill file)
// ═══════════════════════════════════════════════════════════════════

export interface UiMarker {
  resourceId?: string | RegExp;
  text?: string | RegExp;
  text_contains?: string;
  text_starts_with?: string;
  contentDescription?: string | RegExp;
  contentDescription_contains?: string;
  className?: string;
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
```

### 3.2 Service Interface

```typescript
// screen-detection.service.ts

export interface ScreenDetectionService {
  /**
   * Detect current screen using cascade (L1 → L2 → L3).
   * Returns early on first confident match (confidence ≥ threshold).
   */
  detectScreen(req: DetectionRequest): Promise<DetectedScreen>;

  /**
   * Check if device is on expected screen.
   * More efficient than full detection when target is known.
   */
  isOnScreen(
    deviceId: string,
    platform: string,
    expectedScreen: ScreenId
  ): Promise<{ match: boolean; actual: ScreenId; confidence: number }>;

  /**
   * Navigate to target screen if not already there.
   * Returns true if navigation successful, false if failed after maxAttempts.
   */
  ensureScreen(
    deviceId: string,
    platform: string,
    targetScreen: ScreenId,
    maxAttempts?: number  // Default: 3
  ): Promise<boolean>;

  /**
   * Get detection rules for a platform.
   * Loads from skill file's `detection_rules:` section.
   */
  getRules(platform: string): Promise<ScreenRule[]>;

  /**
   * Clear detection cache for device.
   */
  clearCache(deviceId: string): void;
}
```

---

## 4. Cascade Flow Implementation

### 4.1 Main Detection Flow

```typescript
// screen-detection.service.ts

async detectScreen(req: DetectionRequest): Promise<DetectedScreen> {
  const start = Date.now();
  const timeoutMs = req.timeoutMs ?? 10_000;
  const confidenceThreshold = 0.80;

  // Check cache first (1s TTL)
  if (!req.skipCache) {
    const cached = this.getFromCache(req.deviceId);
    if (cached && Date.now() - cached.ts < 1000) {
      return { ...cached.result, latencyMs: Date.now() - start };
    }
  }

  const rules = await this.getRules(req.platform);

  // ─── L1: UI Tree Detection ────────────────────────────────────────
  if (req.preferredMethod !== 'ocr' && req.preferredMethod !== 'vlm') {
    try {
      const uiTree = await this.fetchUiTree(req.deviceId, 3000);
      const l1Result = this.uiTreeDetector.detect(uiTree, rules);

      // Critical screens: return immediately
      if (l1Result.screenId !== 'UNKNOWN' && this.isCritical(l1Result.screenId)) {
        return this.finalize(l1Result, 'ui_tree', start);
      }

      if (l1Result.confidence >= confidenceThreshold) {
        return this.finalize(l1Result, 'ui_tree', start);
      }
    } catch (err) {
      console.warn(`[screen-detection] L1 failed: ${err.message}`);
    }
  }

  // ─── L2: OCR Detection ────────────────────────────────────────────
  if (req.preferredMethod !== 'vlm') {
    try {
      const ocrResult = await this.fetchOcr(req.deviceId, 5000);
      const l2Result = this.ocrDetector.detect(ocrResult, rules);

      if (l2Result.confidence >= confidenceThreshold) {
        return this.finalize(l2Result, 'ocr', start);
      }
    } catch (err) {
      console.warn(`[screen-detection] L2 failed: ${err.message}`);
    }
  }

  // ─── L3: VLM Detection ────────────────────────────────────────────
  try {
    const screenshot = await this.fetchScreenshot(req.deviceId, 5000);
    const l3Result = await this.vlmDetector.detect(screenshot, req.platform);
    return this.finalize(l3Result, 'vlm', start);
  } catch (err) {
    console.error(`[screen-detection] L3 failed: ${err.message}`);
  }

  // All levels failed
  return {
    screenId: 'UNKNOWN',
    confidence: 0,
    method: 'vlm',
    markers: ['all_levels_failed'],
    navBar: { visible: false, selectedTab: null },
    overlays: [],
    latencyMs: Date.now() - start,
  };
}
```

### 4.2 L1: UI Tree Detector

```typescript
// detectors/ui-tree.detector.ts

export class UiTreeDetector {
  detect(uiTree: UiNode[], rules: ScreenRule[]): Partial<DetectedScreen> {
    // Sort by priority (highest first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    // Check overlays first (priority 200+)
    const overlays: ScreenId[] = [];
    for (const rule of sortedRules.filter(r => r.overlay)) {
      if (this.matchRule(uiTree, rule)) {
        overlays.push(rule.id);
      }
    }

    // Check screens
    for (const rule of sortedRules.filter(r => !r.overlay)) {
      const match = this.matchRule(uiTree, rule);
      if (match.matches) {
        return {
          screenId: rule.id,
          confidence: match.confidence,
          markers: match.matchedMarkers,
          navBar: this.detectNavBar(uiTree, rule),
          overlays,
        };
      }
    }

    return {
      screenId: 'UNKNOWN',
      confidence: 0,
      markers: [],
      navBar: { visible: false, selectedTab: null },
      overlays,
    };
  }

  private matchRule(
    uiTree: UiNode[],
    rule: ScreenRule
  ): { matches: boolean; confidence: number; matchedMarkers: string[] } {
    const { uiTreeMarkers } = rule;
    const matchedMarkers: string[] = [];
    let requiredMatched = 0;
    let anyOfMatched = 0;

    // Flatten tree for searching
    const allNodes = this.flattenTree(uiTree);

    // Check required markers (ALL must match)
    if (uiTreeMarkers.required) {
      for (const marker of uiTreeMarkers.required) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          requiredMatched++;
          matchedMarkers.push(this.markerToString(marker));
        }
      }
      if (requiredMatched < uiTreeMarkers.required.length) {
        return { matches: false, confidence: 0, matchedMarkers };
      }
    }

    // Check anyOf markers (at least ONE must match)
    if (uiTreeMarkers.anyOf) {
      for (const marker of uiTreeMarkers.anyOf) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          anyOfMatched++;
          matchedMarkers.push(this.markerToString(marker));
        }
      }
      if (anyOfMatched === 0) {
        return { matches: false, confidence: 0, matchedMarkers };
      }
    }

    // Check exclude markers (NONE must match)
    if (uiTreeMarkers.exclude) {
      for (const marker of uiTreeMarkers.exclude) {
        if (this.nodeMatchesMarker(allNodes, marker)) {
          return { matches: false, confidence: 0, matchedMarkers: [] };
        }
      }
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(
      requiredMatched,
      uiTreeMarkers.required?.length ?? 0,
      anyOfMatched,
      uiTreeMarkers.anyOf?.length ?? 0
    );

    return { matches: true, confidence, matchedMarkers };
  }

  private calculateConfidence(
    requiredMatched: number,
    requiredTotal: number,
    anyOfMatched: number,
    anyOfTotal: number
  ): number {
    // All required + any anyOf = 0.95
    // All required + no anyOf defined = 0.90
    // Only anyOf matched = 0.85
    if (requiredTotal > 0 && anyOfTotal > 0) {
      return requiredMatched === requiredTotal && anyOfMatched > 0 ? 0.95 : 0.85;
    }
    if (requiredTotal > 0) {
      return requiredMatched === requiredTotal ? 0.90 : 0.80;
    }
    return anyOfMatched > 0 ? 0.85 : 0;
  }

  private flattenTree(nodes: UiNode[]): UiNode[] {
    const result: UiNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.children) {
        result.push(...this.flattenTree(node.children));
      }
    }
    return result;
  }

  private nodeMatchesMarker(nodes: UiNode[], marker: UiMarker): boolean {
    return nodes.some(node => {
      if (marker.resourceId) {
        const pattern = typeof marker.resourceId === 'string' 
          ? new RegExp(marker.resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          : marker.resourceId;
        if (!node.resourceId || !pattern.test(node.resourceId)) return false;
      }
      if (marker.text) {
        const pattern = typeof marker.text === 'string'
          ? new RegExp(marker.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          : marker.text;
        if (!node.text || !pattern.test(node.text)) return false;
      }
      if (marker.text_contains) {
        if (!node.text || !node.text.toLowerCase().includes(marker.text_contains.toLowerCase())) {
          return false;
        }
      }
      if (marker.text_starts_with) {
        if (!node.text || !node.text.toLowerCase().startsWith(marker.text_starts_with.toLowerCase())) {
          return false;
        }
      }
      if (marker.contentDescription) {
        const pattern = typeof marker.contentDescription === 'string'
          ? new RegExp(marker.contentDescription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          : marker.contentDescription;
        if (!node.contentDescription || !pattern.test(node.contentDescription)) return false;
      }
      if (marker.contentDescription_contains) {
        if (!node.contentDescription || 
            !node.contentDescription.toLowerCase().includes(marker.contentDescription_contains.toLowerCase())) {
          return false;
        }
      }
      if (marker.className) {
        if (node.className !== marker.className) return false;
      }
      return true;
    });
  }
}
```

### 4.3 L2: OCR Detector

```typescript
// detectors/ocr.detector.ts

export class OcrDetector {
  detect(ocrResult: OcrResult, rules: ScreenRule[]): Partial<DetectedScreen> {
    const sortedRules = [...rules]
      .filter(r => r.ocrMarkers)
      .sort((a, b) => b.priority - a.priority);

    const fullText = ocrResult.fullText.toLowerCase();

    for (const rule of sortedRules) {
      const match = this.matchOcrRule(fullText, ocrResult.blocks, rule);
      if (match.matches) {
        return {
          screenId: rule.id,
          confidence: match.confidence,
          markers: match.matchedTexts,
          navBar: rule.navBar,
          overlays: [],
        };
      }
    }

    return {
      screenId: 'UNKNOWN',
      confidence: 0,
      markers: [],
      navBar: { visible: false, selectedTab: null },
      overlays: [],
    };
  }

  private matchOcrRule(
    fullText: string,
    blocks: OcrBlock[],
    rule: ScreenRule
  ): { matches: boolean; confidence: number; matchedTexts: string[] } {
    const { ocrMarkers } = rule;
    if (!ocrMarkers) return { matches: false, confidence: 0, matchedTexts: [] };

    const matchedTexts: string[] = [];

    // Check required (ALL must be present)
    if (ocrMarkers.required) {
      for (const text of ocrMarkers.required) {
        if (!fullText.includes(text.toLowerCase())) {
          return { matches: false, confidence: 0, matchedTexts: [] };
        }
        matchedTexts.push(text);
      }
    }

    // Check anyOf (at least ONE must be present)
    if (ocrMarkers.anyOf) {
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

    // Check exclude (NONE must be present)
    if (ocrMarkers.exclude) {
      for (const text of ocrMarkers.exclude) {
        if (fullText.includes(text.toLowerCase())) {
          return { matches: false, confidence: 0, matchedTexts: [] };
        }
      }
    }

    // Check regex pattern
    if (ocrMarkers.required_pattern) {
      const pattern = new RegExp(ocrMarkers.required_pattern, 'i');
      if (!pattern.test(fullText)) {
        return { matches: false, confidence: 0, matchedTexts: [] };
      }
      matchedTexts.push(`pattern:${ocrMarkers.required_pattern}`);
    }

    // Confidence based on match quality
    const confidence = 0.80 + (matchedTexts.length * 0.02);
    return { matches: true, confidence: Math.min(confidence, 0.90), matchedTexts };
  }
}
```

### 4.4 L3: VLM Detector

```typescript
// detectors/vlm.detector.ts

export class VlmDetector {
  constructor(private visionService: VisionService) {}

  async detect(screenshotBase64: string, platform: string): Promise<Partial<DetectedScreen>> {
    const prompt = this.buildPrompt(platform);
    
    const result = await this.visionService.handleVisionRequest({
      jobId: uuidv4(),
      deviceId: 'screen-detection',
      screenshotBase64,
      requestType: 'screen_classification',
      actionType: 'detect_screen',
    });

    // Parse VLM response
    const parsed = this.parseResponse(result.sceneDescription);
    
    return {
      screenId: parsed.screenId,
      confidence: parsed.confidence,
      markers: ['vlm_classification'],
      navBar: parsed.navBar,
      overlays: parsed.overlays,
      rawData: { vlmTokens: result.tokensUsed },
    };
  }

  private buildPrompt(platform: string): string {
    return `You are a mobile UI classifier for ${platform}.

Analyze this screenshot and identify the current screen.

Reply with EXACTLY this JSON format:
{
  "screen": "<SCREEN_ID>",
  "confidence": <0.0-1.0>,
  "navBar": { "visible": <true/false>, "selectedTab": "<tab_name|null>" },
  "overlays": ["<OVERLAY_ID>", ...]
}

Valid SCREEN_IDs:
HOME_FEED, SEARCH_EXPLORE, SEARCH_RESULTS, REELS_TAB, REELS_FULLSCREEN,
CREATE_POST, PROFILE_OWN, PROFILE_OTHER, NOTIFICATIONS, DM_INBOX, DM_CONVERSATION,
HASHTAG_FEED, POST_DETAIL, COMMENTS_OPEN, STORY_VIEWER, STORY_CAMERA,
FOLLOWERS_LIST, FOLLOWING_LIST, SETTINGS, UNKNOWN

Valid OVERLAY_IDs:
KEYBOARD_OPEN, ACTION_SHEET, CONFIRMATION_DIALOG, SUGGESTIONS_POPUP,
LOGIN_REQUIRED, ACTION_BLOCKED

Valid selectedTab values:
home, search, create, reels, profile, null

Rules:
- HOME_FEED: vertical feed with posts, home tab highlighted
- REELS_FULLSCREEN: fullscreen video, nav hidden
- REELS_TAB: reels tab highlighted, multiple reels visible
- PROFILE_OWN: profile with "Edit profile" button
- PROFILE_OTHER: profile with "Follow/Following" button
- Check for KEYBOARD_OPEN overlay if keyboard visible
- Check for ACTION_BLOCKED if "Action Blocked" or "Try Again Later" text visible`;
  }

  private parseResponse(response: string): {
    screenId: ScreenId;
    confidence: number;
    navBar: { visible: boolean; selectedTab: string | null };
    overlays: ScreenId[];
  } {
    try {
      const json = JSON.parse(response);
      return {
        screenId: json.screen as ScreenId || 'UNKNOWN',
        confidence: json.confidence ?? 0.85,
        navBar: json.navBar ?? { visible: false, selectedTab: null },
        overlays: json.overlays ?? [],
      };
    } catch {
      // Fallback: extract screen name from text
      const match = response.match(/(?:screen|current).*?([A-Z_]+)/i);
      return {
        screenId: (match?.[1] as ScreenId) || 'UNKNOWN',
        confidence: 0.70,
        navBar: { visible: false, selectedTab: null },
        overlays: [],
      };
    }
  }
}
```

---

## 5. Skill File Schema

### 5.1 YAML Schema for `detection_rules:`

```yaml
# instagram.skill - updated structure

# ═══════════════════════════════════════════════════════════════════════════════
# DETECTION RULES
# Cascade-based screen identification (L1: UI Tree, L2: OCR, L3: VLM)
# ═══════════════════════════════════════════════════════════════════════════════

detection_rules:

  # ─── CRITICAL SCREENS (priority 250 — checked first) ─────────────────────────
  
  ACTION_BLOCKED:
    priority: 250
    critical: true
    ui_tree:
      anyOf:
        - text_contains: "Action Blocked"
        - text_contains: "Try Again Later"
        - text_contains: "We restrict certain activity"
        - text_contains: "Acțiune blocată"
    ocr:
      anyOf:
        - "Action Blocked"
        - "Try Again Later"
        - "restrict certain"
    nav_bar:
      visible: false

  LOGIN_REQUIRED:
    priority: 250
    critical: true
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/login_username"
        - text: "Log in"
        - text: "Log In"
        - text: "Conectează-te"
    nav_bar:
      visible: false

  # ─── OVERLAY STATES (priority 200 — affects other screens) ───────────────────

  KEYBOARD_OPEN:
    priority: 200
    overlay: true
    ui_tree:
      anyOf:
        - className: "android.inputmethodservice.InputMethodService"
        - resourceId_contains: "keyboard"
    ocr:
      anyOf:
        - "qwertyuiop"
        - "q w e r t y"
    nav_bar:
      visible: false

  CONFIRMATION_DIALOG:
    priority: 200
    overlay: true
    ui_tree:
      required:
        - className: "android.app.Dialog"
      anyOf:
        - text: "Unfollow"
        - text: "Delete"
        - text: "Remove"
        - text: "Cancel"
    nav_bar:
      visible: false

  # ─── PRIMARY SCREENS ─────────────────────────────────────────────────────────

  HOME_FEED:
    priority: 100
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/feed_tab"
      anyOf:
        - resourceId: "com.instagram.android:id/action_bar_title"
        - resourceId: "com.instagram.android:id/row_feed_photo"
        - resourceId: "com.instagram.android:id/media_group"
      exclude:
        - resourceId: "com.instagram.android:id/clips_viewer"
        - resourceId: "com.instagram.android:id/action_bar_back_button"
    ocr:
      anyOf:
        - "Instagram"
        - "Suggested for you"
      exclude:
        - "Reels"
        - "Watch again"
    nav_bar:
      visible: true
      selected_tab: home

  REELS_FULLSCREEN:
    priority: 95
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/clips_viewer"
        - resourceId: "com.instagram.android:id/reel_viewer"
        - contentDescription_contains: "reel"
      exclude:
        - resourceId: "com.instagram.android:id/feed_tab"
    ocr:
      anyOf:
        - "Watch again"
        - "♫"
        - "🔊"
    nav_bar:
      visible: false

  REELS_TAB:
    priority: 90
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/clips_tab"
      anyOf:
        - contentDescription: "Reels"
    nav_bar:
      visible: true
      selected_tab: reels

  SEARCH_EXPLORE:
    priority: 85
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/search_tab"
      anyOf:
        - resourceId: "com.instagram.android:id/action_bar_search_edit_text"
        - resourceId: "com.instagram.android:id/search_pill"
    nav_bar:
      visible: true
      selected_tab: search

  SEARCH_RESULTS:
    priority: 84
    ui_tree:
      required:
        - className: "android.widget.EditText"
      anyOf:
        - resourceId: "com.instagram.android:id/row_search_user_username"
        - resourceId: "com.instagram.android:id/row_hashtag_textview_tag_name"
        - text_starts_with: "#"
    nav_bar:
      visible: true
      selected_tab: search

  HASHTAG_FEED:
    priority: 80
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/action_bar_back_button"
      anyOf:
        - text_starts_with: "#"
        - resourceId_contains: "hashtag"
    ocr:
      required_pattern: "^#[a-z0-9]+"
    nav_bar:
      visible: true
      selected_tab: null

  PROFILE_OWN:
    priority: 75
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/profile_tab"
      anyOf:
        - text: "Edit profile"
        - text: "Editează profilul"
        - resourceId: "com.instagram.android:id/profile_header"
    nav_bar:
      visible: true
      selected_tab: profile

  PROFILE_OTHER:
    priority: 74
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/action_bar_back_button"
      anyOf:
        - text: "Follow"
        - text: "Following"
        - text: "Requested"
        - text: "Message"
      exclude:
        - text: "Edit profile"
    nav_bar:
      visible: true
      selected_tab: null

  DM_INBOX:
    priority: 70
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/direct_tab"
        - contentDescription: "Direct"
        - text: "Messages"
    nav_bar:
      visible: partial

  DM_CONVERSATION:
    priority: 69
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/direct_thread"
      anyOf:
        - resourceId: "com.instagram.android:id/message_input"
        - hint: "Message..."
    nav_bar:
      visible: false

  COMMENTS_OPEN:
    priority: 65
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/comments_list"
      anyOf:
        - resourceId: "com.instagram.android:id/layout_comment_thread_edittext"
        - hint: "Add a comment"
    nav_bar:
      visible: false

  STORY_VIEWER:
    priority: 60
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/story_viewer"
        - contentDescription_contains: "story"
        - resourceId: "com.instagram.android:id/story_progress"
    nav_bar:
      visible: false

  NOTIFICATIONS:
    priority: 55
    ui_tree:
      anyOf:
        - resourceId: "com.instagram.android:id/activity_list"
        - contentDescription: "Activity"
        - text: "Activity"
    ocr:
      anyOf:
        - "Activity"
        - "Notifications"
        - "This Week"
        - "Today"
    nav_bar:
      visible: true

  POST_DETAIL:
    priority: 50
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/row_feed_button_like"
        - resourceId: "com.instagram.android:id/row_feed_button_comment"
      exclude:
        - resourceId: "com.instagram.android:id/feed_tab"
    nav_bar:
      visible: true

  FOLLOWERS_LIST:
    priority: 45
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/follow_list_container"
      anyOf:
        - text: "Followers"
    nav_bar:
      visible: false

  FOLLOWING_LIST:
    priority: 44
    ui_tree:
      required:
        - resourceId: "com.instagram.android:id/follow_list_container"
      anyOf:
        - text: "Following"
    nav_bar:
      visible: false
```

### 5.2 Rule Parser

```typescript
// rules/rule-engine.ts

import type { ScreenRule, UiMarker } from '../types';
import yaml from 'js-yaml';

export function parseDetectionRules(skillFileContent: string): ScreenRule[] {
  const skill = yaml.load(skillFileContent) as Record<string, any>;
  const detectionRules = skill.detection_rules ?? {};
  const rules: ScreenRule[] = [];

  for (const [screenId, config] of Object.entries(detectionRules)) {
    const rule: ScreenRule = {
      id: screenId as ScreenId,
      priority: config.priority ?? 50,
      critical: config.critical ?? false,
      overlay: config.overlay ?? false,
      uiTreeMarkers: {
        required: config.ui_tree?.required?.map(parseUiMarker) ?? [],
        anyOf: config.ui_tree?.anyOf?.map(parseUiMarker) ?? [],
        exclude: config.ui_tree?.exclude?.map(parseUiMarker) ?? [],
      },
      ocrMarkers: config.ocr ? {
        required: config.ocr.required ?? [],
        anyOf: config.ocr.anyOf ?? [],
        exclude: config.ocr.exclude ?? [],
        required_pattern: config.ocr.required_pattern,
      } : undefined,
      navBar: {
        visible: config.nav_bar?.visible ?? true,
        selectedTab: config.nav_bar?.selected_tab ?? null,
      },
    };
    rules.push(rule);
  }

  return rules;
}

function parseUiMarker(input: string | Record<string, any>): UiMarker {
  if (typeof input === 'string') {
    // Legacy format: just a resourceId or text
    if (input.includes(':id/')) {
      return { resourceId: input };
    }
    return { text: input };
  }
  return input as UiMarker;
}
```

---

## 6. Migration Plan

### 6.1 Phase 1: Module Creation (No Breaking Changes)

1. Create `src/modules/screen-detection/` directory structure
2. Implement types, rule engine, and detectors
3. Add unit tests for each component
4. **DO NOT** modify orchestrator yet

### 6.2 Phase 2: Integration (Parallel Running)

1. Add `detection_rules:` section to `instagram.skill`
2. Create `screenDetectionService` singleton
3. Add new method `detectScreenCascade()` to orchestrator
4. Keep `ensureHomeFeedVLM()` intact for comparison

### 6.3 Phase 3: Switchover

1. Replace `ensureHomeFeedVLM()` body with:
```typescript
private async ensureHomeFeedVLM(deviceId: string, platform: string): Promise<boolean> {
  try {
    const result = await screenDetectionService.detectScreen({
      deviceId,
      platform,
    });
    
    console.log(`[orchestrator] Screen detected: ${result.screenId} (${result.method}, conf=${result.confidence.toFixed(2)})`);
    
    return result.screenId === 'HOME_FEED';
  } catch (err) {
    console.warn(`[orchestrator] Screen detection failed: ${err.message} — assuming Home`);
    return true; // fail-open
  }
}
```

2. Update `ensureScreen()` in orchestrator to use cascade

### 6.4 Rollback Plan

- Feature flag: `SCREEN_DETECTION_CASCADE_ENABLED=true/false`
- If false, fall back to original VLM-only implementation
- Monitor VLM token usage and detection accuracy for 48h before removing flag

---

## 7. Answers to Technical Questions

### Q1: Module location confirmed?

**Yes.** `src/modules/screen-detection/` — dedicated module.

**Rationale:** Screen detection is a cross-cutting concern used by:
- `orchestrator.ts` (navigation preamble)
- `skill.cascade.ts` (verification)
- `workflow.executor.ts` (screen transitions)
- Future: API endpoint for debugging

### Q2: Job types needed?

| Job Type | Exists | Notes |
|----------|--------|-------|
| `ui_tree_dump` | ✅ Yes | Returns JSON/XML of A11y tree |
| `screenshot_for_vlm` | ✅ Yes | 540x1200 JPEG for VLM |
| `ocr_full` | ⚠️ **NEW** | Full-screen ML Kit OCR → all text blocks |

**NEW JOB: `ocr_full`**

```typescript
// Add to dispatcher whitelist
"ocr_full",  // Full-screen OCR via ML Kit

// Android agent implementation needed:
interface OcrFullResult {
  blocks: Array<{
    text: string;
    bounds: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  fullText: string;  // All blocks concatenated
}
```

### Q3: Caching layer?

**In-memory with short TTL.**

```typescript
// screen-detection.service.ts
private cache = new Map<string, { result: DetectedScreen; ts: number }>();

// Cache TTLs:
// - Detection result: 1000ms (screen changes quickly)
// - Rules (parsed from skill file): 60000ms (rarely changes)
// - VLM result: 5000ms (expensive, unlikely to change)
```

**Why not Redis?**
- Detection is called frequently (every preamble, every navigation)
- Result is device-specific and short-lived
- Redis round-trip would add 1-2ms latency
- In-memory Map is sufficient; process restart clears cache (acceptable)

### Q4: Error handling?

```typescript
// Cascade continues on L1/L2 failure
// L3 failure returns UNKNOWN with error logged

interface DetectedScreen {
  // ... existing fields ...
  error?: string;  // Present if all levels failed
}

// In orchestrator:
if (result.screenId === 'UNKNOWN') {
  console.warn(`[orchestrator] Screen detection failed — navigating blind`);
  // Continue with coord-based nav.home tap (existing fallback)
}
```

### Q5: Logging/telemetry schema?

```sql
-- New table: screen_detection_logs
CREATE TABLE screen_detection_logs (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  detected_screen VARCHAR(64) NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  method VARCHAR(16) NOT NULL,  -- 'ui_tree', 'ocr', 'vlm'
  fallback_chain TEXT[],        -- ['L1_failed', 'L2_success']
  latency_ms INTEGER NOT NULL,
  ui_tree_nodes INTEGER,
  ocr_text_length INTEGER,
  vlm_tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_screen_detection_device ON screen_detection_logs(device_id, created_at DESC);
CREATE INDEX idx_screen_detection_method ON screen_detection_logs(method, created_at DESC);
```

---

## 8. Tasks Breakdown

### 8.1 VOLT Tasks (Backend Implementation)

| Task ID | Description | Estimate | Dependencies |
|---------|-------------|----------|--------------|
| V-SD-01 | Create `screen-detection/types.ts` with all interfaces | 1h | — |
| V-SD-02 | Implement `rule-engine.ts` (YAML parser + matcher) | 2h | V-SD-01 |
| V-SD-03 | Implement `ui-tree.detector.ts` (L1) | 2h | V-SD-01, V-SD-02 |
| V-SD-04 | Implement `ocr.detector.ts` (L2) | 1.5h | V-SD-01, V-SD-02 |
| V-SD-05 | Implement `vlm.detector.ts` (L3) | 1h | V-SD-01 |
| V-SD-06 | Implement `screen-detection.service.ts` (main cascade) | 2h | V-SD-03, V-SD-04, V-SD-05 |
| V-SD-07 | Add `detection_rules:` to `instagram.skill` | 1.5h | V-SD-02 |
| V-SD-08 | Create DB migration for `screen_detection_logs` | 0.5h | — |
| V-SD-09 | Integrate with orchestrator (replace `ensureHomeFeedVLM`) | 1h | V-SD-06 |
| V-SD-10 | Unit tests (rule engine, detectors) | 2h | V-SD-03, V-SD-04, V-SD-05 |

**Total VOLT:** ~14h

### 8.2 SPARK Tasks (Android Agent)

| Task ID | Description | Estimate | Dependencies |
|---------|-------------|----------|--------------|
| S-SD-01 | Implement `ocr_full` job handler (ML Kit full-screen) | 3h | — |
| S-SD-02 | Optimize `ui_tree_dump` response format (JSON, not XML) | 1h | — |
| S-SD-03 | Add job type to protocol definitions | 0.5h | — |

**Total SPARK:** ~4.5h

### 8.3 Integration Tests

| Task ID | Description | Estimate | Dependencies |
|---------|-------------|----------|--------------|
| I-SD-01 | E2E test: detect 5 different screens on real device | 2h | All above |
| I-SD-02 | Verify VLM fallback triggers only when needed | 1h | I-SD-01 |

**Total Integration:** ~3h

---

## 9. Risk Analysis

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Instagram A11y tree structure changes | High | Medium | Version-specific rules, canary monitoring |
| OCR fails on non-English locales | Medium | Low | Include Romanian strings in rules |
| VLM costs exceed budget | Medium | Low | L1/L2 should catch 80%+; monitor token usage |
| False positives on REELS_TAB vs REELS_FULLSCREEN | Medium | Medium | Multiple distinguishing markers |
| Cache invalidation issues | Low | Low | Short TTL (1s), clear on navigation |

---

## 10. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| VLM calls reduced | ≥80% | Compare `vlm_usage_log` before/after |
| L1 detection accuracy | ≥95% | Sample 100 detections, manual verify |
| L2 detection accuracy | ≥90% | Sample 50 OCR detections |
| Average detection latency | <400ms | From `screen_detection_logs` |
| Critical screen detection | 100% | ACTION_BLOCKED, LOGIN never missed |

---

## 11. Open Questions (Resolved)

1. **Should we expose screen detection as API endpoint?**
   - **Yes.** Add `POST /hydra/screen-detect` for debugging.
   
2. **Do we need screen transition tracking?**
   - **Not in V1.** Can add `previous_screen` to logs later if needed.

3. **Should detection rules support device-specific overrides?**
   - **Not in V1.** Resolution-specific coords are handled by `learned_coords`.

---

**Next Steps:**
1. ATLAS reviews design
2. Route V-SD-* tasks to VOLT
3. Route S-SD-* tasks to SPARK
4. VOLT starts with V-SD-01 → V-SD-02 → V-SD-03 (critical path)
