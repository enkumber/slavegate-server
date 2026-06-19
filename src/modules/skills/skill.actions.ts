/**
 * skills/skill.actions.ts
 * Server-side skill action executor.
 *
 * When workflow.executor encounters a step whose action name is in SKILL_ACTION_NAMES,
 * it routes execution here instead of dispatching to the device.
 *
 * These actions implement:
 *   - Control flow: run_loop, for_each
 *   - Conditional navigation: conditional_navigate_to_profile
 *   - State checks: check_mutual, evaluate_criteria
 *   - UI tree extraction: extract_profile_data_for_eval
 *   - State management: checkpoint_save, track_empty_scroll, increment, etc.
 *
 * Generic by design — platform-specific behavior is driven by params, not
 * hardcoded here. All Instagram-specific field patterns are in the params
 * that come from the skill YAML.
 *
 * References:
 *   smart_unfollow.skill — consumer of these actions
 *   HYDRA-CORE.md        — REGULA 7 (checkpoints), REGULA 6 (ui_tree preferred)
 */

import type { WorkflowCheckpoint, WorkflowStep } from '../workflows/types';
import type { JobStepResult } from '../workflows/workflow.executor';

// ─── Recognised action names ──────────────────────────────────────────────────

export const SKILL_ACTION_NAMES = new Set<string>([
  // Core actions (task spec)
  'run_loop',
  'for_each',
  'conditional_navigate_to_profile',
  'check_mutual',
  'extract_profile_data_for_eval',
  'parse_following_list',
  'vlm_extract_following_list',
  'ensure_on_screen',
  'hydra_cascade_tap',
  'semantic_tap',
  'evaluate_criteria',
  'checkpoint_save',
  'track_empty_scroll',
  // Outreach actions (Instagram engagement)
  'vlm_analyze_post_for_outreach',
  'vlm_generate_comment',
  'detect_current_screen',
  'classify_reddit_health_scan',
  // Utility state-management actions (used by smart_unfollow handlers)
  'random_delay',
  'increment',
  'decrement',
  'reset_counter',
  'append_to_list',
  'mark_processed',
  'set_variable',
  'branch_on_decision',
  'conditional_pause',
  'forced_pause',
]);

export function isSkillAction(actionName: string): boolean {
  return SKILL_ACTION_NAMES.has(actionName);
}

// ─── Context (injected by workflow.executor) ──────────────────────────────────

export interface SkillActionContext {
  workflowId:  string;
  deviceId:    string;
  platform:    string;
  checkpoint:  WorkflowCheckpoint;
  stepIndex:   number;

