/**
 * screen-detection/screen-detection.service.ts
 * Main cascade service: L1 (UI Tree) → L2 (OCR) → L3 (VLM).
 * Story: US-SCREEN-CASCADE
 */

import { v4 as uuidv4 } from 'uuid';
import { sendJobToDevice } from '../../transport/transport';
import { visionService } from '../vision/vision.service';
import { getDb } from '../../db/client';
import { UiTreeDetector } from './detectors/ui-tree.detector';
import { OcrDetector } from './detectors/ocr.detector';
import { VlmDetector } from './detectors/vlm.detector';
import { parseDetectionRules } from './rules/rule-engine';
import type {
  DetectedScreen,
  DetectionRequest,
  ScreenId,
  ScreenRule,
  UiNode,
  OcrResult,
  DetectionCacheEntry,
} from './types';

import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════
// PENDING JOB HELPERS
// ═══════════════════════════════════════════════════════════════════

interface PendingResult<T> {
  resolve: (value: T | null) => void;
  timer:   ReturnType<typeof setTimeout>;
}

const pendingUiTree = new Map<string, PendingResult<UiNode[]>>();
const pendingOcr    = new Map<string, PendingResult<OcrResult>>();

/**
 * Called by ws.server.ts JOB_RESULT handler when a ui_tree_dump job completes.
 * Returns true if the jobId was handled here (consumed).
 */
export function resolveUiTreeResult(
  jobId:  string,
  result: { status: string; output?: Record<string, unknown> },
): boolean {
  const pending = pendingUiTree.get(jobId);
  if (!pending) return false;
  console.log(`[screen-detection] resolveUiTreeResult: jobId=${jobId.slice(0,8)} status=${result.status} outputKeys=${JSON.stringify(Object.keys(result.output ?? {}))}`);
  clearTimeout(pending.timer);
  pendingUiTree.delete(jobId);

  if (result.status === 'completed' && result.output) {
    // Android returns: { "uiTree": "<json_string>" }  ← uiTree is a JSON string, not object
    // Also support legacy: "nodes", "tree", "data" keys
    let nodes: UiNode[] = [];

    const rawUiTree = result.output.uiTree;
    if (typeof rawUiTree === 'string') {
      // Android serializes the tree as a JSON string — parse it
      try {
        const parsed = JSON.parse(rawUiTree) as UiNode | UiNode[];
        // Root may be a single root node object (not array) — wrap it
        nodes = Array.isArray(parsed) ? parsed : [parsed];
        console.log(`[screen-detection] resolveUiTreeResult: parsed uiTree string → ${nodes.length} root nodes`);
      } catch (e) {
        console.warn(`[screen-detection] resolveUiTreeResult: failed to parse uiTree JSON string: ${(e as Error).message}`);
        nodes = [];
      }
    } else if (rawUiTree && typeof rawUiTree === 'object') {
      // Already an object — wrap in array if not array
      nodes = Array.isArray(rawUiTree) ? rawUiTree as UiNode[] : [rawUiTree as UiNode];
    } else {
      // Legacy fallbacks: "nodes", "tree", "data"
      const fallback = result.output.nodes ?? result.output.tree ?? result.output.data ?? [];
      nodes = Array.isArray(fallback) ? fallback as UiNode[] : [];
    }

    pending.resolve(nodes.length > 0 ? nodes : null);
  } else {
    pending.resolve(null);
  }
  return true;
}

/**
 * Called by ws.server.ts JOB_RESULT handler when an ocr_full job completes.
 */
