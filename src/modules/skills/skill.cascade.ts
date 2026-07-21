/**
 * skills/skill.cascade.ts
 * Cascade tap execution with auto-learn — integrates skill system with workflows.
 *
 * Flow:
 *   1. skill_tap (coords from .skill file) → verify
 *   2. If fail → a11y_find_tap → verify
 *   3. If fail → vision_request (VLM) → verify
 *   4. On success from level 2/3: update skill coords (auto-learn)
 *
 * Navigation logging: every tap attempt is logged to navigation_logs table.
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "../../db/client";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { sendDeviceExecutionJobToDevice, sendStandaloneJobToDevice, isDeviceOnline } from "../../transport/transport";

function getTransportAdapter() {
  return {
    sendJob: (deviceId: string, payload: any, workflowRootExternalId?: string) => {
      const result = workflowRootExternalId
        ? sendDeviceExecutionJobToDevice(deviceId, payload, {
            boundary: "generated_child",
            rootExternalId: workflowRootExternalId,
            actor: "skill_cascade",
            metadata: { observeSource: "skillCascade.transportAdapter" },
          })
        : sendStandaloneJobToDevice(deviceId, payload);
      return result.then((dispatch) => dispatch.sent);
    },
    isDeviceOnline: (deviceId: string) => {
      return isDeviceOnline(deviceId);
    },
  };
}

import * as skillService from "./skill.service";
import { coordCacheService } from "./skill-db.service";
import type { DeviceInfo } from "./skill-db.service";
import type { NormalizedCoords, TapMethod } from "./types";
import { MIN_CONFIDENCE_FOR_COORDS } from "./types";
import { CD_MAP } from "./constants";
import { uiGraphRepository } from "../ui-graph/repository";
import { uiGraphLearningLoop } from "../ui-graph/learning-loop";
import { observeLearningCandidate } from "../ui-graph/telemetry";
import {
  shouldUseCoordsFromElement,
  getElementCoords,
  getElementConfidence,
  buildCompleteA11yParams,
  buildOcrSearchText,
  isElementFixed,
} from "./cascadeCore";

// ─── Coordinate normalization helper ─────────────────────────────────────────

/**
 * B1 FIX: Ensure coordinates are normalized (0-1).
 * a11y and OCR responses from Android sometimes return pixel values (e.g., x=540, y=1800).
 * The orchestrator's performAction() always multiplies by screen dims, so cascade MUST
 * return normalized values or the result is x=583200 (540 * 1080).
 *
 * Detection heuristic: any coord > 2 is definitely a pixel value.
 */
function normalizeCoord(x: number, y: number, resolution: string): { x: number; y: number } {
  // If coords are already normalized (both <= 1.0), return as-is
  if (x <= 1.0 && y <= 1.0) return { x, y };

  // Pixel values — divide by screen dims
  const parts = resolution.split("x");
  const screenW = parts.length === 2 ? parseInt(parts[0], 10) : 1080;
  const screenH = parts.length === 2 ? parseInt(parts[1], 10) : 2160;
  const nx = x / screenW;
  const ny = y / screenH;
  console.log(`[cascade] B1: Normalizing pixel coords (${x}, ${y}) → (${nx.toFixed(3)}, ${ny.toFixed(3)}) for ${resolution}`);
  return { x: nx, y: ny };
}

// ─── Device info helper ───────────────────────────────────────────────────────

const PLATFORM_TO_PKG: Record<string, string> = {
  reddit:     "com.reddit.frontpage",
  instagram: "com.instagram.android",
  tiktok:    "com.zhiliaoapp.musically",
  facebook:  "com.facebook.katana",
  twitter:   "com.twitter.android",
};

// Simple in-process cache (5 min TTL) — avoids DB hit on every tap
const _devInfoCache = new Map<string, { info: DeviceInfo; ts: number }>();
const DEV_INFO_TTL  = 5 * 60_000;

function getDeviceInfo(deviceId: string, platform: string): DeviceInfo {
  const key    = `${deviceId}:${platform}`;
  const cached = _devInfoCache.get(key);
  if (cached && Date.now() - cached.ts < DEV_INFO_TTL) return cached.info;

  // Best-effort from wsServer metadata (if available)
  const adapter = getTransportAdapter();
  const deviceMeta = adapter && (adapter as unknown as Record<string, unknown>).getDeviceMeta instanceof Function
    ? (adapter as unknown as { getDeviceMeta: (id: string) => Record<string, unknown> | null }).getDeviceMeta(deviceId)
    : null;

  const info: DeviceInfo = {
    app:             PLATFORM_TO_PKG[platform] || platform,
    appVersion:      (deviceMeta?.appVersion as string)  || "unknown",
    resolution:      (deviceMeta?.resolution as string)  || "1080x2160",
    density:         deviceMeta?.density as number | undefined,
    deviceClass:     "phone",
    orientation:     "portrait",
    fontScaleBucket: "normal",
  };

  _devInfoCache.set(key, { info, ts: Date.now() });
  return info;
}