  /**
   * Dispatch a device job (ui_tree_dump, a11y_find_tap, etc.) and await JOB_RESULT.
   * Implemented in workflow.executor via dispatcherService + wsServer + awaitJobResult.
   */
  dispatchAndWait(
    type: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<JobStepResult>;

  /**
   * Cascade tap a named element from the platform's skill file.
   * Returns true on success.
   */
  cascadeTap(elementName: string, verify?: string): Promise<boolean>;

  /**
   * Execute a nested array of WorkflowSteps (for run_loop body, for_each handler).
   * Marked as isNested=true — no top-level checkpointing, lock extension handled upstream.
   */
  executeSteps(steps: WorkflowStep[]): Promise<void>;

  /**
   * Persist checkpoint to DB (HYDRA-CORE REGULA 7).
   */
  persistCheckpoint(phase?: string): Promise<void>;

  /** Sleep for ms milliseconds. */
  sleep(ms: number): Promise<void>;
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export async function executeSkillAction(
  actionName: string,
  params:     Record<string, unknown>,
  ctx:        SkillActionContext,
): Promise<void> {
  switch (actionName) {
    // Core
    case 'run_loop':                        return handleRunLoop(params, ctx);
    case 'for_each':                        return handleForEach(params, ctx);
    case 'conditional_navigate_to_profile': return handleConditionalNavigate(params, ctx);
    case 'check_mutual':                    return handleCheckMutual(params, ctx);
    case 'extract_profile_data_for_eval':   return handleExtractProfileData(params, ctx);
    case 'parse_following_list':            return handleParseFollowingList(params, ctx);
    case 'vlm_extract_following_list':      return handleVlmExtractFollowingList(params, ctx);
    case 'ensure_on_screen':               return handleEnsureOnScreen(params, ctx);
    case 'hydra_cascade_tap':              return handleHydraCascadeTap(params, ctx);
    case 'semantic_tap':                   return handleSemanticTap(params, ctx);
    case 'evaluate_criteria':               return handleEvaluateCriteria(params, ctx);
    case 'checkpoint_save':                 return handleCheckpointSave(params, ctx);
    case 'track_empty_scroll':              return handleTrackEmptyScroll(params, ctx);
    // Utility
    case 'random_delay':                    return handleRandomDelay(params, ctx);
    case 'increment':                       return handleIncrement(params, ctx);
    case 'decrement':                       return handleDecrement(params, ctx);
    case 'reset_counter':                   return handleResetCounter(params, ctx);
    case 'append_to_list':                  return handleAppendToList(params, ctx);
    case 'mark_processed':                  return handleMarkProcessed(params, ctx);
    case 'set_variable':                    return handleSetVariable(params, ctx);
    case 'branch_on_decision':              return handleBranchOnDecision(params, ctx);
    case 'conditional_pause':               return handleConditionalPause(params, ctx);
    case 'forced_pause':                    return handleForcedPause(params, ctx);
    // Outreach actions
    case 'vlm_analyze_post_for_outreach':   return handleVlmAnalyzePostForOutreach(params, ctx);
    case 'vlm_generate_comment':            return handleVlmGenerateComment(params, ctx);
    case 'detect_current_screen':           return handleDetectCurrentScreen(params, ctx);
    case 'classify_reddit_health_scan':     return handleClassifyRedditHealthScan(ctx);

    default:
      throw new Error(`[skill-actions] Unknown skill action: "${actionName}"`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RUN_LOOP — while-loop with configurable exit conditions and body steps
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Params:
 *   steps:          WorkflowStep[]  — body steps executed each iteration (inlined by skill instantiation)
 *   exitConditions: string[]        — stop when any evaluates to true (see evalConditionExpr)
 *   maxIterations:  number          — safety ceiling (default 10 000)
 */
async function handleRunLoop(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const exitConditions = (params.exitConditions as string[]) || [];
  const body           = (params.steps as WorkflowStep[]) || [];
  const maxIterations  = (params.maxIterations as number) || 10_000;

  info(ctx, `run_loop: starting (maxIter=${maxIterations}, exits=${exitConditions.length})`);

  for (let iter = 0; iter < maxIterations; iter++) {
    // ── Check exit conditions before each iteration ──────────────────────────
    for (const cond of exitConditions) {
      if (evalConditionExpr(cond, ctx.checkpoint.variables)) {
        info(ctx, `run_loop: exit "${cond}" at iteration ${iter}`);
        return;
      }
    }

    // ── Execute loop body ────────────────────────────────────────────────────
    await ctx.executeSteps(body);

    // Track iteration count for diagnostics / resume
    ctx.checkpoint.variables['_loop_iteration'] = iter + 1;
  }

  // Safety ceiling reached — not a hard error, log and surface via stopped_reason
  info(ctx, `run_loop: safety ceiling ${maxIterations} reached`);
  ctx.checkpoint.variables['stopped_reason'] = 'max_iterations';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. FOR_EACH — iterate an array in checkpoint.variables with dedup
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Params:
 *   source:     string         — checkpoint.variables key that holds the array to iterate
 *   skip_if_in: string         — checkpoint.variables key that holds already-processed items
 *   steps:      WorkflowStep[] — handler steps executed per item (inlined by instantiation)
 *
 * Sets checkpoint.variables._current_item for nested steps to read.
 * Resume-safe: skip_if_in is persisted across restarts.
 */
async function handleForEach(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const sourceKey  = params.source    as string;
  const skipKey    = params.skip_if_in as string | undefined;
  const steps      = (params.steps as WorkflowStep[]) || [];

  const items = (ctx.checkpoint.variables[sourceKey] as unknown[]) || [];
  if (items.length === 0) {
    info(ctx, `for_each: source "${sourceKey}" empty — no-op`);
    return;
  }

  // Build processed set for resume-safe dedup
  const processedArr = skipKey
    ? (ctx.checkpoint.variables[skipKey] as string[] | undefined) || []
    : [];
  const processed = new Set<string>(processedArr);

  info(ctx, `for_each: ${items.length} items, ${processed.size} already processed`);

  for (const item of items) {
    const key = itemToKey(item);
    if (processed.has(key)) continue;

    ctx.checkpoint.variables['_current_item'] = item;

    await ctx.executeSteps(steps);

    processed.add(key);
    if (skipKey) {
      ctx.checkpoint.variables[skipKey] = Array.from(processed);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CONDITIONAL_NAVIGATE_TO_PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Params:
 *   conditions:    string[]        — any one true → navigate (empty = always navigate)
 *   tapText:       string          — dynamic text to cascade-tap (ui_tree literal match)
 *   tapElement:    string          — named element from platform skill (preferred if set)
 *   verify:        string          — expected screen after tap
 *   browseSeconds: [number,number] — [min,max] human-like browse time on the profile
 */
async function handleConditionalNavigate(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const conditions  = (params.conditions   as string[]) || [];
  const tapElement  = params.tapElement    as string | undefined;
  const verify      = params.verify        as string | undefined;
  const browseRange = params.browseSeconds as [number, number] | undefined;

  // tapText: literal string OR resolved from a variable path (tapTextFromVar)
  let tapText = params.tapText as string | undefined;
  if (!tapText && params.tapTextFromVar) {
    const resolved = resolveVar(params.tapTextFromVar as string, ctx.checkpoint.variables);
    if (resolved) tapText = String(resolved);
  }

  // Evaluate gate — empty conditions = always proceed
  const shouldNavigate =
    conditions.length === 0 ||
    conditions.some(c => evalConditionExpr(c, ctx.checkpoint.variables));

  if (!shouldNavigate) {
    info(ctx, 'conditional_navigate: conditions not met — skipping');
    ctx.checkpoint.variables['_navigated_to_profile'] = false;
    return;
  }

  info(ctx, `conditional_navigate: tapping "${tapText ?? tapElement}"`);

  let success = false;

  if (tapElement) {
    // Named element — full cascade (learned coords → ui_tree → OCR → VLM)
    success = await ctx.cascadeTap(tapElement, verify);
  } else if (tapText) {
    // Dynamic text — full cascade via internal HTTP call (a11y → OCR → VLM)
    try {
      const response = await fetch(`http://localhost:18791/api/hydra/cascade-tap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY || '928b9e0ba7caeb3e039dafde99076d2d' },
        body: JSON.stringify({ deviceId: ctx.deviceId, text: tapText }),
      });
      const result = await response.json() as { ok: boolean; success?: boolean };
      success = result.ok && result.success === true;
    } catch (err) {
      info(ctx, `conditional_navigate: cascade-tap error: ${err}`);
      success = false;
    }
  }

  ctx.checkpoint.variables['_navigated_to_profile'] = success;

  if (!success) {
    info(ctx, `conditional_navigate: tap failed for "${tapText ?? tapElement}"`);
    return;
  }

  // Human-like browse time before acting on the profile
  if (browseRange && browseRange.length >= 2) {
    const ms = randomBetween(browseRange[0] * 1_000, browseRange[1] * 1_000);
    info(ctx, `conditional_navigate: browsing for ${(ms / 1_000).toFixed(1)}s`);
    await ctx.sleep(ms);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CHECK_MUTUAL — fast-path mutual follow check without navigating to profile
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reads follows_you from current item or explicit param.
 * Sets _skip_current_user = true if protected by never_unfollow_if.
 *
 * Params:
 *   username:          string   — for logging (falls back to _current_item.username)
 *   follows_you:       boolean  — from UI tree row data (falls back to _current_item_follows_you)
 *   protected_by:      string   — criterion name, e.g. "follows_back"
 *   never_unfollow_if: string[] — list of active protection criteria
 */
async function handleCheckMutual(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const item = ctx.checkpoint.variables['_current_item'] as { username?: string; follows_you?: boolean } | null;

  const username       = (params.username as string)
    ?? item?.username
    ?? '(unknown)';
  const followsYou     = (params.follows_you as boolean)
    ?? item?.follows_you
    ?? (ctx.checkpoint.variables['_current_item_follows_you'] as boolean)
    ?? false;
  const protectedBy    = (params.protected_by as string)   || 'follows_back';
  const neverUnfollowIf = (params.never_unfollow_if as string[]) || [];

  const isProtected = followsYou && neverUnfollowIf.includes(protectedBy);

  ctx.checkpoint.variables['_mutual_check'] = { username, follows_you: followsYou, is_protected: isProtected };

  if (isProtected) {
    ctx.checkpoint.variables['_skip_current_user'] = true;
    ctx.checkpoint.variables['_skip_reason']        = 'mutual';
    info(ctx, `check_mutual: @${username} follows you — protected by "${protectedBy}"`);
  } else {
    ctx.checkpoint.variables['_skip_current_user'] = false;
    info(ctx, `check_mutual: @${username} not following back — evaluate further`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. EXTRACT_PROFILE_DATA_FOR_EVAL — dump UI tree, parse profile stats
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dispatches ui_tree_dump, parses result into a ProfileEvalData record
 * and stores it in checkpoint.variables._profile_data.
 *
 * Parsed fields (Instagram layout — adapt via params.fieldHints for other platforms):
 *   following_count:   TextView matching /[\d,.KMB]+ Following/i
 *   posts_count:       TextView matching /[\d,.KMB]+ Posts?/i
 *   bio_text:          resourceId "profile_header_bio_text"
 *   last_post_age_days: contentDescription on first grid item ("X days/weeks/months ago")
 */
async function handleExtractProfileData(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  info(ctx, 'extract_profile_data_for_eval: ui_tree_dump');

  const result = await ctx.dispatchAndWait('ui_tree_dump', {}, 15_000);

  if (result.status !== 'ok' && result.status !== 'success') {
    warn(ctx, `extract_profile_data_for_eval: ui_tree_dump failed (${result.status})`);
    ctx.checkpoint.variables['_profile_data'] = null;
    return;
  }

  const rawTree = (result.output as Record<string, unknown> | undefined)?.['uiTree'];
  if (!rawTree) {
    warn(ctx, 'extract_profile_data_for_eval: no uiTree in result');
    ctx.checkpoint.variables['_profile_data'] = null;
    return;
  }

  const tree: UiNode = typeof rawTree === 'string' ? JSON.parse(rawTree) : (rawTree as UiNode);

  const data: ProfileEvalData = {
    followingCount:  extractFollowingCount(tree),
    postsCount:      extractPostsCount(tree),
    bioText:         extractBioText(tree),
    lastPostAgeDays: extractLastPostAgeDays(tree),
  };

  info(ctx,
    `extract_profile_data_for_eval: ` +
    `following=${data.followingCount}, posts=${data.postsCount}, ` +
    `lastPost=${data.lastPostAgeDays ?? 'null'}d, ` +
    `bio="${(data.bioText ?? '').slice(0, 40)}"`
  );

  ctx.checkpoint.variables['_profile_data'] = data;
}

// ─── UI tree types ────────────────────────────────────────────────────────────

interface UiNode {
  text?:               string;
  desc?:               string;
  contentDescription?: string;
  resourceId?:         string;
  resId?:              string;
  children?:           UiNode[];
  [key: string]:       unknown;
}

interface ProfileEvalData {
  followingCount:  number;
  postsCount:      number;
  bioText:         string | null;
  lastPostAgeDays: number | null;  // null = account has 0 posts
}

// ─── UI tree traversal ────────────────────────────────────────────────────────

function traverseUiTree(node: UiNode, visitor: (n: UiNode) => void): void {
  visitor(node);
  for (const child of (node.children || [])) traverseUiTree(child, visitor);
}

function findNodeByResourceId(root: UiNode, partialId: string): UiNode | null {
  let found: UiNode | null = null;
  traverseUiTree(root, (n) => {
    if (found) return;
    const rid = n.resourceId || n.resId || '';
    if (rid.includes(partialId)) found = n;
  });
  return found;
}

function collectTextByPattern(root: UiNode, pattern: RegExp): string[] {
  const results: string[] = [];
  traverseUiTree(root, (n) => {
    if (n.text && pattern.test(n.text)) results.push(n.text);
  });
  return results;
}

// ─── Count parsing ────────────────────────────────────────────────────────────

/**
 * "1.2K Following" → 1200   |   "3.5M Following" → 3_500_000
 * Works for Following, Followers, Posts counts.
 */
function parseCountPrefix(raw: string): number {
  const clean = raw.replace(/,/g, '').trim();
  const m = clean.match(/^([\d.]+)([KMB]?)\s/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2].toUpperCase()) {
    case 'K': return Math.round(n * 1_000);
    case 'M': return Math.round(n * 1_000_000);
    case 'B': return Math.round(n * 1_000_000_000);
    default:  return Math.round(n);
  }
}

/**
 * "3 days ago"   → 3
 * "2 weeks ago"  → 14
 * "1 month ago"  → 30
 * "1 year ago"   → 365
 * "5 hours ago"  → 0   (same day)
 * Returns null if no match.
 */
function parseRelativeTimeToDays(text: string): number | null {
  const patterns: Array<[RegExp, number]> = [
    [/(\d+)\s*min(?:ute)?s?\s+ago/i,   0],
    [/(\d+)\s*h(?:our)?s?\s+ago/i,     0],
    [/(\d+)\s*d(?:ay)?s?\s+ago/i,      1],
    [/(\d+)\s*w(?:eek)?s?\s+ago/i,     7],
    [/(\d+)\s*mo(?:nth)?s?\s+ago/i,   30],
    [/(\d+)\s*y(?:ear)?s?\s+ago/i,   365],
  ];
  for (const [re, multiplier] of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1], 10) * multiplier;
  }
  return null;
}

// ─── Field extractors ─────────────────────────────────────────────────────────

function extractFollowingCount(tree: UiNode): number {
  const texts = collectTextByPattern(tree, /^[\d,.]+[KMBkmb]?\s+Following$/i);
  return texts.length > 0 ? parseCountPrefix(texts[0]) : 0;
}

function extractPostsCount(tree: UiNode): number {
  const texts = collectTextByPattern(tree, /^[\d,.]+[KMBkmb]?\s+Posts?$/i);
  return texts.length > 0 ? parseCountPrefix(texts[0]) : 0;
}

function extractBioText(tree: UiNode): string | null {
  const node = findNodeByResourceId(tree, 'profile_header_bio_text');
  return node?.text ?? null;
}

function extractLastPostAgeDays(tree: UiNode): number | null {
  // Grid items have contentDescription like "Photo by X, 3 days ago".
  // We want the MOST RECENT post (smallest days value).
  let mostRecent: number | null = null;
  traverseUiTree(tree, (n) => {
    const desc = n.desc ?? n.contentDescription ?? '';
    if (!desc) return;
    const days = parseRelativeTimeToDays(desc);
    if (days === null) return;
    if (mostRecent === null || days < mostRecent) mostRecent = days;
  });
  return mostRecent;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5b. PARSE_FOLLOWING_LIST — parse UI tree dump into following_list_rows array
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dispatches ui_tree_dump (or reads last dump from variables), parses the
 * following list screen into structured row objects, and stores them in
 * checkpoint.variables.following_list_rows.
 *
 * Each row: { username: string, follows_you: boolean }
 *
 * Strategy:
 * 1. Find all clickable nodes with a text child that looks like a username
 *    (no spaces, reasonable length 1-30 chars, not action words)
 * 2. Check sibling/child text for "Follows you" / "Urmărește" → follows_you
 *
 * Falls back gracefully: if UI tree is Compose (no a11y nodes), rows = []
 * and track_empty_scroll will eventually trigger list_exhausted.
 *
 * Params:
 *   target_variable: string — where to store rows (default: "following_list_rows")
 *   dump_fresh:      boolean — dispatch a fresh ui_tree_dump (default: true)
 */
async function handleParseFollowingList(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const targetVar = (params.target_variable as string) || 'following_list_rows';
  const dumpFresh = params.dump_fresh !== false;

  let tree: UiNode | null = null;

  if (dumpFresh) {
    info(ctx, 'parse_following_list: dispatching ui_tree_dump');
    const result = await ctx.dispatchAndWait('ui_tree_dump', {}, 15_000);
    if (result.status !== 'ok' && result.status !== 'success') {
      warn(ctx, `parse_following_list: ui_tree_dump failed (${result.status})`);
      ctx.checkpoint.variables[targetVar] = [];
      return;
    }
    const raw = (result.output as Record<string, unknown> | undefined)?.['uiTree'];
    if (!raw) {
      warn(ctx, 'parse_following_list: no uiTree in result');
      ctx.checkpoint.variables[targetVar] = [];
      return;
    }
    tree = typeof raw === 'string' ? JSON.parse(raw) : (raw as UiNode);
  } else {
    // Re-use previously stored tree if caller already did ui_tree_dump
    const cached = ctx.checkpoint.variables['_last_ui_tree'];
    if (!cached) {
      warn(ctx, 'parse_following_list: no cached ui tree and dump_fresh=false');
      ctx.checkpoint.variables[targetVar] = [];
      return;
    }
    tree = cached as UiNode;
  }

  const rows = tree ? parseFollowingRows(tree) : [];
  ctx.checkpoint.variables[targetVar] = rows;
  info(ctx, `parse_following_list: found ${rows.length} rows`);
}

// ─── Following list row type ──────────────────────────────────────────────────

interface FollowingRow {
  username:    string;
  follows_you: boolean;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const SKIP_TEXTS = new Set([
  'following', 'followers', 'follow', 'message', 'remove', 'requested',
  'following back', 'follows you', 'urmărește', 'urmăritori', 'urmărești',
  'search', 'cancel', 'done', 'select all',
]);

const FOLLOWS_YOU_TEXTS = ['follows you', 'urmărește', 'urmăreste'];

function looksLikeUsername(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  // Usernames: 1-30 chars, no spaces, not a skip word, not purely numeric
  if (t.length < 1 || t.length > 30) return false;
  if (t.includes(' ') && t.split(' ').length > 2) return false; // allow "First Last" display names
  if (SKIP_TEXTS.has(t.toLowerCase())) return false;
  if (/^\d+$/.test(t)) return false; // purely numeric = count, not username
  return true;
}

function collectTextsFromNode(node: UiNode): string[] {
  const texts: string[] = [];
  traverseUiTree(node, (n) => {
    if (n.text) texts.push(n.text);
    if (n.desc) texts.push(n.desc);
    if (n.contentDescription) texts.push(n.contentDescription);
  });
  return texts;
}

function parseFollowingRows(root: UiNode): FollowingRow[] {
  const rows: FollowingRow[] = [];
  const seen = new Set<string>();

  // Strategy: find list item containers.
  // Each row in the following list is typically a clickable node containing:
  //   - A username TextView (primary text)
  //   - Optionally "Follows you" / "Urmărește" sub-text
  //   - A "Following" button on the right
  //
  // We walk the tree and identify candidate row containers:
  //   A container that has at least one username-like text AND a "Following" button text.

  function isFollowingButton(text: string): boolean {
    const t = text.toLowerCase().trim();
    return t === 'following' || t === 'urmărești';
  }

  function processNode(node: UiNode): void {
    const texts = collectTextsFromNode(node);
    const hasFollowingButton = texts.some(t => isFollowingButton(t));
    if (!hasFollowingButton) {
      // Recurse into children to find rows
      for (const child of (node.children || [])) processNode(child);
      return;
    }

    // This node looks like a following list row — extract username
    // Username is the first non-skip, non-following-button text
    let username: string | null = null;
    let followsYou = false;

    for (const t of texts) {
      const lower = t.toLowerCase().trim();
      if (isFollowingButton(lower)) continue;
      if (FOLLOWS_YOU_TEXTS.some(f => lower.includes(f))) {
        followsYou = true;
        continue;
      }
      if (!username && looksLikeUsername(t)) {
        username = t.trim();
      }
    }

    if (username && !seen.has(username)) {
      seen.add(username);
      rows.push({ username, follows_you: followsYou });
    }

    // Still recurse — nested rows possible in some layouts
    for (const child of (node.children || [])) processNode(child);
  }

  processNode(root);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5c. VLM_EXTRACT_FOLLOWING_LIST — VLM screenshot analysis for Compose screens
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * For Instagram Jetpack Compose screens where ui_tree_dump returns no usable nodes,
 * takes a screenshot and asks VLM to extract the visible following list rows.
 *
 * Makes a POST to /api/hydra/analyze-screen (internal HTTP — same server).
 * The VLM returns JSON: Array<{ username: string, follows_you: boolean }>
 *
 * Params:
 *   target_variable: string — checkpoint key to store rows (default: "following_list_rows")
 *   server_port:     number — server port for internal call (default: read from env)
 *   server_token:    string — API key (default: read from env)
 */
async function handleVlmExtractFollowingList(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const targetVar = (params.target_variable as string) || 'following_list_rows';

  // Read server connection details from env (same process → localhost)
  const port  = (params.server_port as number)  || parseInt(process.env['PORT'] ?? '21211', 10);
  const token = (params.server_token as string) || process.env['API_KEY'] || '';

  const task =
    'Această imagine arată lista Following (Urmăresc) din Instagram. ' +
    'Extrage toți utilizatorii vizibili în listă. ' +
    'Pentru fiecare user, notează dacă sub username apare textul "Follows you" sau "Urmărește". ' +
    'Răspunde STRICT un singur obiect JSON: {"users": [{"username": "string", "follows_you": bool}, ...]} ' +
    'Dacă nu există utilizatori vizibili, returnează {"users": []}. ' +
    'NU include nimic în afara JSON-ului.';

  info(ctx, 'vlm_extract_following_list: calling analyze-screen');

  let rows: FollowingRow[] = [];
  try {
    const body = JSON.stringify({ deviceId: ctx.deviceId, task });
    const response = await httpPost(`http://localhost:${port}/api/hydra/analyze-screen`, body, token);

    if (!response.ok) {
      warn(ctx, `vlm_extract_following_list: analyze-screen error: ${JSON.stringify(response.data).slice(0, 200)}`);
      ctx.checkpoint.variables[targetVar] = [];
      return;
    }

    // Response: { ok: true, analysis: <parsed JSON from VLM> }
    const analysis = response.data?.analysis;
    // Normalize: VLM may return {users:[...]}, [...] directly, or {raw: "..."} on parse fail
    let rawList: unknown[] | null = null;
    if (Array.isArray(analysis)) {
      rawList = analysis;
    } else if (analysis && typeof analysis === 'object') {
      const obj = analysis as Record<string, unknown>;
      if (Array.isArray(obj['users'])) {
        rawList = obj['users'] as unknown[];
      } else if (typeof obj['raw'] === 'string') {
        // analyze-screen couldn't parse JSON from VLM — try ourselves
        const raw = obj['raw'] as string;
        // Try array pattern first: [...]
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          try { rawList = JSON.parse(arrMatch[0]) as unknown[]; } catch { /* ignore */ }
        }
        // Try object with users key: {"users":[...]}
        if (!rawList) {
          const objMatch = raw.match(/\{[\s\S]*\}/);
          if (objMatch) {
            try {
              const parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
              if (Array.isArray(parsed['users'])) rawList = parsed['users'] as unknown[];
            } catch { /* ignore */ }
          }
        }
        if (!rawList) {
          warn(ctx, `vlm_extract_following_list: could not parse raw VLM response: ${raw.slice(0, 200)}`);
        }
      }
    }

    if (rawList) {
      rows = rawList
        .filter((r: unknown) => r && typeof r === 'object' && typeof (r as Record<string,unknown>)['username'] === 'string')
        .map((r: unknown) => {
          const item = r as Record<string, unknown>;
          return {
            username:    String(item['username']).trim(),
            follows_you: Boolean(item['follows_you']),
          };
        })
        .filter((r: FollowingRow) => r.username.length > 0);
    } else if (!Array.isArray(analysis)) {
      warn(ctx, `vlm_extract_following_list: could not extract rows from analysis: ${JSON.stringify(analysis).slice(0, 200)}`);
    }
  } catch (err) {
    warn(ctx, `vlm_extract_following_list: request failed: ${(err as Error).message}`);
  }

  // Increment VLM counter for monitoring (HYDRA-CORE REGULA 9)
  const prev = (ctx.checkpoint.variables['vlm_calls_this_hour'] as number) ?? 0;
  ctx.checkpoint.variables['vlm_calls_this_hour'] = prev + 1;

  ctx.checkpoint.variables[targetVar] = rows;
  info(ctx, `vlm_extract_following_list: extracted ${rows.length} rows (vlm_calls=${prev + 1})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5d. ENSURE_ON_SCREEN — VLM screen check + conditional re-navigation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calls analyze-screen to check current screen. If not on expected screen,
 * executes recovery_steps (WorkflowStep[]) to re-navigate.
 *
 * Params:
 *   expected_screen:  string         — what screen we expect (e.g. "following_list")
 *   check_task:       string         — VLM prompt to identify current screen
 *   recovery_steps:   WorkflowStep[] — steps to run if not on expected screen
 *   server_port:      number         — optional port override
 *   server_token:     string         — optional API key override
 */
async function handleEnsureOnScreen(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const expectedScreen = params.expected_screen as string;
  const checkTask      = (params.check_task as string) ||
    `Suntem pe ecranul "${expectedScreen}" acum? Răspunde JSON: {"on_screen": bool, "current_screen": string}`;
  const recoverySteps  = (params.recovery_steps as WorkflowStep[]) || [];

  const port  = (params.server_port as number)  || parseInt(process.env['PORT'] ?? '21211', 10);
  const token = (params.server_token as string) || process.env['API_KEY'] || '';

  info(ctx, `ensure_on_screen: checking if on "${expectedScreen}"`);

  let onScreen = false;
  try {
    const body = JSON.stringify({ deviceId: ctx.deviceId, task: checkTask });
    const response = await httpPost(`http://localhost:${port}/api/hydra/analyze-screen`, body, token);

    if (response.ok) {
      const analysis = response.data?.analysis as Record<string, unknown> | undefined;
      // Handle {on_screen: bool} directly or {raw: "..."} fallback
      if (analysis && typeof analysis['on_screen'] === 'boolean') {
        onScreen = analysis['on_screen'] as boolean;
        info(ctx, `ensure_on_screen: VLM says on_screen=${onScreen}, current="${analysis['current_screen']}"`);
      } else if (analysis && typeof analysis['raw'] === 'string') {
        // Try to extract from raw
        const m = (analysis['raw'] as string).match(/"on_screen"\s*:\s*(true|false)/i);
        onScreen = m ? m[1].toLowerCase() === 'true' : false;
        info(ctx, `ensure_on_screen: raw parse on_screen=${onScreen}`);
      }
    } else {
      warn(ctx, `ensure_on_screen: analyze-screen failed: ${JSON.stringify(response.data).slice(0, 100)}`);
    }
  } catch (err) {
    warn(ctx, `ensure_on_screen: request error: ${(err as Error).message}`);
  }

  // Increment VLM counter
  const prev = (ctx.checkpoint.variables['vlm_calls_this_hour'] as number) ?? 0;
  ctx.checkpoint.variables['vlm_calls_this_hour'] = prev + 1;

  if (!onScreen && recoverySteps.length > 0) {
    info(ctx, `ensure_on_screen: NOT on "${expectedScreen}" — running ${recoverySteps.length} recovery steps`);
    await ctx.executeSteps(recoverySteps);
  } else if (onScreen) {
    info(ctx, `ensure_on_screen: confirmed on "${expectedScreen}" ✓`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HYDRA_CASCADE_TAP — calls /api/hydra/cascade-tap internally (proven to work)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calls /api/hydra/cascade-tap with the same params that work via manual API call.
 * This bypasses the a11y_find_tap device dispatch which has a selector→text mismatch.
 *
 * Params (mirrors cascade-tap API):
 *   text:        string  — literal text search (e.g. "following")
 *   target:      string  — "@element.name" skill ref or literal text
 *   platform:    string  — platform for skill ref (default: ctx.platform)
 *   verify:      string  — expected screen after tap
 *   wait_ms:     number  — wait after tap (ms)
 *   retries:     number  — retry count on failure
 */
async function handleHydraCascadeTap(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const port    = parseInt(process.env['PORT'] ?? '21211', 10);
  const token   = process.env['API_KEY'] || '';
  const retries = (params.retries as number) ?? 2;
  const waitMs  = (params.wait_ms as number) ?? 1500;

  // Build cascade-tap body — mirrors what manual API calls send
  const tapBody: Record<string, unknown> = {
    deviceId: ctx.deviceId,
    platform: (params.platform as string) ?? ctx.platform,
  };

  if (params.target)  tapBody['target']  = params.target;
  if (params.text)    tapBody['target']  = params.text;   // literal text → target
  if (params.verify)  tapBody['verify']  = params.verify;
  if (params.learn !== undefined) tapBody['learn'] = params.learn;

  info(ctx, `hydra_cascade_tap: target="${tapBody['target']}" verify="${params.verify ?? 'none'}"`);

  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify(tapBody);
      const response = await httpPost(`http://localhost:${port}/api/hydra/cascade-tap`, body, token);

      if (response.ok && response.data?.success) {
        info(ctx, `hydra_cascade_tap: success via ${response.data.method_used} (attempt ${attempt + 1})`);
        if (waitMs > 0) await ctx.sleep(waitMs);
        return;
      }

      lastError = String(response.data?.error ?? response.data?.verifyError ?? 'tap failed');
      warn(ctx, `hydra_cascade_tap: attempt ${attempt + 1} failed: ${lastError}`);

      if (attempt < retries) await ctx.sleep(1500);
    } catch (err) {
      lastError = (err as Error).message;
      warn(ctx, `hydra_cascade_tap: attempt ${attempt + 1} error: ${lastError}`);
      if (attempt < retries) await ctx.sleep(1500);
    }
  }

  // All retries exhausted — log but don't throw (workflow continues)
  warn(ctx, `hydra_cascade_tap: all ${retries + 1} attempts failed: ${lastError}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEMANTIC_TAP — resolve a product intent from live UI tree, then tap coordinates
// ═══════════════════════════════════════════════════════════════════════════════

interface UiNode {
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  visible?: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
  children?: UiNode[];
}

function parseUiTreeOutput(output: unknown): UiNode {
  const record = output as Record<string, unknown> | undefined;
  const rawTree = record?.uiTree ?? record?.tree ?? record?.root;
  if (typeof rawTree === 'string') return JSON.parse(rawTree) as UiNode;
  if (rawTree && typeof rawTree === 'object') return rawTree as UiNode;
  if (output && typeof output === 'object') return output as UiNode;
  throw new Error('ui_tree_dump returned no parseable ui tree');
}

function walkUiTree(node: UiNode, visit: (node: UiNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkUiTree(child, visit);
}

function nodeCenter(node: UiNode, root: UiNode): { x: number; y: number; bounds: NonNullable<UiNode['bounds']> } | null {
  if (!node.bounds || !root.bounds) return null;
  const width = root.bounds.right - root.bounds.left;
  const height = root.bounds.bottom - root.bounds.top;
  if (width <= 0 || height <= 0) return null;
  return {
    x: ((node.bounds.left + node.bounds.right) / 2 - root.bounds.left) / width,
    y: ((node.bounds.top + node.bounds.bottom) / 2 - root.bounds.top) / height,
    bounds: node.bounds,
  };
}

function resolveRedditFirstVisiblePostComments(root: UiNode): { x: number; y: number; bounds: NonNullable<UiNode['bounds']>; matchedText: string } | null {
  const candidates: Array<{ node: UiNode; score: number; top: number; matchedText: string }> = [];

  walkUiTree(root, (node) => {
    if (node.visible === false || !node.bounds) return;
    const cd = node.contentDescription?.trim() ?? '';
    const text = node.text?.trim() ?? '';
    const rid = node.resourceId?.trim() ?? '';
    const haystack = `${cd} ${text} ${rid}`;
    const hasCommentSignal = /\b\d+\s+comments?\b/i.test(haystack) || /\bcomments?\b/i.test(haystack);
    if (!hasCommentSignal) return;

    const isPostContainer = /^From\s+/i.test(cd) || /post_unit|promoted_post_unit|post_footer/i.test(rid);
    const isCommentDetail = /comment_layout|comment_header|fbp_comment_footer|reply_text_view|search comments|sort comments/i.test(haystack);
    if (isCommentDetail) return;

    const bounds = node.bounds;
    if (bounds.bottom <= 0 || bounds.top < 0) return;
    const score =
      (isPostContainer ? 100 : 0) +
      (cd ? 20 : 0) +
      (rid.includes('post') ? 10 : 0) -
      bounds.top / 10;

    candidates.push({ node, score, top: bounds.top, matchedText: cd || text || rid });
  });

  candidates.sort((a, b) => b.score - a.score || a.top - b.top);
  for (const candidate of candidates) {
    const center = nodeCenter(candidate.node, root);
    if (center) return { ...center, matchedText: candidate.matchedText };
  }
  return null;
}

async function handleSemanticTap(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const target = params.target as string | undefined;
  if (!target) throw new Error('semantic_tap requires params.target');

  const waitMs = (params.waitMs as number) ?? 1500;
  info(ctx, `semantic_tap: resolving "${target}" from live ui_tree`);

  const dump = await ctx.dispatchAndWait('ui_tree_dump', {}, 15_000);
  if (dump.status === 'failed' || dump.status === 'timeout') {
    throw new Error(`semantic_tap ui_tree_dump failed: ${dump.error ?? dump.status}`);
  }

  const root = parseUiTreeOutput(dump.output);
  let resolved: { x: number; y: number; bounds: NonNullable<UiNode['bounds']>; matchedText: string } | null = null;

  switch (target) {
    case 'reddit.first_visible_post.open_comments':
      resolved = resolveRedditFirstVisiblePostComments(root);
      break;
    default:
      throw new Error(`semantic_tap unknown target: ${target}`);
  }

  if (!resolved) {
    throw new Error(`semantic_tap could not resolve target: ${target}`);
  }

  ctx.checkpoint.variables['_last_semantic_tap'] = {
    target,
    x: resolved.x,
    y: resolved.y,
    bounds: resolved.bounds,
    matchedText: resolved.matchedText,
    resolvedAt: new Date().toISOString(),
  };

  const tap = await ctx.dispatchAndWait('tap', { x: resolved.x, y: resolved.y }, 15_000);
  if (tap.status === 'failed' || tap.status === 'timeout') {
    throw new Error(`semantic_tap tap failed: ${tap.error ?? tap.status}`);
  }

  if (waitMs > 0) await ctx.sleep(waitMs);
}

// ─── Minimal HTTP POST helper (avoids axios/node-fetch dep) ──────────────────

interface HttpResponse {
  ok:   boolean;
  data: Record<string, unknown>;
}

function httpPost(url: string, body: string, apiKey: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require('http') as typeof import('http');
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port:     parseInt(parsed.port || '80', 10),
        path:     parsed.pathname,
        method:   'POST',
        timeout:  90_000,   // 90s socket timeout — analyze-screen: 30s screenshot + 60s VLM
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key':      apiKey,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            resolve({ ok: (res.statusCode ?? 500) < 400, data: parsed });
          } catch {
            resolve({ ok: false, data: { raw: data } });
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('httpPost socket timeout (90s)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. EVALUATE_CRITERIA — decide unfollow / skip based on extracted profile data
// ═══════════════════════════════════════════════════════════════════════════════

interface CriteriaConfig {
  unfollow_if:        string[];
  never_unfollow_if:  string[];
  protected_keywords: string[];
  niche_description:  string;
}

interface UnfollowDecision {
  action:               'unfollow' | 'skip';
  reason:               string;
  matched_unfollow_if:  string[];
  matched_never:        string[];
}

/**
 * Reads _profile_data and _mutual_check from checkpoint.variables.
 * Optionally reads _niche_relevant (set by a prior analyze-screen VLM call).
 * Writes _unfollow_decision = { action, reason, matched_* }.
 *
 * never_unfollow_if takes STRICT precedence over unfollow_if.
 *
 * Params:
 *   criteria: CriteriaConfig  — direct from skill input or workflow params
 */
async function handleEvaluateCriteria(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const criteria = (params.criteria as CriteriaConfig) || {
    unfollow_if: [], never_unfollow_if: [], protected_keywords: [], niche_description: '',
  };

  const profileData  = ctx.checkpoint.variables['_profile_data'] as ProfileEvalData | null;
  const mutualCheck  = ctx.checkpoint.variables['_mutual_check']  as { follows_you?: boolean } | null;
  const nicheRelevant = ctx.checkpoint.variables['_niche_relevant'] as boolean | null ?? null;
  const followsYou   = mutualCheck?.follows_you ?? false;

  if (!profileData) {
    warn(ctx, 'evaluate_criteria: no _profile_data — defaulting to skip');
    ctx.checkpoint.variables['_unfollow_decision'] = {
      action: 'skip', reason: 'no_profile_data', matched_unfollow_if: [], matched_never: [],
    } as UnfollowDecision;
    return;
  }

  const evalData = { ...profileData, followsYou, nicheRelevant };

  // ── Check never_unfollow_if first (strict precedence) ─────────────────────
  const matchedNever: string[] = [];
  for (const crit of criteria.never_unfollow_if) {
    if (matchesCriterion(crit, evalData, criteria)) matchedNever.push(crit);
  }

  if (matchedNever.length > 0) {
    const decision: UnfollowDecision = {
      action:              'skip',
      reason:              `protected:${matchedNever.join(',')}`,
      matched_unfollow_if: [],
      matched_never:       matchedNever,
    };
    info(ctx, `evaluate_criteria: SKIP — protected by [${matchedNever.join(', ')}]`);
    ctx.checkpoint.variables['_unfollow_decision'] = decision;
    return;
  }

  // ── Check unfollow_if ─────────────────────────────────────────────────────
  const matchedUnfollow: string[] = [];
  for (const crit of criteria.unfollow_if) {
    // Skip irrelevant_niche if niche evaluation wasn't performed (null)
    if (crit === 'irrelevant_niche' && nicheRelevant === null) continue;
    if (matchesCriterion(crit, evalData, criteria)) matchedUnfollow.push(crit);
  }

  const decision: UnfollowDecision = matchedUnfollow.length > 0
    ? {
        action:              'unfollow',
        reason:              matchedUnfollow[0],
        matched_unfollow_if: matchedUnfollow,
        matched_never:       [],
      }
    : {
        action:              'skip',
        reason:              'no_criteria_match',
        matched_unfollow_if: [],
        matched_never:       [],
      };

  info(ctx, `evaluate_criteria: ${decision.action.toUpperCase()} (${decision.reason})`);
  ctx.checkpoint.variables['_unfollow_decision'] = decision;
}

type EvalData = ProfileEvalData & { followsYou: boolean; nicheRelevant: boolean | null };

function matchesCriterion(criterion: string, data: EvalData, cfg: CriteriaConfig): boolean {
  switch (criterion) {
    case 'not_following_back':
      return !data.followsYou;

    case 'inactive_90_days':
      // null lastPostAgeDays means 0 posts — counts as inactive
      return data.lastPostAgeDays === null || data.lastPostAgeDays > 90;

    case 'following_3000_plus':
      return data.followingCount > 3_000;

    case 'irrelevant_niche':
      // Only reached when nicheRelevant !== null (guard in handleEvaluateCriteria)
      return data.nicheRelevant === false;

    case 'follows_back':
      return data.followsYou;

    case 'bio_contains_keywords': {
      if (!data.bioText || !cfg.protected_keywords.length) return false;
      const bioLower = data.bioText.toLowerCase();
      return cfg.protected_keywords.some(kw => kw && bioLower.includes(kw.toLowerCase()));
    }

    default:
      // Unknown criterion — conservative: don't match (avoid accidental unfollows)
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CHECKPOINT_SAVE — explicit checkpoint persistence (HYDRA-CORE REGULA 7)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Params:
 *   phase: string              — label stored in _checkpoint_phase
 *   state: Record<str,unknown> — merged into checkpoint.variables before save
 */
async function handleCheckpointSave(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const phase      = (params.phase as string) || 'skill_checkpoint';
  const extraState = (params.state as Record<string, unknown>) || {};

  // Merge extra state into variables
  Object.assign(ctx.checkpoint.variables, extraState);
  ctx.checkpoint.variables['_checkpoint_phase'] = phase;

  await ctx.persistCheckpoint(phase);
  info(ctx, `checkpoint_save: saved (phase="${phase}")`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. TRACK_EMPTY_SCROLL — detect list exhaustion after scroll
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * After each scroll, check if any new (unprocessed) items appeared.
 * Increments counter if none, resets to 0 if new items found.
 * run_loop checks "consecutive_empty_scrolls >= 3" as exit condition.
 *
 * Params:
 *   source:        string — checkpoint.variables key with current batch of items
 *   processed_set: string — checkpoint.variables key with already-processed item keys
 *   counter:       string — checkpoint.variables key for the counter (default: consecutive_empty_scrolls)
 */
async function handleTrackEmptyScroll(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const sourceKey    = params.source        as string;
  const processedKey = params.processed_set as string;
  const counterKey   = (params.counter as string) || 'consecutive_empty_scrolls';

  const batch     = (ctx.checkpoint.variables[sourceKey]    as unknown[]) || [];
  const processed = new Set<string>((ctx.checkpoint.variables[processedKey] as string[]) || []);

  const hasNew = batch.some(item => !processed.has(itemToKey(item)));

  if (hasNew) {
    ctx.checkpoint.variables[counterKey] = 0;
    info(ctx, `track_empty_scroll: new items found — reset "${counterKey}"`);
  } else {
    const prev = (ctx.checkpoint.variables[counterKey] as number) || 0;
    ctx.checkpoint.variables[counterKey] = prev + 1;
    info(ctx, `track_empty_scroll: no new items — "${counterKey}" = ${prev + 1}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRandomDelay(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const range = params.range_seconds as [number, number] | undefined;
  if (!range || range.length < 2) { await ctx.sleep(1_000); return; }
  const ms = randomBetween(range[0] * 1_000, range[1] * 1_000);
  info(ctx, `random_delay: ${(ms / 1_000).toFixed(1)}s`);
  await ctx.sleep(ms);
}

async function handleIncrement(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const key = params.counter as string;
  const by  = (params.by as number) ?? 1;
  ctx.checkpoint.variables[key] = ((ctx.checkpoint.variables[key] as number) ?? 0) + by;
}

async function handleDecrement(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const key = params.counter as string;
  const by  = (params.by as number) ?? 1;
  ctx.checkpoint.variables[key] = Math.max(0, ((ctx.checkpoint.variables[key] as number) ?? 0) - by);
}

async function handleResetCounter(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const key = params.counter as string;
  ctx.checkpoint.variables[key] = 0;
}

async function handleAppendToList(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const listKey = params.list as string;
  const value   = params.value;
  const arr     = (ctx.checkpoint.variables[listKey] as unknown[]) ?? [];
  arr.push(value);
  ctx.checkpoint.variables[listKey] = arr;
}

async function handleMarkProcessed(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const username = params.username as string;
  const setKey   = (params.set as string) || 'processed_usernames';
  const arr      = (ctx.checkpoint.variables[setKey] as string[]) ?? [];
  if (!arr.includes(username)) arr.push(username);
  ctx.checkpoint.variables[setKey] = arr;
}

async function handleSetVariable(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const variables = params.variables;
  if (variables && typeof variables === "object" && !Array.isArray(variables)) {
    for (const [key, value] of Object.entries(variables)) {
      ctx.checkpoint.variables[key] = value;
    }
    return;
  }

  const key   = params.key as string;
  if (!key) {
    throw new Error("[skill-actions] set_variable requires key/value or variables map");
  }
  const value = params.value;
  ctx.checkpoint.variables[key] = value;
}

function textIncludesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function extractUiTreeText(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const record = output as Record<string, unknown>;
  const raw = record.uiTree ?? record.tree ?? record.nodes ?? record;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

function classifyRedditHealthFromUiTree(uiTreeText: string): Record<string, string> {
  const lower = uiTreeText.toLowerCase();
  const isReddit = lower.includes("com.reddit.frontpage");
  const loginWall = textIncludesAny(lower, ["log in", "login", "sign up", "continue with google", "continue with apple"]);
  const challenge = textIncludesAny(lower, ["challenge", "captcha", "verify", "suspicious", "blocked", "try again later"]);
  const searchAvailable = textIncludesAny(lower, ["find anything", "search reddit", "search"]);
  const homeFeed = isReddit && textIncludesAny(lower, ["find anything", "home", "create", "inbox", "r/"]);
  const accountSwitcher = textIncludesAny(lower, ["switch account", "accounts", "add account"]);
  const usernameMatch = uiTreeText.match(/u\/([A-Za-z0-9_-]{3,30})/) ?? uiTreeText.match(/"text"\s*:\s*"([A-Za-z][A-Za-z0-9_-]{2,29})"/);

  return {
    loggedIn: isReddit && !loginWall ? "true" : loginWall ? "false" : "unknown",
    homeFeedVisible: homeFeed ? "true" : "false",
    searchSurfaceAvailable: searchAvailable ? "true" : "false",
    challengeDetected: challenge ? "true" : "false",
    loginWallDetected: loginWall ? "true" : "false",
    accountSwitcherVisible: accountSwitcher ? "true" : "false",
    observedUsername: usernameMatch?.[1] ?? "",
    screenState: isReddit ? (homeFeed ? "reddit_home_feed" : "reddit_unknown") : "not_reddit",
    error: "",
  };
}

async function handleClassifyRedditHealthScan(ctx: SkillActionContext): Promise<void> {
  const result = await ctx.dispatchAndWait("ui_tree_dump", {}, 10_000);
  if (result.status === "failed" || result.status === "timeout") {
    ctx.checkpoint.variables.error = result.error ?? "ui_tree_dump_failed";
    ctx.checkpoint.variables.screenState = "unknown";
    return;
  }

  const uiTreeText = extractUiTreeText(result.output);
  const classified = classifyRedditHealthFromUiTree(uiTreeText);
  for (const [key, value] of Object.entries(classified)) {
    ctx.checkpoint.variables[key] = value;
  }
  ctx.checkpoint.variables.redditHealthClassifier = {
    method: "ui_tree_l1",
    packageDetected: uiTreeText.toLowerCase().includes("com.reddit.frontpage"),
    uiTreeChars: uiTreeText.length,
  };
}

/**
 * Branch to different step arrays depending on _unfollow_decision.action.
 * Params:
 *   on_unfollow: WorkflowStep[]
 *   on_skip:     WorkflowStep[]
 */
async function handleBranchOnDecision(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const cond = params.condition as string | undefined;

  // New condition-based branch (condition / if_true_steps / if_false_steps)
  if (cond !== undefined) {
    info(ctx, `branch_on_decision: condition="${cond}", variables=${JSON.stringify(ctx.checkpoint.variables)}`);
    const evalResult = evalConditionExpr(cond, ctx.checkpoint.variables);
    info(ctx, `branch_on_decision: evalResult=${evalResult}`);
    const steps = evalResult
      ? (params.if_true_steps  as WorkflowStep[]) || []
      : (params.if_false_steps as WorkflowStep[]) || [];
    if (steps.length > 0) await ctx.executeSteps(steps);
    return;
  }

  // Legacy: _unfollow_decision / on_<action> pattern
  const decision = ctx.checkpoint.variables['_unfollow_decision'] as UnfollowDecision | null;
  const action   = decision?.action ?? 'skip';
  const steps    = (params[`on_${action}`] as WorkflowStep[]) || [];
  if (steps.length > 0) await ctx.executeSteps(steps);
}

async function handleConditionalPause(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const triggerEvery  = (params.trigger_every as number) || 10;
  const counter       = (params.counter as string) || 'evaluated_count';
  const durationRange = params.duration_range_seconds as [number, number] | undefined;

  const count = (ctx.checkpoint.variables[counter] as number) ?? 0;
  if (count > 0 && count % triggerEvery === 0) {
    const range = durationRange ?? [60, 180];
    const ms = randomBetween(range[0] * 1_000, range[1] * 1_000);
    info(ctx, `conditional_pause: every-${triggerEvery} pause — sleeping ${(ms / 1_000).toFixed(0)}s`);
    await ctx.sleep(ms);
  }
}

async function handleForcedPause(params: Record<string, unknown>, ctx: SkillActionContext): Promise<void> {
  const secs = (params.duration_seconds as number) || 30;
  info(ctx, `forced_pause: ${secs}s`);
  await ctx.sleep(secs * 1_000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONDITION EXPRESSION EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a simple condition string against a variables map.
 * NO eval() — pure string parsing.
 *
 * Supported patterns:
 *   "varName >= 3"              — numeric comparison
 *   "varName == 'some_string'"  — string comparison
 *   "varName is set"            — null/undefined check
 *   "varName is not set"
 *   "true" / "false"            — boolean literals
 *   "varName"                   — truthy check
 *
 * Variable paths support dot notation: "input.count" → vars.input?.count
 */
export function evalConditionExpr(
  expr: string,
  vars: Record<string, unknown>,
): boolean {
  const t = expr.trim();

  // "X is set"
  const isSetM = t.match(/^(\S+)\s+is\s+set$/i);
  if (isSetM) {
    const v = resolveVar(isSetM[1], vars);
    return v !== undefined && v !== null;
  }

  // "X is not set"
  const isNotSetM = t.match(/^(\S+)\s+is\s+not\s+set$/i);
  if (isNotSetM) {
    const v = resolveVar(isNotSetM[1], vars);
    return v === undefined || v === null;
  }

  // Comparison: "X op Y"
  const compM = t.match(/^(\S+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (compM) {
    const lhsRaw = resolveVar(compM[1], vars);
    const op     = compM[2];
    const rhsRaw = resolveRhs(compM[3].trim(), vars);

    const lhsN = typeof lhsRaw === 'number' ? lhsRaw : parseFloat(String(lhsRaw));
    const rhsN = typeof rhsRaw === 'number' ? rhsRaw : parseFloat(String(rhsRaw));

    // Numeric comparison when both sides are valid numbers
    if (!isNaN(lhsN) && !isNaN(rhsN)) {
      switch (op) {
        case '>=': return lhsN >= rhsN;
        case '<=': return lhsN <= rhsN;
        case '==': return lhsN === rhsN;
        case '!=': return lhsN !== rhsN;
        case '>':  return lhsN >  rhsN;
        case '<':  return lhsN <  rhsN;
      }
    }

    // String comparison fallback
    const lhsS = String(lhsRaw ?? '');
    const rhsS = String(rhsRaw ?? '');
    switch (op) {
      case '==': return lhsS === rhsS;
      case '!=': return lhsS !== rhsS;
      default:   return false;
    }
  }

  // Boolean literals
  if (t.toLowerCase() === 'true')  return true;
  if (t.toLowerCase() === 'false') return false;

  // Single variable — truthy check
  return Boolean(resolveVar(t, vars));
}

function resolveVar(name: string, vars: Record<string, unknown>): unknown {
  if (name in vars) return vars[name];

  // Dot notation traversal
  const parts = name.split('.');
  let cur: unknown = vars;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function resolveRhs(rhs: string, vars: Record<string, unknown>): unknown {
  if ((rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))) {
    return rhs.slice(1, -1);
  }
  if (/^-?[\d.]+$/.test(rhs)) return parseFloat(rhs);
  if (rhs === 'true')  return true;
  if (rhs === 'false') return false;
  if (rhs === 'null')      return null;
  if (rhs === 'undefined') return undefined;
  return resolveVar(rhs, vars);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function itemToKey(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    if ('username' in obj) return String(obj['username']);
  }
  return JSON.stringify(item);
}

function info(ctx: SkillActionContext, msg: string): void {
  console.log(`[skill-action] ${ctx.workflowId} @${ctx.stepIndex}: ${msg}`);
}

function warn(ctx: SkillActionContext, msg: string): void {
  console.warn(`[skill-action] ${ctx.workflowId} @${ctx.stepIndex}: ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTREACH ACTIONS — Instagram engagement automation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DETECT_CURRENT_SCREEN — fast UI tree–based detection of Instagram screen type.
 *
 * Distinguishes between:
 *   REELS_FULLSCREEN — Reels tab, TikTok-style fullscreen player
 *                      Signals: clips_viewer / reel_viewer / clips_swipe_refresh_layout
 *                               resourceId present AND no bottom nav bar visible
 *   HOME_FEED        — Home feed (posts, inline Reels, Stories)
 *                      Signals: swipeable_tab_view_pager or tab_bar visible
 *   UNKNOWN          — anything else (profile, search, etc.)
 *
 * Sets checkpoint.variables[target_variable] (default: "_current_screen")
 * to one of: "REELS_FULLSCREEN" | "HOME_FEED" | "UNKNOWN"
 *
 * Params:
 *   target_variable: string — checkpoint key (default: "_current_screen")
 */
async function handleDetectCurrentScreen(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const targetVar = (params.target_variable as string) || '_current_screen';

  info(ctx, 'detect_current_screen: dispatching ui_tree_dump');

  let screen = 'UNKNOWN';

  try {
    const result = await ctx.dispatchAndWait('ui_tree_dump', {}, 15_000);

    if (result.status !== 'ok' && result.status !== 'success') {
      warn(ctx, `detect_current_screen: ui_tree_dump failed (${result.status}) — defaulting to HOME_FEED`);
      ctx.checkpoint.variables[targetVar] = 'HOME_FEED';
      return;
    }

    const rawTree = (result.output as Record<string, unknown> | undefined)?.['uiTree'];
    if (!rawTree) {
      warn(ctx, 'detect_current_screen: no uiTree in result — defaulting to HOME_FEED');
      ctx.checkpoint.variables[targetVar] = 'HOME_FEED';
      return;
    }

    const tree: UiNode = typeof rawTree === 'string' ? JSON.parse(rawTree) : (rawTree as UiNode);

    // ── Signal collectors ──────────────────────────────────────────────────
    let hasReelViewer   = false;
    let hasNavBar       = false;
    let hasHomeFeedPager = false;

    traverseUiTree(tree, (n) => {
      const rid = (n.resourceId || n.resId || '').toLowerCase();

      // REELS_FULLSCREEN markers
      if (
        rid.includes('clips_viewer') ||
        rid.includes('reel_viewer') ||
        rid.includes('clips_swipe_refresh') ||
        rid.includes('clips_bottom_sheet') ||
        rid.includes('reels_tray')
      ) {
        hasReelViewer = true;
      }

      // HOME_FEED markers — bottom navigation bar
      if (
        rid.includes('tab_bar') ||
        rid.includes('bottom_navigation') ||
        rid.includes('navigation_bar') ||
        rid.includes('feed_tab') ||
        rid.includes('home_tab')
      ) {
        hasNavBar = true;
      }

      // HOME_FEED markers — feed pager
      if (
        rid.includes('swipeable_tab_view_pager') ||
        rid.includes('feed_list') ||
        rid.includes('feed_recycler')
      ) {
        hasHomeFeedPager = true;
      }
    });

    // ── Decision logic ─────────────────────────────────────────────────────
    // REELS_FULLSCREEN: reel viewer present AND no bottom nav bar (fullscreen hides it)
    if (hasReelViewer && !hasNavBar) {
      screen = 'REELS_FULLSCREEN';
    } else if (hasNavBar || hasHomeFeedPager) {
      screen = 'HOME_FEED';
    } else if (hasReelViewer) {
      // Edge case: reel viewer present but nav bar also visible (transition state) — treat as HOME_FEED
      screen = 'HOME_FEED';
    } else {
      screen = 'UNKNOWN';
    }

    info(ctx,
      `detect_current_screen: result="${screen}" ` +
      `(reelViewer=${hasReelViewer}, navBar=${hasNavBar}, feedPager=${hasHomeFeedPager})`
    );

  } catch (err) {
    warn(ctx, `detect_current_screen: error: ${(err as Error).message} — defaulting to HOME_FEED`);
    screen = 'HOME_FEED';
  }

  ctx.checkpoint.variables[targetVar] = screen;
}

/**
 * VLM_ANALYZE_POST_FOR_OUTREACH
 * 
 * Takes a screenshot and uses VLM to determine if the visible post is from
 * a potential client for glamour/boudoir photography.
 * 
 * Params:
 *   target_variable: string — checkpoint key to store result (default: "post_analysis")
 *   account_name:    string — own account name to skip (default: "@incitographer")
 *   min_age:         number — minimum age for potential client (default: 20)
 *   max_age:         number — maximum age for potential client (default: 35)
 * 
 * Sets in checkpoint.variables:
 *   [target_variable]: { is_potential_client: boolean, reason: string, post_description: string, post_author: string }
 *   _found_potential_client: boolean
 */
async function handleVlmAnalyzePostForOutreach(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const targetVar   = (params.target_variable as string) || 'post_analysis';
  const accountName = (params.account_name as string)    || '@incitographer';
  const minAge      = (params.min_age as number)         || 20;
  const maxAge      = (params.max_age as number)         || 35;

  const port  = parseInt(process.env['PORT'] ?? '21211', 10);
  const token = process.env['API_KEY'] || '';

  const task = `Analizează această postare Instagram vizibilă pe ecran.

Răspunde STRICT un singur obiect JSON, fără alt text:

{
  "is_potential_client": true/false,
  "reason": "explicație scurtă",
  "post_description": "descriere detaliată (80-100 cuvinte): culori dominante, stil/aesthetic, locație, outfit, vibe, elemente vizuale distinctive care ar putea inspira un comentariu autentic",
  "post_author": "@username sau 'unknown'"
}

Criterii pentru is_potential_client = true:
1. Postarea este făcută de o FEMEIE
2. Vârsta estimată: ${minAge}-${maxAge} ani
3. Se vede chipul sau silueta ei în poză
4. Nu este o pagină de brand/magazin/companie
5. Nu este ${accountName} (contul propriu)
6. Conținutul sugerează că ar putea fi interesată de fotografie glamour/boudoir (lifestyle, fashion, beauty, selfie)

Dacă postarea este un Reel/video, analizează thumbnail-ul vizibil.
Dacă nu poți determina cu certitudine, pune is_potential_client: false.`;

  // ── Ensure screen is ON before taking screenshot ──────────────────────────
  // Check screen state first — only wake if actually off (avoids ~1s latency when already on).
  try {
    const stateResult = await ctx.dispatchAndWait('get_screen_state', {}, 3000);
    const stateResultAny = stateResult as unknown as Record<string, unknown> | null | undefined;
    const screenState = stateResultAny
      ? (stateResultAny['output'] as Record<string, unknown> | undefined)?.['state']
      : undefined;

    if (screenState === 'off') {
      info(ctx, 'vlm_analyze: screen off, waking...');
      await ctx.dispatchAndWait('screen_wake', {}, 5000);
      await new Promise(r => setTimeout(r, 500));
    } else {
      info(ctx, `vlm_analyze: screen already on (state=${screenState ?? 'unknown'}), skipping wake`);
    }
  } catch (wakeErr) {
    warn(ctx, `vlm_analyze_post_for_outreach: screen state check/wake failed (non-fatal): ${(wakeErr as Error).message}`);
  }

  info(ctx, 'vlm_analyze_post_for_outreach: calling analyze-screen');

  try {
    const body = JSON.stringify({ deviceId: ctx.deviceId, task });

    // Retry once if screenshot appears black (size < 10KB is a strong signal)
    let response = await httpPost(`http://localhost:${port}/api/hydra/analyze-screen`, body, token);

    // If we got a response but the screenshot might be black, retry after another wake
    if (response.ok) {
      const screenshotSize = (response.data as Record<string, unknown>)?.['screenshotSize'] as number | undefined;
      const analysisRaw    = (response.data as Record<string, unknown>)?.['analysis'];
      const analysisStr    = typeof analysisRaw === 'string' ? analysisRaw : JSON.stringify(analysisRaw ?? '');
      const looksBlack     = screenshotSize !== undefined && screenshotSize < 10_000;
      const noContent      = analysisStr.toLowerCase().includes('black') || analysisStr.toLowerCase().includes('dark screen') || analysisStr.toLowerCase().includes('negru');

      if (looksBlack || noContent) {
        warn(ctx, `vlm_analyze_post_for_outreach: screenshot appears black (size=${screenshotSize}), retrying after screen wake`);
        try {
          await ctx.dispatchAndWait('screen_wake', {}, 5000);
          await ctx.sleep(800);
        } catch { /* non-fatal */ }
        response = await httpPost(`http://localhost:${port}/api/hydra/analyze-screen`, body, token);
      }
    }

    // ── Remove duplicate response variable shadowing below ─────────────────
    // (original code continues with `response` which is now potentially the retried one)

    if (!response.ok) {
      warn(ctx, `vlm_analyze_post_for_outreach: analyze-screen error: ${JSON.stringify(response.data).slice(0, 200)}`);
      ctx.checkpoint.variables[targetVar] = { is_potential_client: false, reason: 'VLM error', post_description: '', post_author: '' };
      ctx.checkpoint.variables['_found_potential_client'] = false;
      return;
    }

    // Parse VLM response
    let analysis = response.data?.analysis as Record<string, unknown> | null;
    
    // Handle raw string response
    if (analysis && typeof analysis === 'object' && 'raw' in analysis) {
      try {
        const jsonMatch = (analysis.raw as string).match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        }
      } catch { /* ignore parse error */ }
    }

    const result = {
      is_potential_client: Boolean(analysis?.['is_potential_client']),
      reason: String(analysis?.['reason'] || ''),
      post_description: String(analysis?.['post_description'] || ''),
      post_author: String(analysis?.['post_author'] || 'unknown'),
    };

    // Skip own account
    if (result.post_author.toLowerCase().includes(accountName.toLowerCase().replace('@', ''))) {
      result.is_potential_client = false;
      result.reason = 'Own account - skip';
    }

    // Detect if it's a Reel based on VLM response (used by workflow to pick correct selector)
    const isReel = result.post_description.toLowerCase().includes('reel') ||
                   result.reason.toLowerCase().includes('reel');
    ctx.checkpoint.variables['_is_reel'] = isReel;

    ctx.checkpoint.variables[targetVar] = result;
    ctx.checkpoint.variables['_found_potential_client'] = result.is_potential_client;
    ctx.checkpoint.variables['_post_description'] = result.post_description;
    ctx.checkpoint.variables['_post_author'] = result.post_author;

    info(ctx, `vlm_analyze_post_for_outreach: result=${result.is_potential_client}, author=${result.post_author}, is_reel=${isReel}`);

  } catch (err) {
    warn(ctx, `vlm_analyze_post_for_outreach: request failed: ${(err as Error).message}`);
    ctx.checkpoint.variables[targetVar] = { is_potential_client: false, reason: 'Request failed', post_description: '', post_author: '' };
    ctx.checkpoint.variables['_found_potential_client'] = false;
  }

  // Track VLM usage
  const prev = (ctx.checkpoint.variables['vlm_calls_this_run'] as number) ?? 0;
  ctx.checkpoint.variables['vlm_calls_this_run'] = prev + 1;
}

/**
 * VLM_GENERATE_COMMENT
 * 
 * Uses VLM to generate a contextual, admiring comment based on the post description.
 * 
 * Params:
 *   post_description_var: string — checkpoint variable with post description (default: "_post_description")
 *   target_variable:      string — checkpoint key to store comment (default: "_generated_comment")
 *   account_context:      string — context about the commenting account (default: "fotograf glamour")
 *   max_chars:            number — maximum comment length (default: 150)
 *   tone:                 string — comment tone (default: "admirativ, prietenos, natural")
 * 
 * Sets:
 *   [target_variable]: string — the generated comment
 */
async function handleVlmGenerateComment(
  params: Record<string, unknown>,
  ctx:    SkillActionContext,
): Promise<void> {
  const descVar       = (params.post_description_var as string) || '_post_description';
  const targetVar     = (params.target_variable as string)      || '_generated_comment';
  const accountCtx    = (params.account_context as string)      || 'fotograf glamour';
  const maxChars      = (params.max_chars as number)            || 150;
  const tone          = (params.tone as string)                 || 'admirativ, prietenos, natural';

  const postDesc = ctx.checkpoint.variables[descVar] as string;
  if (!postDesc) {
    warn(ctx, 'vlm_generate_comment: no post description available');
    ctx.checkpoint.variables[targetVar] = '';
    return;
  }

  const task = `Generează un comentariu scurt pentru această postare Instagram.

Descrierea postării: "${postDesc}"

Context: Comentariul este de la un cont de ${accountCtx} (@incitographer).

REGULI STRICTE:
1. Maxim ${maxChars} caractere
2. Maxim 2 propoziții
3. Ton: ${tone}
4. NU menționa servicii foto sau colaborări
5. NU folosi emoji exagerate (maxim 1-2 emoji subtile)
6. NU folosi întrebări
7. Sună natural, ca un compliment sincer
8. Poate fi în română sau engleză, potrivit cu contextul postării

Exemple bune:
- "Ce culori superbe! 💫"
- "Adorable vibes ✨"
- "Locație perfectă pentru această poză!"
- "This aesthetic is everything 🔥"

Răspunde DOAR cu textul comentariului, fără ghilimele, fără explicații.`;

  info(ctx, 'vlm_generate_comment: generating comment via OpenClaw CLI (no screenshot needed)');

  try {
    // Use OpenClaw CLI directly for text generation — no screenshot needed
    const { spawnSync } = require('child_process');
    const spawnResult = spawnSync(
      'openclaw',
      ['agent', '--agent', 'main', '--local', '--json', '-m', task],
      {
        encoding:  'utf8',
        timeout:   30000,
        maxBuffer: 5 * 1024 * 1024,
        cwd:       '/data/.openclaw/workspace',
      },
    );

    if (spawnResult.error) {
      throw spawnResult.error;
    }

    // OpenClaw CLI writes JSON to stderr; check stdout first for forward-compat
    const rawStdout = spawnResult.stdout || '';
    const rawStderr = spawnResult.stderr || '';
    let vlmResult   = '';

    if (rawStdout.includes('"payloads"')) {
      vlmResult = rawStdout;
      info(ctx, 'vlm_generate_comment: JSON found in stdout');
    } else if (rawStderr.includes('"payloads"')) {
      const jsonStart = rawStderr.indexOf('{');
      if (jsonStart !== -1) {
        vlmResult = rawStderr.slice(jsonStart);
        info(ctx, 'vlm_generate_comment: JSON found in stderr (expected openclaw CLI behavior)');
      }
    }

    if (!vlmResult || vlmResult.trim() === '') {
      warn(ctx, `vlm_generate_comment: OpenClaw returned empty response. stderr: ${rawStderr.slice(0, 300)}`);
      ctx.checkpoint.variables[targetVar] = '';
      return;
    }

    const parsed  = JSON.parse(vlmResult);
    let   comment = (parsed?.payloads?.[0]?.text as string || '').trim();

    // Clean up: remove quotes if wrapped
    if ((comment.startsWith('"') && comment.endsWith('"')) ||
        (comment.startsWith("'") && comment.endsWith("'"))) {
      comment = comment.slice(1, -1);
    }

    // Truncate if too long
    if (comment.length > maxChars) {
      comment = comment.slice(0, maxChars - 3) + '...';
    }

    ctx.checkpoint.variables[targetVar] = comment;
    if (comment) {
      info(ctx, `vlm_generate_comment: generated "${comment.slice(0, 50)}..."`);
    } else {
      warn(ctx, 'vlm_generate_comment: parsed response but comment is empty');
    }

  } catch (err) {
    warn(ctx, `vlm_generate_comment: request failed: ${(err as Error).message}`);
    ctx.checkpoint.variables[targetVar] = '';
  }

  // Track VLM usage
  const prev = (ctx.checkpoint.variables['vlm_calls_this_run'] as number) ?? 0;
  ctx.checkpoint.variables['vlm_calls_this_run'] = prev + 1;
}
