# STORY: Instagram Screen Detection Cascade

**ID:** US-SCREEN-CASCADE  
**Priority:** P1  
**Requester:** Nox (orchestrator)  
**Created:** 2026-03-29  
**Status:** ✅ DONE  
**Completed:** 2026-03-29  
**Merged:** `fix/redis-startup-healthcheck` → `master`

---

## Summary

Implementare **screen detection cascade** pentru Instagram cu trei niveluri:
1. **UI Tree dump** (L1 — rapid, gratis, AccessibilityService)
2. **OCR** (L2 — ML Kit pe device)
3. **VLM** (L3 — fallback când primele două nu pot decide)

Înlocuiește complet `ensureHomeFeedVLM()` din orchestrator cu noul sistem cascade.

---

## Business Context

Actualmente `ensureHomeFeedVLM()` face:
1. Screenshot + VLM call de fiecare dată
2. Cost: ~0.02-0.05$/call (vision tokens)
3. Latență: 2-5s per VLM call

Noul sistem:
1. UI Tree dump: 0 cost, ~100-200ms
2. OCR: 0 cost (ML Kit local), ~300-500ms
3. VLM: doar când L1+L2 fail

**Estimate:** 80-90% din cazuri rezolvate la L1/L2, economie semnificativă.

---

## Current State Analysis

### Existing Infrastructure

| Component | Location | Notes |
|-----------|----------|-------|
| `ensureHomeFeedVLM()` | `orchestrator.ts:420-455` | VLM-only, no cascade |
| `InstagramParser.detectScreen()` | `parsers/instagram/parser.ts:28-42` | Basic, doar resourceIds |
| `screens:` section | `instagram.skill:35-100` | Screen indicators (partial) |
| `ui_tree_dump` job | Android agent | Funcționează |
| `ocr_find_tap` job | Android agent | Funcționează |

### Screens Defined in Skill File (Current)

```yaml
screens:
  action_blocked, login, home_feed, search_explore, own_profile,
  other_profile, followers_list, following_list, post_detail,
  comments_full, reels, stories, direct_messages
```

### Missing Screens (Need to Add)

```yaml
  reels_fullscreen, reels_tab, hashtag_feed, dm_inbox, dm_conversation,
  story_camera, create_post, settings, notifications, keyboard_open,
  camera, explore_grid, explore_search, shopping, guides, 
  suggestions_popup, action_sheet, confirmation_dialog
```

---

## Screen Catalog — FULL

### Primary Screens (Navigation Targets)

| Screen ID | Description | Nav Bar | Selected Tab |
|-----------|-------------|---------|--------------|
| `HOME_FEED` | Main feed with posts | Visible | Home |
| `SEARCH_EXPLORE` | Explore grid (photos/videos) | Visible | Search |
| `SEARCH_RESULTS` | Search results after typing | Visible | Search |
| `REELS_TAB` | Reels tab (scrollable) | Visible | Reels |
| `REELS_FULLSCREEN` | Single reel playing (immersive) | Hidden | — |
| `CREATE_POST` | Post creation flow | Hidden | — |
| `PROFILE_OWN` | Own profile page | Visible | Profile |
| `PROFILE_OTHER` | Other user's profile | Visible (back) | — |
| `NOTIFICATIONS` | Activity/notifications | Visible | — |
| `DM_INBOX` | Direct messages list | Partial | — |
| `DM_CONVERSATION` | Single DM thread | Hidden (back) | — |

### Secondary Screens

| Screen ID | Description | Nav Bar | Parent |
|-----------|-------------|---------|--------|
| `HASHTAG_FEED` | Posts with hashtag | Visible (back) | Search |
| `POST_DETAIL` | Single post expanded | Visible (back) | Feed/Profile |
| `COMMENTS_OPEN` | Comments overlay | Overlay | Post |
| `STORY_VIEWER` | Viewing stories | Hidden | Feed |
| `STORY_CAMERA` | Creating story | Hidden | — |
| `FOLLOWERS_LIST` | Followers list | Back only | Profile |
| `FOLLOWING_LIST` | Following list | Back only | Profile |
| `SETTINGS` | Settings screen | Back only | Profile |

### Overlay States (Modal)

