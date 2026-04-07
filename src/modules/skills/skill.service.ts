/**
 * skills/skill.service.ts
 * Skill file management and cascade navigation (P2)
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { getDb } from '../../db/client';
import { coordCacheService } from './skill-db.service';
import {
  SkillFile,
  SkillElement,
  FixedElement,
  ContextualElement,
  VariableElement,
  NormalizedCoords,
  PixelCoords,
  ScreenResolution,
  TapRequest,
  TapResult,
  TapMethod,
  VerifyRequest,
  VerifyResult,
  CoordinateUpdate,
  MappingReport,
  AUTO_LEARN_THRESHOLD,
  MIN_CONFIDENCE_FOR_COORDS,
} from './types';

// Fix: Use absolute path based on dist/ structure
// Templates are always at dist/modules/skills/templates/ regardless of rootDir weirdness
const SKILLS_DIR = path.resolve(__dirname.replace(/phone-network-server[\/\\]src[\/\\]/, ''), 'templates');

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL FILE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export async function loadSkillFile(platform: string): Promise<SkillFile | null> {
  const filePath = path.join(SKILLS_DIR, `${platform}.skill`);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`[skills] Skill file not found: ${filePath}`);
    return null;
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as SkillFile;
    return parsed;
  } catch (err) {
    console.error(`[skills] Failed to parse skill file: ${filePath}`, err);
    return null;
  }
}

export async function saveSkillFile(platform: string, skill: SkillFile): Promise<void> {
  const filePath = path.join(SKILLS_DIR, `${platform}.skill`);
  const content = yaml.dump(skill, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[skills] Saved skill file: ${filePath}`);
}

export function getElement(skill: SkillFile, elementName: string): SkillElement | null {
  // Support nested element names like "nav.search", "post.like", "profile.follow"
  // Navigate the button_map structure: button_map.nav.search, button_map.post.like, etc.
  
  const parts = elementName.split('.');
  let current: any = skill.button_map;
  
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      // Fallback: check legacy flat structures if they exist
      if (skill.button_map.fixed_elements?.[elementName]) {
        return skill.button_map.fixed_elements[elementName];
      }
      if (skill.button_map.contextual_elements?.[elementName]) {
        return skill.button_map.contextual_elements[elementName];
      }
      if (skill.button_map.variable_elements?.[elementName]) {
        return skill.button_map.variable_elements[elementName];
      }
      return null;
    }
  }
  
  // If we found an object with selector/hint, it's an element
  if (current && typeof current === 'object' && (current.selector || current.hint)) {
    const element = current as SkillElement;
    
    // MERGE learned_coords if available
    const hasLearnedCoords = !!(skill.learned_coords && skill.learned_coords[elementName]);
    console.log(`[skills] getElement ${elementName}: found=${!!current}, hasSelector=${!!current.selector}, hasLearnedCoords=${hasLearnedCoords}`);
    if (skill.learned_coords && skill.learned_coords[elementName]) {
      const learned = skill.learned_coords[elementName];
      (element as any).coords = { x: learned.x, y: learned.y };
      (element as any).confidence = learned.confidence ?? 1.0;
      console.log(`[skills] Merged learned_coords for ${elementName}: x=${learned.x}, y=${learned.y}, conf=${learned.confidence}`);
    }
    
    return element;
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATE CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

export function normalizeCoords(pixel: PixelCoords, resolution: ScreenResolution): NormalizedCoords {
  return {
    x: pixel.x / resolution.width,
    y: pixel.y / resolution.height,
  };
}

export function denormalizeCoords(normalized: NormalizedCoords, resolution: ScreenResolution): PixelCoords {
  return {
    x: Math.round(normalized.x * resolution.width),
    y: Math.round(normalized.y * resolution.height),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE TAP
// ═══════════════════════════════════════════════════════════════════════════════

// NOTE: Shared cascade logic is now consolidated in cascadeCore.ts
// Import utils for consistency.
import {
  buildOcrSearchText,
  buildCompleteA11yParams,
  isElementFixed,
} from "./cascadeCore";
import type { DeviceInfo } from "./skill-db.service";

export async function cascadeTap(
  request: TapRequest,
  uiTreeProvider: (deviceId: string) => Promise<any>,
  ocrProvider: ((deviceId: string, searchText: string) => Promise<NormalizedCoords | null>) | undefined,
  visionProvider: (deviceId: string, visualHint: string) => Promise<NormalizedCoords | null>,
  tapExecutor: (deviceId: string, coords: NormalizedCoords) => Promise<boolean>
): Promise<TapResult> {
  const startTime = Date.now();
  const fallbackChain: string[] = [];

  // ─── Load device info for L0 DB lookup ──────────────────────────────────────
  const deviceInfo = await getDeviceInfoForApp(request.app, request.device_id);

  // ─── L0: DB Persistent Cache (coordinate_cache table) ────────────────────────
  // Check DB first — persistent across restarts. Skip for variable elements.
  fallbackChain.push('L0_db_lookup');
  try {
    const cached = await coordCacheService.getCoord(
      deviceInfo,
      'unknown',  // screenType: cascade tap doesn't know current screen
      request.element_name,
      MIN_CONFIDENCE_FOR_COORDS,
    );
    if (cached) {
      const coords: NormalizedCoords = { x: cached.x, y: cached.y };
      console.log(`[cascade] L0 DB cache hit: ${request.element_name} (conf=${cached.confidence.toFixed(2)})`);
      try {
        const success = await tapExecutor(request.device_id, coords);
        if (success) {
          coordCacheService.incrementSuccess(cached.id).catch(() => {});
          return {
            success: true,
            method_used: 'coords',
            method_attempted_first: 'coords',
            fallback_chain: fallbackChain,
            coords_used: coords,
            latency_ms: Date.now() - startTime,
          };
        }
        coordCacheService.incrementFail(cached.id).catch(() => {});
        fallbackChain.push('L0_tap_failed');
      } catch (err) {
        coordCacheService.incrementFail(cached.id).catch(() => {});
        fallbackChain.push(`L0_error:${(err as Error).message.slice(0, 30)}`);
      }
    } else {
      fallbackChain.push('L0_miss');
    }
  } catch (err) {
    fallbackChain.push(`L0_db_error:${(err as Error).message.slice(0, 30)}`);
    console.warn(`[cascade] L0 DB lookup error: ${err}`);
  }

  // ─── Load skill file ────────────────────────────────────────────────────────
  const skill = await loadSkillFile(request.app);
  if (!skill) {
    return {
      success: false,
      method_used: 'coords',
      method_attempted_first: 'L0',
      fallback_chain: fallbackChain,
      latency_ms: Date.now() - startTime,
      error: `Skill file not found for ${request.app}`,
    };
  }

  const element = getElement(skill, request.element_name);
  if (!element) {
    return {
      success: false,
      method_used: 'coords',
      method_attempted_first: 'L0',
      fallback_chain: fallbackChain,
      latency_ms: Date.now() - startTime,
      error: `Element not found: ${request.element_name}`,
    };
  }

  // ─── L1: Skill file coords ──────────────────────────────────────────────────
  if (element.type !== 'variable') {
    const fixedOrContextual = element as FixedElement | ContextualElement;
    const confidence = fixedOrContextual.confidence ?? 0;

    if (fixedOrContextual.coords && confidence >= MIN_CONFIDENCE_FOR_COORDS) {
      try {
        const success = await tapExecutor(request.device_id, fixedOrContextual.coords);
        if (success) {
          return {
            success: true,
            method_used: 'coords',
            method_attempted_first: 'L0',
            fallback_chain: fallbackChain,
            coords_used: fixedOrContextual.coords,
            latency_ms: Date.now() - startTime,
          };
        }
        fallbackChain.push('L1_coords_failed');
      } catch (err) {
        fallbackChain.push('L1_coords_error');
      }
    } else {
      fallbackChain.push('L1_low_confidence');
    }
  } else {
    fallbackChain.push('L1_variable_element');
  }

  // ─── L2: UI Tree ────────────────────────────────────────────────────────────
  fallbackChain.push('L2_ui_tree');
  try {
    const uiTree = await uiTreeProvider(request.device_id);
    const foundCoords = findElementInUiTree(uiTree, element.selector);

    if (foundCoords) {
      console.log(`[cascade] L2 ui_tree hit: ${request.element_name} → (${foundCoords.x.toFixed(3)}, ${foundCoords.y.toFixed(3)})`);
      try {
        const success = await tapExecutor(request.device_id, foundCoords);
        if (success) {
          // Save to DB if element is fixed (registry check)
          if (isElementFixed(request.app, request.element_name)) {
            await coordCacheService.learnCoord({
              deviceInfo,
              screenType: 'unknown',
              elementName: request.element_name,
              x: foundCoords.x,
              y: foundCoords.y,
              learnMethod: 'ui_tree',
              confidence: 0.95,
            }).catch(() => {});
          }
          return {
            success: true,
            method_used: 'ui_tree',
            method_attempted_first: 'L0',
            fallback_chain: fallbackChain,
            coords_used: foundCoords,
            latency_ms: Date.now() - startTime,
          };
        }
        fallbackChain.push('L2_tap_failed');
      } catch (err) {
        fallbackChain.push(`L2_error:${(err as Error).message.slice(0, 30)}`);
      }
    } else {
      fallbackChain.push('L2_not_found');
    }
  } catch (err) {
    fallbackChain.push(`L2_error:${(err as Error).message.slice(0, 30)}`);
  }

  // ─── L3: OCR (ML Kit) ──────────────────────────────────────────────────────
  if (ocrProvider) {
    fallbackChain.push('L3_ocr');
    const searchText = buildOcrSearchText(element);
    if (searchText) {
      try {
        console.log(`[cascade] L3 OCR find "${searchText}" for ${request.element_name}`);
        const ocrCoords = await ocrProvider(request.device_id, searchText);
        if (ocrCoords) {
          try {
            const success = await tapExecutor(request.device_id, ocrCoords);
            if (success) {
              if (isElementFixed(request.app, request.element_name)) {
                await coordCacheService.learnCoord({
                  deviceInfo,
                  screenType: 'unknown',
                  elementName: request.element_name,
                  x: ocrCoords.x,
                  y: ocrCoords.y,
                  learnMethod: 'ocr',
                  confidence: 0.90,
                }).catch(() => {});
              }
              return {
                success: true,
                method_used: 'ocr',
                method_attempted_first: 'L0',
                fallback_chain: fallbackChain,
                coords_used: ocrCoords,
                latency_ms: Date.now() - startTime,
              };
            }
            fallbackChain.push('L3_tap_failed');
          } catch (err) {
            fallbackChain.push(`L3_error:${(err as Error).message.slice(0, 30)}`);
          }
        } else {
          fallbackChain.push('L3_not_found');
        }
      } catch (err) {
        fallbackChain.push(`L3_ocr_error:${(err as Error).message.slice(0, 30)}`);
      }
    } else {
      fallbackChain.push('L3_no_search_text');
    }
  }

  // ─── L4: Vision (VLM) ──────────────────────────────────────────────────────
  fallbackChain.push('L4_vision');
  try {
    const visionCoords = await visionProvider(request.device_id, element.visual_hint);
    if (visionCoords) {
      try {
        const success = await tapExecutor(request.device_id, visionCoords);
        if (success) {
          if (isElementFixed(request.app, request.element_name)) {
            await coordCacheService.learnCoord({
              deviceInfo,
              screenType: 'unknown',
              elementName: request.element_name,
              x: visionCoords.x,
              y: visionCoords.y,
              learnMethod: 'vlm',
              confidence: 0.85,
            }).catch(() => {});
          }
          return {
            success: true,
            method_used: 'vision',
            method_attempted_first: 'L0',
            fallback_chain: fallbackChain,
            coords_used: visionCoords,
            latency_ms: Date.now() - startTime,
          };
        }
        fallbackChain.push('L4_tap_failed');
      } catch (err) {
        fallbackChain.push(`L4_error:${(err as Error).message.slice(0, 30)}`);
      }
    } else {
      fallbackChain.push('L4_not_found');
    }
  } catch (err) {
    fallbackChain.push(`L4_error:${(err as Error).message.slice(0, 30)}`);
  }

  // All levels failed
  return {
    success: false,
    method_used: 'vision',
    method_attempted_first: 'L0',
    fallback_chain: fallbackChain,
    latency_ms: Date.now() - startTime,
    error: 'All cascade levels failed',
  };
}

/**
 * Fetch device info for an app from DB (resolution, app version, etc.).
 * Used for L0 DB coordinate cache lookup.
 */