export function resolveOcrResult(
  jobId:  string,
  result: { status: string; output?: Record<string, unknown> },
): boolean {
  const pending = pendingOcr.get(jobId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingOcr.delete(jobId);

  if (result.status === 'completed' && result.output) {
    const blocks = (result.output.blocks ?? []) as OcrResult['blocks'];
    const fullText = (result.output.fullText ?? result.output.full_text ?? '') as string;
    pending.resolve({ blocks: Array.isArray(blocks) ? blocks : [], fullText: String(fullText) });
  } else {
    pending.resolve(null);
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// RULES CACHE (per platform, 60s TTL)
// ═══════════════════════════════════════════════════════════════════

interface RulesCacheEntry {
  rules: ScreenRule[];
  ts:    number;
}

const rulesCache = new Map<string, RulesCacheEntry>();
const RULES_CACHE_TTL = 60_000;

// Skills directory — mirrors skill.service.ts logic
const SKILLS_DIR = path.resolve(__dirname, '../skills/templates');

// ═══════════════════════════════════════════════════════════════════
// CONFIDENCE THRESHOLDS
// ═══════════════════════════════════════════════════════════════════

const CONFIDENCE_THRESHOLD = 0.80;

// ═══════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════

export class ScreenDetectionService {
  private readonly detectionCache = new Map<string, DetectionCacheEntry>();
  private readonly DETECTION_CACHE_TTL = 1_000;  // 1s — screen changes quickly

  private readonly uiTreeDetector = new UiTreeDetector();
  private readonly ocrDetector    = new OcrDetector();
  private readonly vlmDetector    = new VlmDetector(visionService);

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Detect current screen using cascade: L1 → L2 → L3.
   * Returns early on first confident match (≥ 0.80).
   */
  async detectScreen(req: DetectionRequest): Promise<DetectedScreen> {
    const start     = Date.now();
    const timeoutMs = req.timeoutMs ?? 10_000;

    // Resolve platform wildcard "*" to a concrete platform
    const platform = this.resolvePlatform(req.platform, req.packageName);

    // Cache check (1s TTL, skip if skipCache=true)
    if (!req.skipCache) {
      const cached = this.detectionCache.get(req.deviceId);
      if (cached && Date.now() - cached.ts < this.DETECTION_CACHE_TTL) {
        return { ...cached.result, latencyMs: Date.now() - start };
      }
    }

    const rules = await this.getRules(platform);

    // ── L1: UI Tree ────────────────────────────────────────────────────────────
    if (req.preferredMethod !== 'ocr' && req.preferredMethod !== 'vlm') {
      try {
        const l1Start  = Date.now();
        const uiTree   = await this.fetchUiTree(req.deviceId, Math.min(8_000, timeoutMs));
        // Log node count for observability
        const allFlatNodes = this.uiTreeDetector.flattenTree(uiTree);
        console.log(`[screen-detection] L1 ui_tree: ${allFlatNodes.length} nodes for device ${req.deviceId.slice(0, 8)}`);
        const partial  = this.uiTreeDetector.detect(uiTree, rules);
        const l1Result = this.finalize(partial, 'ui_tree', start);

        // Critical screen → return immediately regardless of confidence
        if (l1Result.screenId !== 'UNKNOWN' && this.isCritical(l1Result.screenId, rules)) {
          this.log(req.deviceId, platform, l1Result, ['L1_critical_early_return']);
          this.cache(req.deviceId, l1Result);
          return l1Result;
        }

        if (l1Result.confidence >= CONFIDENCE_THRESHOLD) {
          this.log(req.deviceId, platform, l1Result, ['L1_success']);
          this.cache(req.deviceId, l1Result);
          return l1Result;
        }

        console.log(`[screen-detection] L1 low confidence: ${l1Result.screenId} (${l1Result.confidence.toFixed(2)}) in ${Date.now() - l1Start}ms — trying L2`);
      } catch (err) {
        console.warn(`[screen-detection] L1 failed: ${(err as Error).message}`);
      }
    }

    // ── L2: OCR ────────────────────────────────────────────────────────────────
    if (req.preferredMethod !== 'vlm') {
      try {
        const l2Start  = Date.now();
        // OCR takes 2-3s on device — minimum 3000ms, capped at remaining budget
        const ocrResult = await this.fetchOcr(req.deviceId, Math.max(3_000, Math.min(5_000, timeoutMs - (Date.now() - start))));
        const partial   = this.ocrDetector.detect(ocrResult, rules);
        const l2Result  = this.finalize(partial, 'ocr', start);

        if (l2Result.confidence >= CONFIDENCE_THRESHOLD) {
          this.log(req.deviceId, platform, l2Result, ['L1_failed', 'L2_success']);
          this.cache(req.deviceId, l2Result);
          return l2Result;
        }

        console.log(`[screen-detection] L2 low confidence: ${l2Result.screenId} (${l2Result.confidence.toFixed(2)}) in ${Date.now() - l2Start}ms — trying L3`);
      } catch (err) {
        console.warn(`[screen-detection] L2 failed: ${(err as Error).message}`);
      }
    }

    // ── L3: VLM ────────────────────────────────────────────────────────────────
    try {
      const l3Start      = Date.now();
      // Screenshot takes ~1s + VLM call — minimum 4s
      const screenshot   = await this.fetchScreenshot(req.deviceId, Math.max(4_000, Math.min(10_000, timeoutMs - (Date.now() - start))));
      const partial      = await this.vlmDetector.detect(screenshot, platform, req.deviceId);
      const l3Result     = this.finalize(partial, 'vlm', start);

      console.log(`[screen-detection] L3 VLM: ${l3Result.screenId} (${l3Result.confidence.toFixed(2)}) in ${Date.now() - l3Start}ms`);
      this.log(req.deviceId, platform, l3Result, ['L1_failed', 'L2_failed', 'L3_vlm']);
      this.cache(req.deviceId, l3Result);
      return l3Result;
    } catch (err) {
      console.error(`[screen-detection] L3 failed: ${(err as Error).message}`);
    }

    // All levels failed
    const fallback: DetectedScreen = {
      screenId:   'UNKNOWN',
      confidence: 0,
      method:     'vlm',
      markers:    ['all_levels_failed'],
      navBar:     { visible: false, selectedTab: null },
      overlays:   [],
      latencyMs:  Date.now() - start,
      error:      'All detection levels failed',
    };
    this.log(req.deviceId, platform, fallback, ['L1_failed', 'L2_failed', 'L3_failed']);
    return fallback;
  }

  /**
   * Check if device is on expected screen (more efficient when target is known).
   */
  async isOnScreen(
    deviceId:       string,
    platform:       string,
    expectedScreen: ScreenId,
  ): Promise<{ match: boolean; actual: ScreenId; confidence: number }> {
    const result = await this.detectScreen({ deviceId, platform });
    return {
      match:      result.screenId === expectedScreen,
      actual:     result.screenId,
      confidence: result.confidence,
    };
  }

  /**
   * Navigate to target screen if not already there.
   * Returns true if on target screen after (at most) maxAttempts.
   */
  async ensureScreen(
    deviceId:      string,
    platform:      string,
    targetScreen:  ScreenId,
    maxAttempts:   number = 3,
  ): Promise<boolean> {
    this.clearCache(deviceId); // ensure fresh detection on first attempt
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const check = await this.isOnScreen(deviceId, platform, targetScreen);
      if (check.match) {
        console.log(`[screen-detection] ensureScreen: on ${targetScreen} ✓ (attempt ${attempt})`);
        return true;
      }
      console.log(`[screen-detection] ensureScreen: on ${check.actual}, need ${targetScreen} (attempt ${attempt}/${maxAttempts})`);

      // Simple navigation: press BACK and HOME to try to reach the screen
      if (attempt < maxAttempts) {
        await this.pressBack(deviceId);
        this.clearCache(deviceId);
        await sleep(500);
      }
    }
    return false;
  }

  /**
   * Resolve platform wildcard "*" to a concrete platform name.
   * Uses packageName→platform reverse map if available.
   * Falls back to "instagram" as the default platform.
   */
  private resolvePlatform(platform: string, packageName?: string): string {
    if (platform !== '*') return platform;

    // Reverse map: packageName → platform
    if (packageName) {
      const packageToPlatform: Record<string, string> = {
        'com.instagram.android': 'instagram',
        'com.zhiliaoapp.musically': 'tiktok',
        'com.ss.android.ugc.trill': 'tiktok',
        'com.reddit.frontpage': 'reddit',
        'com.twitter.android': 'twitter',
        'com.facebook.katana': 'facebook',
        'com.youtube.android': 'youtube',
        'com.google.android.youtube': 'youtube',
      };
      const resolved = packageToPlatform[packageName.toLowerCase()];
      if (resolved) {
        console.log(`[screen-detection] Resolved platform "*" → "${resolved}" from packageName="${packageName}"`);
        return resolved;
      }
    }

    // Default fallback
    console.log(`[screen-detection] Platform "*" — defaulting to "instagram"`);
    return 'instagram';
  }

  /**
   * Load and parse detection rules for a platform from its skill file.
   * Rules are cached for 60s.
   */
  async getRules(platform: string): Promise<ScreenRule[]> {
    const cached = rulesCache.get(platform);
    if (cached && Date.now() - cached.ts < RULES_CACHE_TTL) {
      return cached.rules;
    }

    const filePath = path.join(SKILLS_DIR, `${platform}.skill`);
    if (!fs.existsSync(filePath)) {
      console.warn(`[screen-detection] No skill file for platform "${platform}" at ${filePath}`);
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const rules   = parseDetectionRules(content);
    rulesCache.set(platform, { rules, ts: Date.now() });
    console.log(`[screen-detection] Loaded ${rules.length} detection rules for "${platform}"`);
    return rules;
  }

  /**
   * Clear detection cache for device (call after navigation).
   */
  clearCache(deviceId: string): void {
    this.detectionCache.delete(deviceId);
  }

  // ─── Device job helpers ──────────────────────────────────────────────────────

  private async fetchUiTree(deviceId: string, timeoutMs: number): Promise<UiNode[]> {
    const jobId = uuidv4();

    const result = await new Promise<UiNode[] | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingUiTree.delete(jobId);
        resolve(null);
      }, timeoutMs);
      pendingUiTree.set(jobId, { resolve, timer });

      // Send job to device via DirectWS transport
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: 'ui_tree_dump' as import('../../../shared/protocol/messages').JobType,
        params: { format: 'json' } as Record<string, unknown>,
        timeoutMs,
      });
      if (!sent) {
        clearTimeout(timer);
        pendingUiTree.delete(jobId);
        resolve(null);
      }
    });

    if (!result) throw new Error(`ui_tree_dump timed out (${timeoutMs}ms) for device ${deviceId.slice(0, 8)}`);
    return result;
  }

  private async fetchOcr(deviceId: string, timeoutMs: number): Promise<OcrResult> {
    const jobId = uuidv4();

    const result = await new Promise<OcrResult | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingOcr.delete(jobId);
        resolve(null);
      }, timeoutMs);
      pendingOcr.set(jobId, { resolve, timer });

      // Send job to device via DirectWS transport
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: 'ocr_full' as import('../../../shared/protocol/messages').JobType,
        params: {} as Record<string, unknown>,
        timeoutMs,
      });
      if (!sent) {
        clearTimeout(timer);
        pendingOcr.delete(jobId);
        resolve(null);
      }
    });

    if (!result) throw new Error(`ocr_full timed out (${timeoutMs}ms) for device ${deviceId.slice(0, 8)}`);
    return result;
  }

  private async fetchScreenshot(deviceId: string, timeoutMs: number): Promise<string> {
    // Re-use the orchestrator pattern — send a screenshot job and await resolution
    // The orchestrator's resolveScreenshotResult will handle this via ws.server.ts
    const jobId = uuidv4();

    const result = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingScreenshots.delete(jobId);
        resolve(null);
      }, timeoutMs);
      pendingScreenshots.set(jobId, { resolve, timer });

      // Send job to device via DirectWS transport
      // Send job to device via DirectWS transport
      const sent = sendJobToDevice(deviceId, {
        jobId,
        type: 'screenshot_for_vlm' as import('../../../shared/protocol/messages').JobType,
        params: { quality: 85, maxWidth: 540 } as Record<string, unknown>,
        timeoutMs,
      });
      if (!sent) {
        clearTimeout(timer);
        pendingScreenshots.delete(jobId);
        resolve(null);
      }
    });

    if (!result) throw new Error(`screenshot timed out (${timeoutMs}ms) for device ${deviceId.slice(0, 8)}`);
    return result;
  }

  private async pressBack(deviceId: string): Promise<void> {
    const jobId = uuidv4();
    // Send job to device via DirectWS transport
    sendJobToDevice(deviceId, {
      jobId,
      type: 'press_key' as import('../../../shared/protocol/messages').JobType,
      params: { key: 'back' } as Record<string, unknown>,
      timeoutMs: 3_000,
    });
    await sleep(300);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private finalize(
    partial:  Omit<DetectedScreen, 'method' | 'latencyMs'>,
    method:   DetectedScreen['method'],
    startTs:  number,
  ): DetectedScreen {
    return {
      ...partial,
      method,
      latencyMs: Date.now() - startTs,
    };
  }

  private isCritical(screenId: ScreenId, rules: ScreenRule[]): boolean {
    const rule = rules.find(r => r.id === screenId);
    return rule?.critical ?? false;
  }

  private cache(deviceId: string, result: DetectedScreen): void {
    this.detectionCache.set(deviceId, { result, ts: Date.now() });
  }

  private log(
    deviceId:      string,
    platform:      string,
    result:        DetectedScreen,
    fallbackChain: string[],
  ): void {
    // Fire-and-forget DB log
    const db = getDb();
    db.query(
      `INSERT INTO screen_detection_logs
         (device_id, platform, detected_screen, confidence, method, fallback_chain, latency_ms,
          ui_tree_nodes, ocr_text_length, vlm_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        deviceId,
        platform,
        result.screenId,
        result.confidence,
        result.method,
        fallbackChain,
        result.latencyMs,
        result.rawData?.uiTreeNodeCount ?? null,
        result.rawData?.ocrTextLength   ?? null,
        result.rawData?.vlmTokens       ?? null,
      ],
    ).catch(err => {
      // Non-fatal — don't block detection on logging failures
      console.warn(`[screen-detection] Failed to log detection: ${(err as Error).message}`);
    });
  }
}

// ─── Screenshot pending map (mirrors orchestrator pattern) ────────────────────

interface PendingScreenshot {
  resolve: (value: string | null) => void;
  timer:   ReturnType<typeof setTimeout>;
}

const pendingScreenshots = new Map<string, PendingScreenshot>();

/**
 * Called by ws.server.ts when a screenshot_for_vlm job result arrives.
 */
export function resolveScreenDetectionScreenshot(
  jobId:  string,
  result: { status: string; output?: Record<string, unknown> },
): boolean {
  const pending = pendingScreenshots.get(jobId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingScreenshots.delete(jobId);

  const base64 = result.output?.image_base64 ?? result.output?.base64 ?? result.output?.imageBase64;
  if (result.status === 'completed' && base64) {
    pending.resolve(base64 as string);
  } else {
    pending.resolve(null);
  }
  return true;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const screenDetectionService = new ScreenDetectionService();