| Screen ID | Description | Trigger |
|-----------|-------------|---------|
| `KEYBOARD_OPEN` | Software keyboard visible | Text input active |
| `ACTION_SHEET` | Bottom sheet (share, report) | Long press / options |
| `CONFIRMATION_DIALOG` | Unfollow/delete confirm | Action tap |
| `SUGGESTIONS_POPUP` | "Suggested for you" overlay | Random trigger |
| `LOGIN_REQUIRED` | Login prompt | Session expired |
| `ACTION_BLOCKED` | Rate limit dialog | Too many actions |

---

## Detection Rules per Screen

### Format Structure

```typescript
interface ScreenRule {
  id: string;
  priority: number;  // Higher = checked first
  
  // L1: UI Tree markers (resourceId, text, contentDescription)
  uiTreeMarkers: {
    required?: UiMarker[];      // ALL must match
    anyOf?: UiMarker[];         // At least ONE must match
    exclude?: UiMarker[];       // NONE must match
  };
  
  // L2: OCR markers (visible text on screen)
  ocrMarkers?: {
    required?: string[];        // Text that MUST be visible
    anyOf?: string[];           // At least one must be visible
    exclude?: string[];         // Text that must NOT be visible
  };
  
  // Navigation state
  navBar: {
    visible: boolean;
    selectedTab?: 'home' | 'search' | 'create' | 'reels' | 'profile' | null;
  };
}

interface UiMarker {
  resourceId?: string | RegExp;
  text?: string | RegExp;
  contentDescription?: string | RegExp;
  className?: string;
}
```

### HOME_FEED

```yaml
priority: 100
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/feed_tab"
    - resourceId: "com.instagram.android:id/action_bar_title"
  anyOf:
    - resourceId: "com.instagram.android:id/row_feed_photo"
    - resourceId: "com.instagram.android:id/media_group"
  exclude:
    - resourceId: "com.instagram.android:id/clips_viewer"
    - text: "Reels"
ocrMarkers:
  anyOf: ["Instagram", "Suggested for you"]
  exclude: ["Reels", "Watch again"]
navBar:
  visible: true
  selectedTab: home
```

### REELS_FULLSCREEN

```yaml
priority: 95
uiTreeMarkers:
  anyOf:
    - resourceId: "com.instagram.android:id/clips_viewer"
    - resourceId: "com.instagram.android:id/reel_viewer"
    - contentDescription_contains: "reel"
  exclude:
    - resourceId: "com.instagram.android:id/feed_tab"  # nav bar hidden
ocrMarkers:
  anyOf: ["Watch again", "♫", "🔊"]
navBar:
  visible: false
```

### REELS_TAB

```yaml
priority: 90
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/clips_tab"
  anyOf:
    - contentDescription: "Reels"
navBar:
  visible: true
  selectedTab: reels
```

### SEARCH_EXPLORE

```yaml
priority: 85
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/search_tab"
  anyOf:
    - resourceId: "com.instagram.android:id/action_bar_search_edit_text"
    - resourceId: "com.instagram.android:id/search_pill"
navBar:
  visible: true
  selectedTab: search
```

### SEARCH_RESULTS

```yaml
priority: 84
uiTreeMarkers:
  required:
    - className: "android.widget.EditText"
  anyOf:
    - resourceId: "com.instagram.android:id/row_search_user_username"
    - resourceId: "com.instagram.android:id/row_hashtag_textview_tag_name"
    - text_starts_with: "#"
navBar:
  visible: true
  selectedTab: search
```

### HASHTAG_FEED

```yaml
priority: 80
uiTreeMarkers:
  anyOf:
    - text_starts_with: "#"
    - resourceId_contains: "hashtag"
  required:
    - resourceId: "com.instagram.android:id/action_bar_back_button"
ocrMarkers:
  required_pattern: "^#[a-z0-9]+"
navBar:
  visible: true
  selectedTab: null
```

### PROFILE_OWN

```yaml
priority: 75
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/profile_tab"
  anyOf:
    - text: "Edit profile"
    - text: "Editează profilul"
    - resourceId: "com.instagram.android:id/profile_header"
navBar:
  visible: true
  selectedTab: profile
```

### PROFILE_OTHER

```yaml
priority: 74
uiTreeMarkers:
  anyOf:
    - text: "Follow"
    - text: "Following"
    - text: "Requested"
    - text: "Message"
  exclude:
    - text: "Edit profile"
  required:
    - resourceId: "com.instagram.android:id/action_bar_back_button"
navBar:
  visible: true
```