async function getDeviceInfoForApp(app: string, deviceId: string): Promise<DeviceInfo> {
  const defaults: DeviceInfo = {
    app,
    appVersion: 'unknown',
    resolution: '1080x2160',
    deviceClass: 'phone',
    orientation: 'portrait',
    fontScaleBucket: 'normal',
  };

  try {
    const db = getDb();
    const row = await db.query<Record<string, unknown>>(
      `SELECT health, agent_version FROM devices WHERE id = $1`, [deviceId],
    );
    if (!row.rows.length) return defaults;

    const health = (row.rows[0].health as Record<string, unknown>) || {};
    const info: DeviceInfo = {
      app,
      appVersion: (typeof health.appVersion === 'string' ? health.appVersion : row.rows[0].agent_version) as string || 'unknown',
      resolution: typeof health.screenResolution === 'string'
        ? health.screenResolution
        : (health.screenWidth && health.screenHeight ? `${health.screenWidth}x${health.screenHeight}` : '1080x2160'),
      density: typeof health.density === 'number' ? health.density : undefined,
      deviceClass: 'phone',
      orientation: 'portrait',
      fontScaleBucket: 'normal',
    };
    return info;
  } catch {
    return defaults;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASCADE VERIFY
// ═══════════════════════════════════════════════════════════════════════════════

export async function cascadeVerify(
  request: VerifyRequest,
  uiTreeProvider: (deviceId: string) => Promise<any>,
  visionVerifier: (deviceId: string, expectedScreen: string) => Promise<boolean>
): Promise<VerifyResult> {
  const startTime = Date.now();
  
  // ─── VERIFY 1: UI Tree diff ─────────────────────────────────────────────────
  try {
    const uiTree = await uiTreeProvider(request.device_id);
    const skill = await loadSkillFile(request.app);
    
    if (skill && skill.navigation?.[request.expected_screen]) {
      const expectedElements = skill.navigation?.[request.expected_screen].elements;
      const found = expectedElements.some(pattern => {
        // Simple pattern matching for now
        return findElementInUiTree(uiTree, pattern) !== null;
      });
      
      if (found) {
        return {
          success: true,
          method_used: 'ui_tree',
          latency_ms: Date.now() - startTime,
        };
      }
    }
  } catch (err) {
    // Fall through to vision
  }
  
  // ─── VERIFY 2: Vision check ─────────────────────────────────────────────────
  try {
    const verified = await visionVerifier(request.device_id, request.expected_screen);
    return {
      success: verified,
      method_used: 'vision',
      latency_ms: Date.now() - startTime,
      error: verified ? undefined : 'Vision verification failed',
    };
  } catch (err) {
    return {
      success: false,
      method_used: 'vision',
      latency_ms: Date.now() - startTime,
      error: `Vision error: ${(err as Error).message}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-LEARN COORDS
// ═══════════════════════════════════════════════════════════════════════════════

async function logCoordinateUpdate(
  request: TapRequest,
  element: SkillElement,
  newCoords: NormalizedCoords,
  appVersion: string
): Promise<void> {
  // Only auto-learn for fixed and contextual elements
  if (element.type === 'variable') return;

  // Delegate to coordCacheService — coordinate_updates table no longer exists.
  coordCacheService.learnCoord({
    deviceInfo: {
      app:        request.app,
      appVersion: appVersion || 'unknown',
      resolution: '1080x2160',  // cascade caller doesn't pass resolution; use safe default
    },
    screenType:  'unknown',
    elementName: request.element_name,
    x:           newCoords.x,
    y:           newCoords.y,
    learnMethod: 'ui_tree',
    confidence:  0.95,
  }).catch((err: Error) => {
    console.error(`[skills] logCoordinateUpdate delegate error: ${err.message}`);
  });
}

// applyCoordinateUpdate — no longer needed; coordCacheService handles persistence.
// Kept as no-op to avoid breaking any lingering internal call sites.
async function applyCoordinateUpdate(
  _app:         string,
  _elementName: string,
  _newCoords:   NormalizedCoords,
  _updateId:    string
): Promise<void> {
  // No-op: coordinate_updates table removed in migration 020.
  // Learning is now handled exclusively by coordCacheService.learnCoord().
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export async function logNavigation(
  deviceId: string,
  app: string,
  elementName: string,
  result: TapResult
): Promise<void> {
  const db = getDb();
  
  await db.query(`
    INSERT INTO navigation_logs (device_id, app, element_name, method_used, method_attempted_first, fallback_chain, coords_used, verified)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    deviceId,
    app,
    elementName,
    result.method_used,
    result.method_attempted_first,
    JSON.stringify(result.fallback_chain),
    result.coords_used ? JSON.stringify(result.coords_used) : null,
    result.success,
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function findElementInUiTree(uiTree: any, selector: any): NormalizedCoords | null {
  // Handle both string and object selectors from skill files
  // Object selector: { resourceId: "...", contentDescription: "...", className: "..." }
  // String selector: "com.instagram.android:id/..."
  
  if (!uiTree) return null;
  
  // Handle different UI tree formats - may come from job result or direct tree
  let tree = uiTree;
  
  // If this is a job result (has output.uiTree), extract the actual tree
  if (uiTree.output?.uiTree) {
    tree = typeof uiTree.output.uiTree === 'string' 
      ? JSON.parse(uiTree.output.uiTree) 
      : uiTree.output.uiTree;
  } else if (typeof uiTree.uiTree === 'string') {
    tree = JSON.parse(uiTree.uiTree);
  }
  
  // Get the root children - tree might be the root node itself
  const nodes = tree.children || tree.nodes || (Array.isArray(tree) ? tree : [tree]);
  if (!nodes || nodes.length === 0) return null;
  
  const matchesSelector = (node: any, sel: any): boolean => {
    // UI tree can use either 'resourceId' or 'resId' depending on source
    const nodeResId = node.resourceId || node.resId || '';
    const nodeDesc = node.contentDescription || node.desc || '';
    
    if (typeof sel === 'string') {
      return nodeResId === sel || node.className === sel || node.text === sel;
    }
    // Object selector - match any specified property
    if (sel.resourceId) {
      const searchId = sel.resourceId.split(':id/')[1] || sel.resourceId;
      if (nodeResId.includes(searchId)) return true;
    }
    if (sel.contentDescription && nodeDesc.toLowerCase().includes(sel.contentDescription.toLowerCase())) return true;
    if (sel.className && (node.className === sel.className || node.cls === sel.className)) return true;
    if (sel.text && node.text?.includes(sel.text)) return true;
    return false;
  };
  
  // Helper to check if element is visible on screen
  const isVisibleOnScreen = (node: any, screenW: number, screenH: number): boolean => {
    const bounds = node.bounds || {};
    const left = bounds.left ?? bounds.l ?? 0;
    const right = bounds.right ?? bounds.r ?? 0;
    const top = bounds.top ?? bounds.t ?? 0;
    const bottom = bounds.bottom ?? bounds.b ?? 0;
    
    // Must have positive bounds within screen
    if (left < 0 || right < 0 || top < 0) return false;
    if (left > screenW || right > screenW) return false;
    if (top > screenH || bottom > screenH) return false;
    
    // Check visible flag if present
    if (node.visible === false) return false;
    
    return true;
  };
  
  const screenW = uiTree.screenWidth || 1080;
  const screenH = uiTree.screenHeight || 2160;
  
  const findNode = (nodeList: any[], sel: any): any => {
    for (const node of nodeList) {
      // Only match if element is visible on screen
      if (matchesSelector(node, sel) && isVisibleOnScreen(node, screenW, screenH)) {
        return node;
      }
      const children = node.children || [];
      if (children.length > 0) {
        const found = findNode(children, sel);
        if (found) return found;
      }
    }
    return null;
  };
  
  const node = findNode(Array.isArray(nodes) ? nodes : [nodes], selector);
  if (!node) return null;
  
  // Handle different bounds formats
  const bounds = node.bounds || {};
  const left = bounds.left ?? bounds.l ?? 0;
  const top = bounds.top ?? bounds.t ?? 0;
  const right = bounds.right ?? bounds.r ?? 0;
  const bottom = bounds.bottom ?? bounds.b ?? 0;
  
  if (right === 0 && bottom === 0) return null;
  
  // Calculate center coords
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  
  // Normalize based on screen size (from UI tree root or defaults)
  const screenWidth = uiTree.screenWidth || 1080;
  const screenHeight = uiTree.screenHeight || 2160; // Updated for modern phones
  
  return {
    x: centerX / screenWidth,
    y: centerY / screenHeight,
  };
}
