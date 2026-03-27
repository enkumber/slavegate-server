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

const SKILLS_DIR = path.join(__dirname, 'templates');

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
// Import buildOcrSearchText from there for consistency.
import { buildOcrSearchText } from "./cascadeCore";

export async function cascadeTap(
  request: TapRequest,
  uiTreeProvider: (deviceId: string) => Promise<any>,
  ocrProvider: ((deviceId: string, searchText: string) => Promise<NormalizedCoords | null>) | undefined,
  visionProvider: (deviceId: string, visualHint: string) => Promise<NormalizedCoords | null>,
  tapExecutor: (deviceId: string, coords: NormalizedCoords) => Promise<boolean>
): Promise<TapResult> {
  const startTime = Date.now();
  const fallbackChain: string[] = [];
  
  const skill = await loadSkillFile(request.app);
  if (!skill) {
    return {
      success: false,
      method_used: 'coords',
      method_attempted_first: 'coords',
      fallback_chain: ['skill_not_found'],
      latency_ms: Date.now() - startTime,
      error: `Skill file not found for ${request.app}`,
    };
  }
  
  const element = getElement(skill, request.element_name);
  if (!element) {
    return {
      success: false,
      method_used: 'coords',
      method_attempted_first: 'coords',
      fallback_chain: ['element_not_found'],
      latency_ms: Date.now() - startTime,
      error: `Element not found: ${request.element_name}`,
    };
  }
  
  // ─── LEVEL 1: Coords (if available and confident) ───────────────────────────
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
            method_attempted_first: 'coords',
            fallback_chain: fallbackChain,
            coords_used: fixedOrContextual.coords,
            latency_ms: Date.now() - startTime,
          };
        }
        fallbackChain.push('coords_failed');
      } catch (err) {
        fallbackChain.push('coords_error');
      }
    } else {
      fallbackChain.push('coords_low_confidence');
    }
  }
  
  // ─── LEVEL 2: UI Tree ───────────────────────────────────────────────────────
  try {
    console.log(`[cascade] L2: Getting UI tree for ${request.element_name}`);
    let uiTree;
    try {
      uiTree = await uiTreeProvider(request.device_id);
      console.log(`[cascade] L2: UI tree received, keys: ${Object.keys(uiTree || {}).slice(0, 5)}`);
    } catch (providerErr) {
      console.error(`[cascade] L2: UI tree provider error:`, providerErr);
      throw providerErr;
    }
    console.log(`[cascade] L2: Selector type: ${typeof element.selector}, value: ${JSON.stringify(element.selector).slice(0, 100)}`);
    const foundCoords = findElementInUiTree(uiTree, element.selector);
    console.log(`[cascade] L2: Found coords: ${JSON.stringify(foundCoords)}`);
    
    if (foundCoords) {
      const success = await tapExecutor(request.device_id, foundCoords);
      if (success) {
        // Auto-learn: log coordinate update
        await logCoordinateUpdate(request, element, foundCoords, skill.app_version);
        
        return {
          success: true,
          method_used: 'ui_tree',
          method_attempted_first: element.type === 'variable' ? 'ui_tree' : 'coords',
          fallback_chain: fallbackChain,
          coords_used: foundCoords,
          latency_ms: Date.now() - startTime,
        };
      }
      fallbackChain.push('ui_tree_tap_failed');
    } else {
      fallbackChain.push('ui_tree_not_found');
    }
  } catch (err) {
    fallbackChain.push('ui_tree_error');
  }
  
  // ─── LEVEL 2.5: OCR (ML Kit) ────────────────────────────────────────────────
  if (ocrProvider) {
    try {
      const searchText = buildOcrSearchText(element);

      if (searchText) {
        console.log(`[cascade] L2.5: OCR find "${searchText}" for ${request.element_name}`);
        const ocrCoords = await ocrProvider(request.device_id, searchText);

        if (ocrCoords) {
          const success = await tapExecutor(request.device_id, ocrCoords);
          if (success) {
            await logCoordinateUpdate(request, element, ocrCoords, skill.app_version);
            return {
              success: true,
              method_used: 'ocr',
              method_attempted_first: element.type === 'variable' ? 'ui_tree' : 'coords',
              fallback_chain: fallbackChain,
              coords_used: ocrCoords,
              latency_ms: Date.now() - startTime,
            };
          }
          fallbackChain.push('ocr_tap_failed');
        } else {
          fallbackChain.push('ocr_not_found');
        }
      } else {
        fallbackChain.push('ocr_no_search_text');
      }
    } catch (err) {
      fallbackChain.push('ocr_error');
    }
  }

  // ─── LEVEL 3: Vision ────────────────────────────────────────────────────────
  try {
    const visionCoords = await visionProvider(request.device_id, element.visual_hint);
    
    if (visionCoords) {
      const success = await tapExecutor(request.device_id, visionCoords);
      if (success) {
        // Auto-learn: log coordinate update
        await logCoordinateUpdate(request, element, visionCoords, skill.app_version);
        
        return {
          success: true,
          method_used: 'vision',
          method_attempted_first: element.type === 'variable' ? 'ui_tree' : 'coords',
          fallback_chain: fallbackChain,
          coords_used: visionCoords,
          latency_ms: Date.now() - startTime,
        };
      }
      fallbackChain.push('vision_tap_failed');
    } else {
      fallbackChain.push('vision_not_found');
    }
  } catch (err) {
    fallbackChain.push('vision_error');
  }
  
  // All methods failed
  return {
    success: false,
    method_used: 'vision',
    method_attempted_first: element.type === 'variable' ? 'ui_tree' : 'coords',
    fallback_chain: fallbackChain,
    latency_ms: Date.now() - startTime,
    error: 'All cascade levels failed',
  };
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
  
  const findNode = (nodeList: any[], sel: any): any => {
    for (const node of nodeList) {
      if (matchesSelector(node, sel)) {
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