// Async version that fills from DB when wsServer meta is unavailable
async function getDeviceInfoAsync(deviceId: string, platform: string): Promise<DeviceInfo> {
  const sync = getDeviceInfo(deviceId, platform);
  if (sync.appVersion !== "unknown") return sync;  // wsServer had it

  try {
    const db  = getDb();
    const row = await db.query<Record<string, unknown>>(
      `SELECT health, agent_version FROM devices WHERE id = $1`, [deviceId],
    );
    if (row.rows.length > 0) {
      const health = (row.rows[0].health as Record<string, unknown>) || {};
      if (typeof health.screenResolution === "string") sync.resolution = health.screenResolution;
      else if (health.screenWidth && health.screenHeight)
        sync.resolution = `${health.screenWidth}x${health.screenHeight}`;
      if (typeof health.density === "number")           sync.density    = health.density;
      if (typeof health.appVersion === "string")        sync.appVersion = health.appVersion;
      else if (typeof row.rows[0].agent_version === "string")
        sync.appVersion = row.rows[0].agent_version as string;
    }
  } catch { /* non-fatal */ }

  const key = `${deviceId}:${platform}`;
  _devInfoCache.set(key, { info: sync, ts: Date.now() });
  return sync;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CascadeTapRequest {
  workflowId:    string;
  deviceId:      string;
  stepIndex:     number;
  platform:      string;   // e.g., "instagram"
  elementName:   string;   // e.g., "nav.home", "post.like_button"
  timeoutMs?:    number;
  currentScreen?: string;  // e.g., "own_profile", "following_list" — used by L1.5 DB cache
}

export interface CascadeTapResult {
  success: boolean;
  method: TapMethod;
  fallbackChain: string[];
  coords?: NormalizedCoords;
  error?: string;
  latencyMs: number;
  jobId?: string;
}

interface JobResult {
  status: string;
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

// ─── Pending results for cascade steps ────────────────────────────────────────

const pendingCascadeResults = new Map<string, {
  resolve: (result: JobResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}>();

/**
 * Called by workflow.executor resolveJobResult fallback.
 */
export function resolveCascadeResult(jobId: string, result: JobResult): boolean {
  const pending = pendingCascadeResults.get(jobId);
  if (!pending) return false;
  clearTimeout(pending.timeoutHandle);
  pendingCascadeResults.delete(jobId);
  pending.resolve(result);
  return true;
}

function awaitCascadeResult(jobId: string, timeoutMs: number): Promise<JobResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingCascadeResults.delete(jobId);
      reject(new Error(`Cascade step timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCascadeResults.set(jobId, {
      resolve: (result) => {
        clearTimeout(timeoutHandle);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      },
      timeoutHandle,
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE TAP EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

// NOTE: Shared cascade logic is now consolidated in cascadeCore.ts
// This function and skill.service.ts::cascadeTap() both use cascadeCore utilities.
export async function executeCascadeTap(req: CascadeTapRequest): Promise<CascadeTapResult> {
  const startTime = Date.now();
  const fallbackChain: string[] = [];
  const timeoutMs = req.timeoutMs ?? 30_000;

  console.log(`[cascade] Starting cascade tap: ${req.platform}:${req.elementName} on device ${req.deviceId.slice(0, 8)}`);

  // ─── US-015: Nav pre-check — dismiss keyboard before tapping nav.* elements ───
  // Between preamble and step execution, ~30s can pass during which Instagram
  // may show a keyboard or auto-scroll to Reels. BACK on home_feed is a no-op,
  // so we send it unconditionally for all nav.* elements as a fail-safe.
  if (req.elementName.startsWith("nav.") && req.elementName !== "nav.home") {
    // For nav elements other than home:
    // 1. Send BACK to dismiss keyboard (if open) — keyboard hides nav bar
    // 2. Tap nav.home to ensure we're on Home Feed
    console.log(`[cascade] US-016: nav element detected (${req.elementName}) — BACK + nav.home`);
    try {
      // BACK to dismiss keyboard
      const backJobId = uuidv4();
      const backAdapter = getTransportAdapter();
      if (!backAdapter) throw new Error("Transport not initialized");
      await backAdapter.sendJob(req.deviceId, {
        jobId: backJobId,
        type: "press_key" as import("../../../shared/protocol/messages").JobType,
        params: { key: "back" } as Record<string, unknown>,
        timeoutMs: 2_000,
      }, req.workflowId);
      await awaitCascadeResult(backJobId, 2_500).catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      // Tap nav.home
      const homeJobId = uuidv4();
      const homeAdapter = getTransportAdapter();
      if (!homeAdapter) throw new Error("Transport not initialized");
      await homeAdapter.sendJob(req.deviceId, {
        jobId: homeJobId,
        type: "tap" as import("../../../shared/protocol/messages").JobType,
        params: { x: 0.10, y: 0.912 } as Record<string, unknown>,
        timeoutMs: 3_000,
      }, req.workflowId);
      await awaitCascadeResult(homeJobId, 3_500).catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
      console.log(`[cascade] US-016: BACK + nav.home complete, proceeding with ${req.elementName}`);
    } catch (err) {
      console.warn(`[cascade] US-016: pre-tap failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // Load skill file + element (both may be null — cascade continues to L2)
  const skill = await skillService.loadSkillFile(req.platform);
  if (!skill) {
    fallbackChain.push("L1_skill_not_found");
    console.warn(`[cascade] Skill file not found: ${req.platform} — continuing to L2`);
  }

  const element = skill ? skillService.getElement(skill, req.elementName) : null;
  if (skill && !element) {
    fallbackChain.push("L1_element_not_found");
    console.warn(`[cascade] Element not found in skill: ${req.elementName} — continuing to L2`);
  }

  // ─── Level 1: Skill coords ────────────────────────────────────────────────
  if (element && element.type !== "variable" && element.coords) {
    const coords = element.coords as NormalizedCoords;
    const confidence = getElementConfidence(element);

    if (confidence >= MIN_CONFIDENCE_FOR_COORDS) {
      fallbackChain.push("L1_coords");
      try {
        const jobResult = await executeSkillTapJob(req, coords, timeoutMs);

        if (jobResult.status === "completed") {
          console.log(`[cascade] L1 coords success for ${req.elementName}`);
          const result: CascadeTapResult = {
            success: true,
            method: "coords",
            fallbackChain,
            coords,
            latencyMs: Date.now() - startTime,
          };
          await logNavigation(req, result);
          return result;
        }
        fallbackChain.push("L1_tap_failed");
      } catch (err) {
        fallbackChain.push(`L1_error:${(err as Error).message.slice(0, 50)}`);
      }
    } else {
      fallbackChain.push("L1_low_confidence");
    }
  } else {
    fallbackChain.push("L1_no_coords");
  }

  // ─── L0: DB Persistent Cache (coordinate_cache table) ─────────────────────
  // Registry check: isElementFixed() returns false for variable elements (search results, feed posts).
  // Fixed elements get saved here; variable elements are NEVER persisted.
  if (!isElementFixed(req.platform, req.elementName)) {
    fallbackChain.push("L0_skip_not_fixed");
    console.log(`[cascade] L0 skipped: ${req.elementName} is not in fixed-elements registry`);
  }
  fallbackChain.push("L0_db_cache");
  const devInfo0 = await getDeviceInfoAsync(req.deviceId, req.platform).catch(() => null);
  const screenType0 = req.currentScreen || "unknown";
  if (devInfo0 && isElementFixed(req.platform, req.elementName)) {
    try {
      const cached = await coordCacheService.getCoord(devInfo0, screenType0, req.elementName, MIN_CONFIDENCE_FOR_COORDS);

      if (cached) {
        const coords: NormalizedCoords = { x: cached.x, y: cached.y };
        console.log(`[cascade] L1.5 DB cache hit: ${req.elementName} (conf=${cached.confidence.toFixed(2)})`);
        try {
          const jobResult = await executeSkillTapJob(req, coords, timeoutMs);
          if (jobResult.status === "completed") {
            coordCacheService.incrementSuccess(cached.id).catch(() => {});
            const result: CascadeTapResult = {
              success: true, method: "coords", fallbackChain,
              coords, latencyMs: Date.now() - startTime,
            };
            await logNavigation(req, result);
            return result;
          }
          coordCacheService.incrementFail(cached.id).catch(() => {});
          fallbackChain.push("L0_tap_failed");
        } catch (err) {
          coordCacheService.incrementFail(cached.id).catch(() => {});
          fallbackChain.push(`L0_error:${(err as Error).message.slice(0, 50)}`);
        }
      } else {
        fallbackChain.push("L0_miss");
      }
    } catch (err) {
      fallbackChain.push(`L0_db_error:${(err as Error).message.slice(0, 50)}`);
    }
  } else {
    fallbackChain.push("L0_skipped_not_fixed");
  }

  // ─── Level 2: AccessibilityService ────────────────────────────────────────
  fallbackChain.push("L2_a11y");
  try {
    const a11yResult = await executeA11yFindTapJob(req, element, timeoutMs);

    if (a11yResult.status === "completed" && a11yResult.output?.found) {
      // B1 fix: normalize coords — a11y may return pixel values, orchestrator expects 0-1
      const rawCoords = normalizeCoord(
        a11yResult.output.x as number,
        a11yResult.output.y as number,
        devInfo0?.resolution ?? "1080x2160"
      );
      const newCoords: NormalizedCoords = rawCoords;

      console.log(`[cascade] L2 a11y success for ${req.elementName} → (${newCoords.x.toFixed(3)}, ${newCoords.y.toFixed(3)})`);

      if (isElementFixed(req.platform, req.elementName)) {
        await persistCascadeLearning({
          platform: req.platform, elementName: req.elementName, coords: newCoords, method: "ui_tree",
          deviceId: req.deviceId, workflowId: req.workflowId, screenType: screenType0,
          deviceInfo: devInfo0, element,
        }).catch((error) => console.warn(`[ui-graph] cascade learning failed: ${(error as Error).message}`));
      } else {
        console.log(`[cascade] Skipping DB persistence for non-fixed element: ${req.elementName}`);
      }

      const result: CascadeTapResult = {
        success: true, method: "ui_tree", fallbackChain,
        coords: newCoords, latencyMs: Date.now() - startTime,
      };
      await logNavigation(req, result);
      return result;
    }
    fallbackChain.push("L2_not_found");
  } catch (err) {
    fallbackChain.push(`L2_error:${(err as Error).message.slice(0, 50)}`);
  }

  // ─── Level 2.5: OCR (ML Kit) ──────────────────────────────────────────────
  fallbackChain.push("L2.5_ocr");
  try {
    const searchText = buildOcrSearchText(element);

    if (searchText) {
      console.log(`[cascade] L2.5: OCR find "${searchText}" for ${req.elementName}`);
      const ocrResult = await executeOcrFindTapJob(req, searchText, timeoutMs);

      if (ocrResult.status === "completed" && ocrResult.output?.found) {
        // B1 fix: normalize coords — OCR may return pixel values, orchestrator expects 0-1
        const rawOcrCoords = normalizeCoord(
          ocrResult.output.x as number,
          ocrResult.output.y as number,
          devInfo0?.resolution ?? "1080x2160"
        );
        const newCoords: NormalizedCoords = rawOcrCoords;

        console.log(`[cascade] L2.5 OCR success: "${searchText}" → (${newCoords.x.toFixed(3)}, ${newCoords.y.toFixed(3)})`);
        if (isElementFixed(req.platform, req.elementName)) {
          await persistCascadeLearning({
            platform: req.platform, elementName: req.elementName, coords: newCoords, method: "ocr",
            deviceId: req.deviceId, workflowId: req.workflowId, screenType: screenType0,
            deviceInfo: devInfo0, element,
          }).catch((error) => console.warn(`[ui-graph] cascade learning failed: ${(error as Error).message}`));
        } else {
          console.log(`[cascade] Skipping DB persistence for non-fixed element: ${req.elementName}`);
        }

        const result: CascadeTapResult = {
          success: true, method: "ocr", fallbackChain,
          coords: newCoords, latencyMs: Date.now() - startTime,
        };
        await logNavigation(req, result);
        return result;
      }
      fallbackChain.push("L2.5_ocr_not_found");
    } else {
      fallbackChain.push("L2.5_ocr_no_text");
    }
  } catch (err) {
    fallbackChain.push(`L2.5_ocr_error:${(err as Error).message.slice(0, 50)}`);
  }

  // ─── Level 3: Vision (VLM) ────────────────────────────────────────────────
  // TODO: Implement vision fallback when VLM is integrated
  fallbackChain.push("L3_vision_not_implemented");

  const result: CascadeTapResult = {
    success: false, method: "vision", fallbackChain,
    error: "All cascade levels failed", latencyMs: Date.now() - startTime,
  };
  await logNavigation(req, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOB DISPATCH HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function executeSkillTapJob(
  req: CascadeTapRequest,
  coords: NormalizedCoords,
  timeoutMs: number
): Promise<JobResult> {
  const skillTapAdapter = getTransportAdapter();
  if (!skillTapAdapter) throw new Error("Transport not initialized");
  if (!skillTapAdapter.isDeviceOnline(req.deviceId)) {
    throw new Error(`Device ${req.deviceId} offline`);
  }

  const jobId = uuidv4();
  const params = {
    x: coords.x,
    y: coords.y,
    skillId: `${req.platform}:${req.elementName}`,
    buttonId: req.elementName,
    platform: req.platform,
  };

  // Dispatch to DB
  await dispatcherService.dispatch({
    deviceId: req.deviceId,
    type: "skill_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
    workflowId: req.workflowId,
    stepIndex: req.stepIndex,
  });

  // Send to device
  await skillTapAdapter.sendJob(req.deviceId, {
    jobId,
    type: "skill_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
  }, req.workflowId);

  return awaitCascadeResult(jobId, timeoutMs + 5000);
}

async function executeA11yFindTapJob(
  req: CascadeTapRequest,
  element: import("./types").SkillElement | null,
  timeoutMs: number
): Promise<JobResult> {
  const a11yAdapter = getTransportAdapter();
  if (!a11yAdapter) throw new Error("Transport not initialized");
  if (!a11yAdapter.isDeviceOnline(req.deviceId)) {
    throw new Error(`Device ${req.deviceId} offline`);
  }

  const jobId = uuidv4();
  
  // Build A11y search params from element
  const params: Record<string, unknown> = {};
  
  if (element?.selector) {
    const selector = element.selector;
    
    // Handle object selectors (new format from .skill files)
    if (typeof selector === 'object' && selector !== null) {
      const selectorObj = selector as Record<string, unknown>;
      if (selectorObj.resourceId) {
        params.resourceId = selectorObj.resourceId;
      }
      if (selectorObj.text) {
        params.text = selectorObj.text;
        params.partialMatch = selectorObj.partialMatch ?? true;
      }
      if (selectorObj.text_starts_with) {
        params.text = selectorObj.text_starts_with;
        params.partialMatch = true;
      }
      if (selectorObj.text_contains) {
        params.text = selectorObj.text_contains;
        params.partialMatch = true;
      }
      if (selectorObj.className) {
        params.className = selectorObj.className;
      }
      if (selectorObj.contentDescription) {
        params.contentDescription = selectorObj.contentDescription;
        params.partialMatch = selectorObj.partialMatch ?? true;
      }
    }
    // Handle string selectors (legacy format)
    else if (typeof selector === 'string') {
      if (selector.includes(":id/")) {
        params.resourceId = selector;
      } else if (selector.startsWith("android.") || selector.includes(".widget.")) {
        params.className = selector;
      } else {
        params.text = selector;
        params.partialMatch = true;
      }
    }
  }
  
  // Try alt_selectors if primary didn't match (for hashtag dropdown etc)
  const altSelectors = (element as { alt_selectors?: unknown[] }).alt_selectors;
  if (Object.keys(params).length === 0 && altSelectors && Array.isArray(altSelectors)) {
    for (const altSel of altSelectors) {
      if (typeof altSel === 'object' && altSel !== null) {
        const alt = altSel as Record<string, unknown>;
        if (alt.resourceId) params.resourceId = alt.resourceId;
        if (alt.text) { params.text = alt.text; params.partialMatch = true; }
        if (alt.text_starts_with) { params.text = alt.text_starts_with; params.partialMatch = true; }
        if (alt.className) params.className = alt.className;
        if (alt.contentDescription) { params.contentDescription = alt.contentDescription; params.partialMatch = true; }
        if (Object.keys(params).length > 0) break;
      }
    }
  }

  // Fallback: derive contentDescription from visual_hint or elementName using CD_MAP
  // e.g., "like_button" → "Like", "feed.first_post.like_button" → "Like"
  if (Object.keys(params).length === 0) {
    const hint = (element ? (element as { visual_hint?: string }).visual_hint : null) ?? req.elementName;
    const hintLower = hint.toLowerCase();
    for (const entry of CD_MAP) {
      if (hintLower.includes(entry.pattern)) {
        params.contentDescription = entry.cd;
        params.partialMatch = true;
        console.log(`[cascade] L2 derived contentDescription="${entry.cd}" from "${hint}"`);
        break;
      }
    }
  }

  // Dispatch to DB
  await dispatcherService.dispatch({
    deviceId: req.deviceId,
    type: "a11y_find_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
    workflowId: req.workflowId,
    stepIndex: req.stepIndex,
  });

  // Send to device
  await a11yAdapter.sendJob(req.deviceId, {
    jobId,
    type: "a11y_find_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
  }, req.workflowId);

  return awaitCascadeResult(jobId, timeoutMs + 5000);
}

async function executeOcrFindTapJob(
  req: CascadeTapRequest,
  searchText: string,
  timeoutMs: number
): Promise<JobResult> {
  const ocrAdapter = getTransportAdapter();
  if (!ocrAdapter) throw new Error("Transport not initialized");
  if (!ocrAdapter.isDeviceOnline(req.deviceId)) {
    throw new Error(`Device ${req.deviceId} offline`);
  }

  const jobId = uuidv4();
  const params = {
    searchText,
    partialMatch: false,
  };

  // Dispatch to DB
  await dispatcherService.dispatch({
    deviceId: req.deviceId,
    type: "ocr_find_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
    workflowId: req.workflowId,
    stepIndex: req.stepIndex,
  });

  // Send to device
  await ocrAdapter.sendJob(req.deviceId, {
    jobId,
    type: "ocr_find_tap",
    params: params as unknown as import("../../../shared/protocol/messages").JobParams,
    timeoutMs,
  }, req.workflowId);

  return awaitCascadeResult(jobId, timeoutMs + 5000);
}

// buildOcrSearchTextFromElement is now imported from cascadeCore as buildOcrSearchText

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXTUAL ELEMENT GUARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns true if an element is marked as contextual (position varies per screen context).
 * Contextual elements (e.g., post.like, post.comment) appear in feeds/lists and have
 * dynamic Y positions — caching their coords causes taps in the wrong location.
 */
function isContextualElement(element: import("./types").SkillElement | null | undefined): boolean {
  if (!element) return false;
  return (element as unknown as Record<string, unknown>).contextual === true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-LEARN
// ═══════════════════════════════════════════════════════════════════════════════

async function updateSkillCoords(
  platform: string,
  elementName: string,
  newCoords: NormalizedCoords
): Promise<void> {
  try {
    const skill = await skillService.loadSkillFile(platform);
    if (!skill) return;

    const element = skillService.getElement(skill, elementName);
    if (!element || element.type === "variable") return;

    // Never persist coords for contextual elements (positions vary per feed item)
    if (isContextualElement(element)) {
      console.log(`[cascade] updateSkillCoords: skipped for contextual element ${platform}:${elementName}`);
      return;
    }

    // Registry check: if element is NOT in fixed-elements registry as fixed, skip persistence
    if (!isElementFixed(platform, elementName)) {
      console.log(`[cascade] updateSkillCoords: skipped — ${platform}:${elementName} not in fixed-elements registry`);
      return;
    }

    // B7 fix: support nested button_map structure (e.g., "nav.home" → button_map.nav.home)
    // Old code only looked in fixed_elements/contextual_elements flat keys — always missed.
    // Strategy: use learned_coords section as the canonical store for auto-learned values.
    // This avoids mutating nested button_map structure and survives YAML round-trips.
    if (!skill.learned_coords) {
      skill.learned_coords = {};
    }

    // B3 guard: never persist nav coords in Android nav bar zone
    if (elementName.startsWith("nav.") && newCoords.y > 0.94) {
      console.warn(`[cascade] B3: Skipping auto-learn for ${elementName} y=${newCoords.y.toFixed(3)} (Android nav bar zone)`);
      return;
    }

    skill.learned_coords[elementName] = {
      x: newCoords.x,
      y: newCoords.y,
      confidence: 0.95,
      learned_at: new Date().toISOString(),
    };

    // Also try to update nested button_map in-place for legacy flat structures
    const parts = elementName.split(".");
    let current: Record<string, unknown> = skill.button_map as unknown as Record<string, unknown>;
    let found = false;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] && typeof current[part] === "object") {
        current = current[part] as Record<string, unknown>;
      } else {
        break;
      }
      if (i === parts.length - 2) {
        const leaf = current[parts[parts.length - 1]];
        if (leaf && typeof leaf === "object") {
          (leaf as Record<string, unknown>).coords = newCoords;
          (leaf as Record<string, unknown>).confidence = 0.95;
          found = true;
        }
      }
    }
    // Fallback: legacy flat structures
    if (!found) {
      if (skill.button_map.fixed_elements?.[elementName]) {
        const elem = skill.button_map.fixed_elements[elementName] as unknown as Record<string, unknown>;
        elem.coords = newCoords;
        elem.confidence = 0.95;
      } else if (skill.button_map.contextual_elements?.[elementName]) {
        const elem = skill.button_map.contextual_elements[elementName] as unknown as Record<string, unknown>;
        elem.coords = newCoords;
        elem.confidence = 0.95;
      }
    }

    skill.updated_at = new Date();
    await skillService.saveSkillFile(platform, skill);

    console.log(`[cascade] Auto-learned coords for ${platform}:${elementName} → (${newCoords.x.toFixed(3)}, ${newCoords.y.toFixed(3)})`);
  } catch (err) {
    console.error(`[cascade] Failed to auto-learn coords:`, err);
  }
}

async function persistCascadeLearning(input: {
  platform: string;
  elementName: string;
  coords: NormalizedCoords;
  method: "ui_tree" | "ocr" | "vlm";
  deviceId: string;
  workflowId?: string;
  screenType: string;
  deviceInfo: DeviceInfo | null;
  element: import("./types").SkillElement | null;
}): Promise<void> {
  if (!isElementFixed(input.platform, input.elementName) || isContextualElement(input.element)) return;
  const appId = PLATFORM_TO_PKG[input.platform] || input.platform;
  const context = {
    appId,
    deviceId: input.deviceId,
    workflowId: input.workflowId || null,
    appVersion: input.deviceInfo?.appVersion ?? null,
    deviceClass: input.deviceInfo?.deviceClass ?? "phone",
  };
  const flags = await uiGraphRepository.resolveFlags(context);
  if (flags.mode === "disabled" || !flags.candidateLearning) {
    await updateSkillCoords(input.platform, input.elementName, input.coords);
    if (input.deviceInfo) {
      await coordCacheService.learnCoord({
        deviceInfo: input.deviceInfo,
        screenType: input.screenType,
        elementName: input.elementName,
        x: input.coords.x,
        y: input.coords.y,
        learnMethod: input.method,
        confidence: input.method === "ui_tree" ? 0.95 : input.method === "ocr" ? 0.9 : 0.85,
      });
    }
    return;
  }

  const state = (await uiGraphRepository.loadStates(appId)).find((candidate) => candidate.key === input.screenType);
  if (!state || state.id.startsWith("legacy:")) {
    console.warn(`[ui-graph] cascade candidate skipped: canonical state unavailable for ${appId}:${input.screenType}`);
    return;
  }

  const rawSelector = input.element && typeof input.element.selector === "object" && input.element.selector !== null
    ? input.element.selector as Record<string, unknown>
    : {};
  let strategy = "normalized_coords";
  let selector: Record<string, unknown> = { x: input.coords.x, y: input.coords.y };
  let priority = 1000;
  if (input.method === "ui_tree") {
    if (typeof rawSelector.resourceId === "string") { strategy = "resource_id"; selector = { value: rawSelector.resourceId }; priority = 10; }
    else if (typeof rawSelector.contentDescription === "string") { strategy = "content_description"; selector = { value: rawSelector.contentDescription }; priority = 20; }
    else if (typeof rawSelector.text === "string") { strategy = "text"; selector = { value: rawSelector.text }; priority = 40; }
  }

  const candidateId = await uiGraphLearningLoop.observe({
    appId,
    type: "selector",
    sourceStateId: state.id,
    payload: {
      elementKey: input.elementName,
      strategy,
      selector,
      priority,
      dynamic: false,
      appVersionPattern: input.deviceInfo?.appVersion ? `^${input.deviceInfo.appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` : null,
      deviceClass: input.deviceInfo?.deviceClass ?? "phone",
    },
    evidence: { resolvedCoords: input.coords, resolutionMethod: input.method },
    context,
    discoveryMethod: input.method,
    confidence: input.method === "ui_tree" ? 0.95 : input.method === "ocr" ? 0.9 : 0.85,
    safetyClass: "navigation",
  });
  observeLearningCandidate(appId, "selector", "observed");

  if (input.method === "ui_tree") {
    const decision = await uiGraphLearningLoop.validate({
      candidateId,
      context,
      success: true,
      stateVerified: true,
      evidence: { accessibilityNodeResolved: true },
    });
    observeLearningCandidate(appId, "selector", "validated");
    if (flags.autoPromotion && decision.autoPromotable) {
      await uiGraphLearningLoop.promote(candidateId, "ui_graph_auto_promotion", "Cross-context A11y selector validation threshold met", true);
      observeLearningCandidate(appId, "selector", "promoted");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

async function logNavigation(
  req: CascadeTapRequest,
  result: CascadeTapResult
): Promise<void> {
  try {
    const db = getDb();
    
    // Schema: device_id, app, element_name, method_used, method_attempted_first, 
    //         fallback_chain, coords_used, verified, verify_method
    const coordsUsed = result.coords 
      ? JSON.stringify({ x: result.coords.x, y: result.coords.y })
      : null;
    
    const methodAttemptedFirst = result.fallbackChain.length > 0 
      ? (result.fallbackChain[0].startsWith("L1") ? "coords" : 
         result.fallbackChain[0].startsWith("L2") ? "ui_tree" : "vision")
      : result.method;

    await db.query(
      `INSERT INTO navigation_logs 
       (device_id, app, element_name, method_used, method_attempted_first, fallback_chain, coords_used, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.deviceId,
        req.platform,
        req.elementName,
        result.method,
        methodAttemptedFirst,
        JSON.stringify(result.fallbackChain),
        coordsUsed,
        result.success,  // verified = success (tap was verified to work)
      ]
    );
  } catch (err) {
    // Non-fatal — don't fail the cascade for logging errors
    console.error(`[cascade] Failed to log navigation:`, err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED CASCADE (P2.1)
// ═══════════════════════════════════════════════════════════════════════════════

import type { UnifiedCascadeRequest } from "./types";
import { parseTarget, type ParsedTarget } from "./target-parser";
import { visionService } from "../vision/vision.service";

// Note: parseTarget is defined in target-parser.ts
// This module imports it from there

/**
 * Unified cascade tap — handles both skill refs and text literals.
 * Cascade: L1 coords (skill only) → L2 a11y → L2.5 OCR → L3 VLM
 */
export async function executeUnifiedCascadeTap(req: UnifiedCascadeRequest): Promise<CascadeTapResult> {
  const startTime = Date.now();
  const fallbackChain: string[] = [];
  const timeoutMs = req.timeoutMs ?? 30_000;
  const parsed = parseTarget(req.target);
  
  console.log(`[cascade] Unified tap: ${req.target} (${parsed.type}) on device ${req.deviceId.slice(0, 8)}`);

  // Determine auto-learn behavior
  const shouldLearn = req.learn ?? (parsed.type === 'ref');  // Default: skill=true, text=false
  
  // For skill refs, we need platform
  if (parsed.type === 'ref' && !req.platform) {
    return {
      success: false,
      method: "coords",
      fallbackChain: ["missing_platform"],
      error: "platform required for skill references (@)",
      latencyMs: Date.now() - startTime,
    };
  }

  let element: import("./types").SkillElement | null = null;
  let skill: import("./types").SkillFile | null = null;

  // ─── L1: Skill coords (skill refs only) ─────────────────────────────────────
  if (parsed.type === 'ref') {
    skill = await skillService.loadSkillFile(req.platform!);
    if (!skill) {
      fallbackChain.push("L1_skill_not_found");
    } else {
      element = skillService.getElement(skill, parsed.value);
      if (!element) {
        fallbackChain.push("L1_element_not_found");
      } else if (element.type !== "variable" && (element as any).coords) {
        const coords = (element as any).coords as NormalizedCoords;
        const confidence = getElementConfidence(element);

        if (confidence >= MIN_CONFIDENCE_FOR_COORDS) {
          fallbackChain.push("L1_coords");
          try {
            const jobResult = await executeSkillTapJob(
              { workflowId: req.workflowId || '', deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform!, elementName: parsed.value },
              coords,
              timeoutMs
            );

            if (jobResult.status === "completed") {
              console.log(`[cascade] L1 coords success for ${parsed.value}`);
              const result: CascadeTapResult = {
                success: true,
                method: "coords",
                fallbackChain,
                coords,
                latencyMs: Date.now() - startTime,
              };
              await logNavigation({ workflowId: req.workflowId || '', deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform!, elementName: parsed.value }, result);
              return result;
            }
            fallbackChain.push("L1_tap_failed");
          } catch (err) {
            fallbackChain.push(`L1_error:${(err as Error).message.slice(0, 50)}`);
          }
        } else {
          fallbackChain.push("L1_low_confidence");
        }
      } else {
        fallbackChain.push("L1_no_coords");
      }
    }
  } else {
    fallbackChain.push("L1_skip_text_literal");
  }

  // ─── L1.5: DB Persistent Cache ──────────────────────────────────────────────
  // Registry check: isElementFixed() returns false for variable elements
  const uniPlatform  = req.platform || "unknown";
  if (!isElementFixed(uniPlatform, parsed.value)) {
    fallbackChain.push("L1.5_skip_not_fixed");
    console.log(`[cascade] L1.5 skipped: ${parsed.value} not in fixed-elements registry`);
  }
  fallbackChain.push("L1.5_db_cache");
  const uniScreenType = (req as { currentScreen?: string }).currentScreen || "unknown";
  const uniDevInfo   = await getDeviceInfoAsync(req.deviceId, uniPlatform).catch(() => null);
  if (uniDevInfo && isElementFixed(uniPlatform, parsed.value)) {
    try {
      const cached = await coordCacheService.getCoord(uniDevInfo, uniScreenType, parsed.value, MIN_CONFIDENCE_FOR_COORDS);

      if (cached) {
        const coords: NormalizedCoords = { x: cached.x, y: cached.y };
        const cascadeReq: CascadeTapRequest = {
          workflowId: req.workflowId || "", deviceId: req.deviceId,
          stepIndex: req.stepIndex || 0, platform: uniPlatform, elementName: parsed.value,
        };
        console.log(`[cascade] L1.5 DB cache hit: ${parsed.value} (conf=${cached.confidence.toFixed(2)})`);
        try {
          const jobResult = await executeSkillTapJob(cascadeReq, coords, timeoutMs);
          if (jobResult.status === "completed") {
            coordCacheService.incrementSuccess(cached.id).catch(() => {});
            const result: CascadeTapResult = {
              success: true, method: "coords", fallbackChain,
              coords, latencyMs: Date.now() - startTime,
            };
            if (req.platform) await logNavigation(cascadeReq, result);
            return result;
          }
          coordCacheService.incrementFail(cached.id).catch(() => {});
          fallbackChain.push("L1.5_tap_failed");
        } catch (err) {
          coordCacheService.incrementFail(cached.id).catch(() => {});
          fallbackChain.push(`L1.5_error:${(err as Error).message.slice(0, 50)}`);
        }
      } else {
        fallbackChain.push("L1.5_miss");
      }
    } catch (err) {
      fallbackChain.push(`L1.5_db_error:${(err as Error).message.slice(0, 50)}`);
    }
  } else {
    fallbackChain.push("L1.5_no_ctx");
  }

  // ─── L2: AccessibilityService ───────────────────────────────────────────────
  fallbackChain.push("L2_a11y");
  try {
    const a11yResult = await executeUnifiedA11yTextSearch(req.deviceId, parsed.value, element, timeoutMs);

    if (a11yResult.status === "completed" && a11yResult.output?.found) {
      // B1 fix: normalize coords — a11y may return pixel values, orchestrator expects 0-1
      const newCoords: NormalizedCoords = normalizeCoord(
        a11yResult.output.x as number,
        a11yResult.output.y as number,
        uniDevInfo?.resolution ?? "1080x2160"
      );

      console.log(`[cascade] L2 a11y success: "${parsed.value}" → (${newCoords.x.toFixed(3)}, ${newCoords.y.toFixed(3)})`);

      if (shouldLearn && parsed.type === "ref" && req.platform && isElementFixed(uniPlatform, parsed.value)) {
        await persistCascadeLearning({
          platform: req.platform, elementName: parsed.value, coords: newCoords, method: "ui_tree",
          deviceId: req.deviceId, workflowId: req.workflowId, screenType: uniScreenType,
          deviceInfo: uniDevInfo, element,
        }).catch((error) => console.warn(`[ui-graph] cascade learning failed: ${(error as Error).message}`));
      } else if (!isElementFixed(uniPlatform, parsed.value)) {
        console.log(`[cascade] Skipping DB persistence for non-fixed element: ${parsed.value}`);
      }

      const result: CascadeTapResult = {
        success: true, method: "ui_tree", fallbackChain,
        coords: newCoords, latencyMs: Date.now() - startTime,
      };
      if (req.platform) {
        await logNavigation({ workflowId: req.workflowId || "", deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform, elementName: parsed.value }, result);
      }
      return result;
    }
    fallbackChain.push("L2_not_found");
  } catch (err) {
    fallbackChain.push(`L2_error:${(err as Error).message.slice(0, 50)}`);
  }

  // ─── L2.5: OCR (ML Kit) ─────────────────────────────────────────────────────
  fallbackChain.push("L2.5_ocr");
  try {
    const searchText = parsed.type === "ref" && element
      ? buildOcrSearchText(element) || parsed.value
      : parsed.value;

    console.log(`[cascade] L2.5: OCR find "${searchText}"`);
    const ocrResult = await executeUnifiedOcrFindTapJob(req.deviceId, searchText, timeoutMs);

    if (ocrResult.status === "completed" && ocrResult.output?.found) {
      // B1 fix: normalize coords — OCR may return pixel values, orchestrator expects 0-1
      const newCoords: NormalizedCoords = normalizeCoord(
        ocrResult.output.x as number,
        ocrResult.output.y as number,
        uniDevInfo?.resolution ?? "1080x2160"
      );

      console.log(`[cascade] L2.5 OCR success: "${searchText}" → (${newCoords.x.toFixed(3)}, ${newCoords.y.toFixed(3)})`);

      if (shouldLearn && parsed.type === "ref" && req.platform && isElementFixed(uniPlatform, parsed.value)) {
        await persistCascadeLearning({
          platform: req.platform, elementName: parsed.value, coords: newCoords, method: "ocr",
          deviceId: req.deviceId, workflowId: req.workflowId, screenType: uniScreenType,
          deviceInfo: uniDevInfo, element,
        }).catch((error) => console.warn(`[ui-graph] cascade learning failed: ${(error as Error).message}`));
      } else if (!isElementFixed(uniPlatform, parsed.value)) {
        console.log(`[cascade] Skipping DB persistence for non-fixed element: ${parsed.value}`);
      }

      const result: CascadeTapResult = {
        success: true, method: "ocr", fallbackChain,
        coords: newCoords, latencyMs: Date.now() - startTime,
      };
      if (req.platform) {
        await logNavigation({ workflowId: req.workflowId || "", deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform, elementName: parsed.value }, result);
      }
      return result;
    }
    fallbackChain.push("L2.5_not_found");
  } catch (err) {
    fallbackChain.push(`L2.5_error:${(err as Error).message.slice(0, 50)}`);
  }

  // ─── L3: VLM ────────────────────────────────────────────────────────────────
  fallbackChain.push("L3_vision");
  try {
    const vlmCoords = await executeUnifiedVlmFindElement(req.deviceId, parsed.value, element, timeoutMs);
    
    if (vlmCoords) {
      console.log(`[cascade] L3 VLM success: "${parsed.value}" → (${vlmCoords.x.toFixed(3)}, ${vlmCoords.y.toFixed(3)})`);

      if (shouldLearn && parsed.type === "ref" && req.platform && isElementFixed(uniPlatform, parsed.value)) {
        await persistCascadeLearning({
          platform: req.platform, elementName: parsed.value, coords: vlmCoords, method: "vlm",
          deviceId: req.deviceId, workflowId: req.workflowId, screenType: uniScreenType,
          deviceInfo: uniDevInfo, element,
        }).catch((error) => console.warn(`[ui-graph] cascade learning failed: ${(error as Error).message}`));
      } else if (!isElementFixed(uniPlatform, parsed.value)) {
        console.log(`[cascade] Skipping DB persistence for non-fixed element: ${parsed.value}`);
      }

      const tapSuccess = await executeUnifiedTapAtCoords(req.deviceId, vlmCoords, timeoutMs);
      
      const result: CascadeTapResult = {
        success: tapSuccess,
        method: "vision",
        fallbackChain,
        coords: vlmCoords,
        latencyMs: Date.now() - startTime,
      };
      if (req.platform) {
        await logNavigation({ workflowId: req.workflowId || '', deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform, elementName: parsed.value }, result);
      }
      return result;
    }
    fallbackChain.push("L3_not_found");
  } catch (err) {
    fallbackChain.push(`L3_error:${(err as Error).message.slice(0, 50)}`);
  }

  // All levels failed
  const result: CascadeTapResult = {
    success: false,
    method: "vision",
    fallbackChain,
    error: "All cascade levels failed",
    latencyMs: Date.now() - startTime,
  };
  if (req.platform) {
    await logNavigation({ workflowId: req.workflowId || '', deviceId: req.deviceId, stepIndex: req.stepIndex || 0, platform: req.platform, elementName: parsed.value }, result);
  }
  return result;
}

// ─── Unified Helpers ──────────────────────────────────────────────────────────

async function executeUnifiedA11yTextSearch(
  deviceId: string,
  searchText: string,
  element: import("./types").SkillElement | null,
  timeoutMs: number
): Promise<JobResult> {
  const params: Record<string, unknown> = {};
  
  if (element?.selector) {
    const selector = element.selector;
    
    // Handle object selectors (new format from .skill files)
    if (typeof selector === 'object' && selector !== null) {
      const selectorObj = selector as Record<string, unknown>;
      if (selectorObj.resourceId) {
        params.resourceId = selectorObj.resourceId;
      }
      if (selectorObj.text) {
        params.text = selectorObj.text;
        params.partialMatch = selectorObj.partialMatch ?? true;
      }
      if (selectorObj.text_starts_with) {
        params.text = selectorObj.text_starts_with;
        params.partialMatch = true;
      }
      if (selectorObj.className) {
        params.className = selectorObj.className;
      }
      if (selectorObj.contentDescription) {
        params.contentDescription = selectorObj.contentDescription;
        params.partialMatch = true;
      }
    }
    // Handle string selectors (legacy format)
    else if (typeof selector === 'string') {
      if (selector.includes(":id/")) {
        params.resourceId = selector;
      } else if (selector.startsWith("android.") || selector.includes(".widget.")) {
        params.className = selector;
      } else {
        params.text = selector;
        params.partialMatch = true;
      }
    }
  }
  
  // Try alt_selectors if primary didn't set params
  const altSelectors = element ? (element as { alt_selectors?: unknown[] }).alt_selectors : null;
  if (Object.keys(params).length === 0 && altSelectors && Array.isArray(altSelectors)) {
    for (const altSel of altSelectors) {
      if (typeof altSel === 'object' && altSel !== null) {
        const alt = altSel as Record<string, unknown>;
        if (alt.resourceId) params.resourceId = alt.resourceId;
        if (alt.text) { params.text = alt.text; params.partialMatch = true; }
        if (alt.text_starts_with) { params.text = alt.text_starts_with; params.partialMatch = true; }
        if (alt.className) params.className = alt.className;
        if (Object.keys(params).length > 0) break;
      }
    }
  }
  
  // Fallback to plain text search
  if (Object.keys(params).length === 0) {
    params.text = searchText;
    params.partialMatch = true;
  }

  const jobId = uuidv4();
  await dispatcherService.dispatch({
    deviceId,
    type: "a11y_find_tap",
    params: params as any,
    timeoutMs,
  });
  const uniA11yAdapter = getTransportAdapter();
  if (!uniA11yAdapter) throw new Error("Transport not initialized");
  await uniA11yAdapter.sendJob(deviceId, { jobId, type: "a11y_find_tap", params: params as any, timeoutMs });

  return awaitCascadeResult(jobId, timeoutMs + 5000);
}

async function executeUnifiedOcrFindTapJob(
  deviceId: string,
  searchText: string,
  timeoutMs: number
): Promise<JobResult> {
  const jobId = uuidv4();
  const params = { searchText, partialMatch: true };
  
  await dispatcherService.dispatch({
    deviceId,
    type: "ocr_find_tap",
    params: params as any,
    timeoutMs,
  });
  const uniOcrAdapter = getTransportAdapter();
  if (!uniOcrAdapter) throw new Error("Transport not initialized");
  await uniOcrAdapter.sendJob(deviceId, { jobId, type: "ocr_find_tap", params, timeoutMs });

  return awaitCascadeResult(jobId, timeoutMs + 5000);
}

async function executeUnifiedVlmFindElement(
  deviceId: string,
  searchText: string,
  element: import("./types").SkillElement | null,
  timeoutMs: number
): Promise<NormalizedCoords | null> {
  const screenshotJobId = uuidv4();
  await dispatcherService.dispatch({
    deviceId,
    type: "screenshot_for_vlm",
    params: {},
    timeoutMs: 10000,
  });
  const vlmScreenAdapter = getTransportAdapter();
  if (!vlmScreenAdapter) throw new Error("Transport not initialized");
  await vlmScreenAdapter.sendJob(deviceId, { jobId: screenshotJobId, type: "screenshot_for_vlm", params: {}, timeoutMs: 10000 });
  
  const screenshot = await awaitCascadeResult(screenshotJobId, 10000);
  if (!screenshot.output?.image_base64) return null;

  const visualHint = element?.visual_hint || `UI element containing "${searchText}"`;

  const vlmResult = await visionService.handleVisionRequest({
    jobId: screenshotJobId,
    deviceId,
    screenshotBase64: screenshot.output.image_base64 as string,
    requestType: "element_find",
    actionType: "find_element",
  });

  if (vlmResult.elements?.length > 0) {
    const el = vlmResult.elements[0];
    const screenWidth = (screenshot.output.original_width as number) || 1080;
    const screenHeight = (screenshot.output.original_height as number) || 1920;
    return {
      x: (el.bounds.x + el.bounds.width / 2) / screenWidth,
      y: (el.bounds.y + el.bounds.height / 2) / screenHeight,
    };
  }
  return null;
}

async function executeUnifiedTapAtCoords(
  deviceId: string,
  coords: NormalizedCoords,
  timeoutMs: number
): Promise<boolean> {
  // B5 fix: coords are already normalized (0-1). Multiply by device screen dims.
  // Use device info from cache if available; fall back to OnePlus 5T default (1080x2160).
  // OnePlus 5 (1080x1920) will need its model in MODEL_SCREEN_DIMS to be correct.
  const devInfo = await getDeviceInfoAsync(deviceId, "unknown").catch(() => null);
  const resParts = devInfo?.resolution?.split("x");
  const screenWidth = resParts && resParts.length === 2 ? parseInt(resParts[0], 10) : 1080;
  const screenHeight = resParts && resParts.length === 2 ? parseInt(resParts[1], 10) : 2160;
  const pixelX = Math.round(coords.x * screenWidth);
  const pixelY = Math.round(coords.y * screenHeight);

  const jobId = uuidv4();
  await dispatcherService.dispatch({
    deviceId,
    type: "tap",
    params: { x: pixelX, y: pixelY },
    timeoutMs: 5000,
  });
  const tapAdapter = getTransportAdapter();
  if (!tapAdapter) throw new Error("Transport not initialized");
  await tapAdapter.sendJob(deviceId, { jobId, type: "tap", params: { x: pixelX, y: pixelY }, timeoutMs: 5000 });

  try {
    const result = await awaitCascadeResult(jobId, 5000);
    return result.status === "completed";
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS — logNavigation is exported from skill.service.ts
// ═══════════════════════════════════════════════════════════════════════════════