### DM_INBOX

```yaml
priority: 70
uiTreeMarkers:
  anyOf:
    - resourceId: "com.instagram.android:id/direct_tab"
    - contentDescription: "Direct"
    - text: "Messages"
navBar:
  visible: partial
```

### DM_CONVERSATION

```yaml
priority: 69
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/direct_thread"
  anyOf:
    - resourceId: "com.instagram.android:id/message_input"
    - hint: "Message..."
navBar:
  visible: false
```

### COMMENTS_OPEN

```yaml
priority: 65
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/comments_list"
  anyOf:
    - resourceId: "com.instagram.android:id/layout_comment_thread_edittext"
    - hint: "Add a comment"
navBar:
  visible: false  # overlay
```

### STORY_VIEWER

```yaml
priority: 60
uiTreeMarkers:
  anyOf:
    - resourceId: "com.instagram.android:id/story_viewer"
    - contentDescription_contains: "story"
    - resourceId: "com.instagram.android:id/story_progress"
navBar:
  visible: false
```

### NOTIFICATIONS

```yaml
priority: 55
uiTreeMarkers:
  anyOf:
    - resourceId: "com.instagram.android:id/activity_list"
    - contentDescription: "Activity"
    - text: "Activity"
ocrMarkers:
  anyOf: ["Activity", "Notifications", "This Week", "Today"]
navBar:
  visible: true
```

### POST_DETAIL

```yaml
priority: 50
uiTreeMarkers:
  required:
    - resourceId: "com.instagram.android:id/row_feed_button_like"
    - resourceId: "com.instagram.android:id/row_feed_button_comment"
  exclude:
    - resourceId: "com.instagram.android:id/feed_tab"  # not in main feed
navBar:
  visible: true
```

### KEYBOARD_OPEN (Overlay State)

```yaml
priority: 200  # Check first — affects other screen detection
uiTreeMarkers:
  anyOf:
    - className: "android.inputmethodservice.InputMethodService"
    - resourceId_contains: "keyboard"
ocrMarkers:
  # Keyboard layout detection via OCR (QWERTY row)
  anyOf: ["q w e r t y", "QWERTY"]
overlay: true
```

### ACTION_BLOCKED

```yaml
priority: 250  # Critical — check immediately
uiTreeMarkers:
  anyOf:
    - text_contains: "Action Blocked"
    - text_contains: "Try Again Later"
    - text_contains: "We restrict certain activity"
    - text_contains: "Acțiune blocată"
critical: true
```

### LOGIN_REQUIRED

```yaml
priority: 250
uiTreeMarkers:
  anyOf:
    - resourceId: "com.instagram.android:id/login_username"
    - text: "Log in"
    - text: "Log In"
    - text: "Conectează-te"
critical: true
```

---

## Acceptance Criteria

### AC1: Screen Detection Module

- [ ] **AC1.1:** Create `src/modules/screen-detection/screen-detection.service.ts`
- [ ] **AC1.2:** Export `detectScreen(deviceId, platform): Promise<DetectedScreen>`
- [ ] **AC1.3:** Cascade order: UI Tree → OCR → VLM
- [ ] **AC1.4:** Return early on first confident match (confidence ≥ 0.8)
- [ ] **AC1.5:** Track detection method used for analytics

### AC2: Screen Rules Engine

- [ ] **AC2.1:** Create `src/modules/screen-detection/rules/instagram.rules.ts`
- [ ] **AC2.2:** Define all 20+ screens from catalog above
- [ ] **AC2.3:** Support `required`, `anyOf`, `exclude` marker logic
- [ ] **AC2.4:** Handle overlay states (keyboard, dialogs)
- [ ] **AC2.5:** Critical screens (ACTION_BLOCKED, LOGIN) return immediately

### AC3: UI Tree Detection (L1)

- [ ] **AC3.1:** Use existing `ui_tree_dump` job type
- [ ] **AC3.2:** Parse XML/JSON response into UiNode tree
- [ ] **AC3.3:** Match against `uiTreeMarkers` rules
- [ ] **AC3.4:** Confidence scoring: all required + anyOf = 0.95, just anyOf = 0.85
- [ ] **AC3.5:** Latency target: < 300ms

### AC4: OCR Detection (L2)

