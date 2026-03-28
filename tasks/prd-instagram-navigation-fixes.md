# PRD: Instagram Navigation Fixes

## Introduction

Fix remaining issues with Instagram automation in phone-network-server. The system can now open Instagram, navigate to Search, tap search bar, and type hashtags. However, scrolling through results triggers accidental text input, and tapping hashtag results often misses the target.

## Goals

- Complete a full hashtag engagement flow without errors
- Scroll through search results reliably
- Tap correct hashtag result (not accounts)
- Automate template copying in build process

## User Stories

### US-001: Fix scroll triggering text input
**Description:** As the automation system, I need scroll actions to NOT trigger text input in the search field, so that search queries remain intact during result navigation.

**Dependencies:** None
**Files:** `src/modules/agents/orchestrator.ts`, `src/modules/agents/executor.agent.ts`

**Acceptance Criteria:**
- [ ] Scroll actions use coordinates away from text input areas
- [ ] Scroll starts from center of results list, not near search bar
- [ ] After scroll, search query text is unchanged
- [ ] Typecheck passes

### US-002: Dismiss keyboard before scrolling
**Description:** As the automation system, I need to dismiss the keyboard before scrolling search results, so that scroll gestures don't trigger text input.

**Dependencies:** None  
**Files:** `src/modules/agents/orchestrator.ts`, `src/modules/skills/templates/instagram.skill`

**Acceptance Criteria:**
- [ ] After typing hashtag, press BACK to dismiss keyboard
- [ ] Verify keyboard is dismissed before proceeding to scroll/tap results
- [ ] Add `search.dismiss_keyboard` action in skill flow
- [ ] Typecheck passes

### US-003: Improve hashtag result targeting
**Description:** As the automation system, I need to tap hashtag results (starting with #) not account results, so that I navigate to hashtag feeds correctly.

**Dependencies:** US-002
**Files:** `src/modules/agents/prompts/planner.prompt.ts`, `src/modules/skills/templates/instagram.skill`

**Acceptance Criteria:**
- [ ] Planner prompt instructs to look for "#" prefix in results
- [ ] Skill file has `search.hashtag_result` element with selector for hashtag rows
- [ ] Tap targets rows with "#" visible, not profile pictures
- [ ] Typecheck passes

### US-004: Automate template copying in build
**Description:** As a developer, I need skill templates to be copied to dist/ automatically during build, so that deployments don't require manual file copying.

**Dependencies:** None
**Files:** `package.json`, `scripts/copy-templates.sh` (new)

**Acceptance Criteria:**
- [ ] `npm run build` copies `src/modules/skills/templates/*.skill` to `dist/modules/skills/templates/`
- [ ] Build script handles missing directories gracefully
- [ ] Existing templates are overwritten (fresh copy each build)
- [ ] Typecheck passes

### US-005: Add scroll coordinates to skill file
**Description:** As the automation system, I need predefined scroll regions in the skill file, so that scroll gestures happen in safe areas away from input fields.

**Dependencies:** US-001
**Files:** `src/modules/skills/templates/instagram.skill`

**Acceptance Criteria:**
- [ ] Add `search.results_scroll_region` with safe start/end coordinates
- [ ] Start Y below search bar (y > 0.15)
- [ ] End Y above nav bar (y < 0.85)
- [ ] Scroll uses these coordinates instead of center-screen defaults
- [ ] Typecheck passes

### US-006: End-to-end test flow
**Description:** As a developer, I need to verify the complete hashtag engagement flow works, so that we can confirm all fixes are effective.

**Dependencies:** US-001, US-002, US-003, US-004, US-005
**Files:** None (manual test)

**Acceptance Criteria:**
- [ ] Create test task: hashtag:#bucharest, 1 like
- [ ] Task completes successfully: search → type → dismiss keyboard → tap hashtag → scroll feed → like post
- [ ] No "search field changed" errors
- [ ] No "wrong screen" errors
- [ ] Task status shows "completed"

## Functional Requirements

- FR-1: Scroll gestures must start/end outside text input regions
- FR-2: Keyboard must be dismissed before result interaction
- FR-3: Hashtag results must be differentiated from account results
- FR-4: Build process must be self-contained (no manual steps)
- FR-5: Skill file must define safe scroll regions

## Non-Goals

- No changes to LLM model selection
- No changes to preamble flow (already working)
- No changes to like/follow mechanics (already working when on correct screen)

## Technical Considerations

- Scroll region: y=0.20 to y=0.80 is safe zone on most devices
- Instagram search results: hashtags have "#" prefix, accounts have profile pictures
- Keyboard dismiss: Android BACK key works reliably
- Template copy: Use postbuild npm script or modify tsc output

## Success Metrics

- 80%+ success rate on hashtag engagement tasks
- Zero "search query changed" errors
- Zero manual template copy steps needed
