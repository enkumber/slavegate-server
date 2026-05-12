/**
 * skills/screen-verify.ts
 * Screen verification and recovery logic using UI tree
 */

import { loadSkillFile } from './skill.service';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ScreenDetectionResult {
  detected: boolean;
  screenName: string | null;
  confidence: number;
  indicators: string[];
  isCritical: boolean;
}

export interface RecoveryAction {
  action: 'back' | 'home' | 'retry' | 'abort';
  reason: string;
  currentScreen: string | null;
  expectedScreen: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN DETECTION
// Detects current screen using UI tree and skill file indicators
// ═══════════════════════════════════════════════════════════════════════════════

export async function detectCurrentScreen(
  uiTree: any,
  platform: string
): Promise<ScreenDetectionResult> {
  const skill = await loadSkillFile(platform) as any;
  
  if (!skill?.screens) {
    return {
      detected: false,
      screenName: null,
      confidence: 0,
      indicators: [],
      isCritical: false,
    };
  }

  // Parse UI tree if needed - handle multiple formats:
  // 1. Job result: { status, output: { uiTree: "..." } }
  // 2. Direct uiTree object
  // 3. String (JSON)
  let tree = uiTree;
  if (uiTree?.output?.uiTree) {
    // Job result format
    tree = typeof uiTree.output.uiTree === 'string'
      ? JSON.parse(uiTree.output.uiTree)
      : uiTree.output.uiTree;
  } else if (uiTree?.uiTree) {
    // Direct wrapper
    tree = typeof uiTree.uiTree === 'string'
      ? JSON.parse(uiTree.uiTree)
      : uiTree.uiTree;
  } else if (typeof uiTree === 'string') {
    tree = JSON.parse(uiTree);
  }
  
  console.log(`[screen-verify] Tree parsed, has children: ${!!tree?.children}, children count: ${tree?.children?.length || 0}`);

  // Extract all resourceIds and texts from visible nodes
  const visibleElements = extractVisibleElements(tree);
  
  console.log(`[screen-verify] Extracted ${visibleElements.resourceIds.size} resourceIds:`, 
    Array.from(visibleElements.resourceIds).slice(0, 10));
  
  // Check each screen definition
  let bestMatch: ScreenDetectionResult = {
    detected: false,
    screenName: null,
    confidence: 0,
    indicators: [],
    isCritical: false,
  };

  for (const [screenName, screenDef] of Object.entries(skill.screens)) {
    const matchResult = matchScreenIndicators(screenDef as any, visibleElements);
    
    if (matchResult.confidence > bestMatch.confidence) {
      bestMatch = {
        detected: true,
        screenName,
        confidence: matchResult.confidence,
        indicators: matchResult.matchedIndicators,
        isCritical: (screenDef as any).critical === true,
      };
    }
  }

  return bestMatch;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY SCREEN (Post-tap verification)
// Checks if we're on the expected screen after an action
// ═══════════════════════════════════════════════════════════════════════════════

export async function verifyScreen(
  uiTree: any,
  platform: string,
  expectedScreen: string
): Promise<{ verified: boolean; actualScreen: string | null; error?: string }> {
  const detection = await detectCurrentScreen(uiTree, platform);
  
  // Check for critical screens first (rate_limited, banned, login)
  if (detection.isCritical) {
    return {
      verified: false,
      actualScreen: detection.screenName,
      error: `Critical screen detected: ${detection.screenName}`,
    };
  }
  
  // Check if we're on expected screen
  if (detection.screenName === expectedScreen) {
    return {
      verified: true,
      actualScreen: detection.screenName,
    };
  }
  
  // Not on expected screen
  return {
    verified: false,
    actualScreen: detection.screenName,
    error: `Expected ${expectedScreen}, got ${detection.screenName || 'unknown'}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY LOGIC
// Determines what action to take when tap fails or lands on wrong screen
// ═══════════════════════════════════════════════════════════════════════════════

export function determineRecoveryAction(
  expectedScreen: string | null,
  actualScreen: string | null,
  isCritical: boolean
): RecoveryAction {
  // Critical screen - abort immediately
  if (isCritical) {
    return {
      action: 'abort',
      reason: `Critical screen detected: ${actualScreen}. Stopping to prevent issues.`,
      currentScreen: actualScreen,
      expectedScreen,
    };
  }

  // No screen detected - probably transitioning, retry
  if (!actualScreen) {
    return {
      action: 'retry',
      reason: 'Could not detect current screen. May be in transition.',
      currentScreen: actualScreen,
      expectedScreen,
    };
  }

  // Landed on different screen - go back
  if (actualScreen !== expectedScreen) {
    return {
      action: 'back',
      reason: `Expected ${expectedScreen}, got ${actualScreen}. Going back.`,
      currentScreen: actualScreen,
      expectedScreen,
    };
  }

  // Should not reach here
  return {
    action: 'retry',
    reason: 'Unknown state',
    currentScreen: actualScreen,
    expectedScreen,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface VisibleElements {
  resourceIds: Set<string>;
  texts: Set<string>;
  contentDescriptions: Set<string>;
}

function extractVisibleElements(tree: any, screenWidth = 1080, screenHeight = 2160): VisibleElements {
  const result: VisibleElements = {
    resourceIds: new Set(),
    texts: new Set(),
    contentDescriptions: new Set(),
  };

  const traverse = (node: any) => {
    if (!node) return;
    
    // For screen detection, we want ALL elements, not just visible ones
    // (element might be off-screen but still in tree, indicating the screen type)
    // Only skip if explicitly marked not visible
    if (node.visible === false) {
      // Still traverse children even if parent is not visible
      const children = node.children || [];
      for (const child of children) {
        traverse(child);
      }
      return;
    }
    
    // Extract data
    const resId = node.resourceId || node.resId || '';
    if (resId) {
      // Store both full and short resourceId
      result.resourceIds.add(resId);
      const shortId = resId.split(':id/')[1];
      if (shortId) result.resourceIds.add(shortId);
    }
    
    if (node.text) result.texts.add(node.text);
    if (node.contentDescription) result.contentDescriptions.add(node.contentDescription);
    
    // Traverse children
    const children = node.children || [];
    for (const child of children) {
      traverse(child);
    }
  };

  traverse(tree);
  return result;
}

function matchScreenIndicators(
  screenDef: { indicators?: any[]; ocr_indicators?: any[]; contentDescription_pattern?: string },
  elements: VisibleElements
): { confidence: number; matchedIndicators: string[] } {
  const matchedIndicators: string[] = [];
  let totalChecks = 0;
  let matches = 0;

  // Check UI tree indicators
  if (screenDef.indicators) {
    for (const indicator of screenDef.indicators) {
      totalChecks++;
      
      if (indicator.resourceId && elements.resourceIds.has(indicator.resourceId)) {
        matches++;
        matchedIndicators.push(`resourceId:${indicator.resourceId}`);
      }
      
      if (indicator.resourceId_contains) {
        for (const resId of elements.resourceIds) {
          if (resId.includes(indicator.resourceId_contains)) {
            matches++;
            matchedIndicators.push(`resourceId_contains:${indicator.resourceId_contains}`);
            break;
          }
        }
      }
      
      if (indicator.text) {
        if (elements.texts.has(indicator.text)) {
          matches++;
          matchedIndicators.push(`text:${indicator.text}`);
        }
      }
      
      if (indicator.text_contains) {
        for (const text of elements.texts) {
          if (text.includes(indicator.text_contains)) {
            matches++;
            matchedIndicators.push(`text_contains:${indicator.text_contains}`);
            break;
          }
        }
      }
    }
  }

  // Check OCR indicators (from text in UI tree)
  if (screenDef.ocr_indicators) {
    for (const indicator of screenDef.ocr_indicators) {
      totalChecks++;
      
      if (indicator.text_contains) {
        for (const text of elements.texts) {
          if (text.toLowerCase().includes(indicator.text_contains.toLowerCase())) {
            matches++;
            matchedIndicators.push(`ocr:${indicator.text_contains}`);
            break;
          }
        }
      }
    }
  }

  // Check contentDescription pattern
  if (screenDef.contentDescription_pattern) {
    totalChecks++;
    const pattern = new RegExp(screenDef.contentDescription_pattern);
    for (const desc of elements.contentDescriptions) {
      if (pattern.test(desc)) {
        matches++;
        matchedIndicators.push(`contentDescription_pattern:${screenDef.contentDescription_pattern}`);
        break;
      }
    }
  }

  const confidence = totalChecks > 0 ? matches / totalChecks : 0;
  
  return { confidence, matchedIndicators };
}