- [ ] **AC4.1:** Use existing `ocr_full` or `ocr_find_tap` job type
- [ ] **AC4.2:** Match OCR text against `ocrMarkers` rules
- [ ] **AC4.3:** Case-insensitive matching with fuzzy tolerance
- [ ] **AC4.4:** Confidence: 0.80-0.90 based on marker count
- [ ] **AC4.5:** Latency target: < 600ms

### AC5: VLM Detection (L3)

- [ ] **AC5.1:** Only trigger when L1+L2 confidence < 0.7
- [ ] **AC5.2:** Use `vision.service.ts` with screen classification prompt
- [ ] **AC5.3:** Return one of the defined screen IDs
- [ ] **AC5.4:** Confidence: based on VLM certainty language
- [ ] **AC5.5:** Cache VLM result for 5s (screen unlikely to change)

### AC6: Integration

- [ ] **AC6.1:** Replace `ensureHomeFeedVLM()` in `orchestrator.ts`
- [ ] **AC6.2:** New method: `ensureScreen(deviceId, targetScreen): Promise<boolean>`
- [ ] **AC6.3:** If detected ≠ target → navigate (tap nav, back, etc.)
- [ ] **AC6.4:** Max 3 navigation attempts before fail
- [ ] **AC6.5:** Log all detections to `navigation_logs` table

### AC7: Skill File Integration

- [ ] **AC7.1:** Add all new screens to `instagram.skill` `screens:` section
- [ ] **AC7.2:** Add `detection_rules:` section with structured markers
- [ ] **AC7.3:** Skill file is single source of truth for screen definitions
- [ ] **AC7.4:** Rules can be updated without code deploy

### AC8: Testing

- [ ] **AC8.1:** Unit tests for rules engine (marker matching)
- [ ] **AC8.2:** Integration test with mock UI tree data
- [ ] **AC8.3:** E2E test on real device: detect 5 different screens
- [ ] **AC8.4:** Verify VLM fallback triggers only when needed

---

## Technical Design Decisions (For FORGE)

### Q1: Module Location?

**Options:**
1. `src/modules/screen-detection/` — new module
2. `src/modules/skills/screen-detection.ts` — part of skills
3. `src/modules/agents/screen-detection.ts` — part of agents

**Recommendation:** Option 1 — dedicated module, imported by orchestrator and workflows.

### Q2: Rules Storage?

**Options:**
1. Hardcoded in TypeScript
2. In skill file YAML (`screens:` section)
3. Hybrid: skill file = source, compiled to TS at build

**Recommendation:** Option 2 — skill file as source of truth. Allows runtime updates without code deploy.

### Q3: Detection Result Type?

```typescript
interface DetectedScreen {
  screenId: string;           // e.g., "HOME_FEED"
  confidence: number;         // 0.0 - 1.0
  method: 'ui_tree' | 'ocr' | 'vlm';
  markers: string[];          // What matched
  navBar?: {
    visible: boolean;
    selectedTab: string | null;
  };
  overlays?: string[];        // Active overlays (keyboard, dialog)
  latencyMs: number;
}
```

### Q4: Caching Strategy?

- UI Tree: no cache (cheap, always fresh)
- OCR: 2s cache (ML Kit on device)
- VLM: 5s cache (expensive)
- Detection result: 1s cache (for rapid consecutive calls)

---

## Dependencies

- [x] `ui_tree_dump` job type exists
- [x] `ocr_find_tap` / `ocr_full` job type exists
- [x] `vision.service.ts` exists for VLM
- [ ] **NEW:** Full-screen OCR job (current `ocr_find_tap` is element-specific)

---

## Estimated Effort

| Component | Estimate |
|-----------|----------|
| Screen rules engine | 4h |
| UI Tree detection | 2h |
| OCR detection | 2h |
| VLM fallback | 1h |
| Integration | 3h |
| Testing | 2h |
| **Total** | **14h** |

---

## Success Metrics

- **VLM calls reduced by 80%** (most screens detected at L1)
- **Detection latency < 400ms** (L1 path)
- **100% accuracy on critical screens** (ACTION_BLOCKED, LOGIN)
- **Zero regressions** in existing workflows

---

## Open Questions

1. Should we expose screen detection as API endpoint for debugging?
2. Do we need screen transition tracking (history of last N screens)?
3. Should detection rules support device-specific overrides?

---

**Next:** FORGE to provide technical design with module structure and interfaces.
