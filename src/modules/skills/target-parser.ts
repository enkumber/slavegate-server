/**
 * skills/target-parser.ts
 * Unified target parsing and session-level learning for cascade-tap.
 * 
 * Target syntax:
 *   - "@nav.home" → skill reference (lookup in skill file)
 *   - "diana"    → text literal (search directly)
 *   - "\\@user"  → escaped @ (literal @user)
 */

import type { NormalizedCoords } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// Extended ParsedTarget with originalTarget field (compatible with types.ts)
export interface ParsedTarget {
  type: "ref" | "literal";  // "ref" maps to "skill", "literal" maps to "text" in types.ts
  value: string;            // "nav.home" or "diana"
  originalTarget: string;   // "@nav.home" or "diana"
}

export interface SessionLearnedCoords {
  coords: NormalizedCoords;
  timestamp: number;
  hits: number;
  platform?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a target string into type and value.
 * 
 * @example
 * parseTarget("@nav.home")   → { type: "ref", value: "nav.home" }
 * parseTarget("diana")       → { type: "literal", value: "diana" }
 * parseTarget("\\@username") → { type: "literal", value: "@username" }
 */
export function parseTarget(target: string): ParsedTarget {
  if (!target || typeof target !== "string") {
    throw new Error("Target must be a non-empty string");
  }
  
  const trimmed = target.trim();
  
  // Escaped @ at start → literal with @
  if (trimmed.startsWith("\\@")) {
    return {
      type: "literal",
      value: trimmed.slice(1), // Remove backslash, keep @
      originalTarget: target,
    };
  }
  
  // @ prefix → skill reference
  if (trimmed.startsWith("@")) {
    const value = trimmed.slice(1); // Remove @
    if (!value) {
      throw new Error("Skill reference cannot be empty (@)");
    }
    return {
      type: "ref",
      value,
      originalTarget: target,
    };
  }
  
  // No prefix → text literal
  return {
    type: "literal",
    value: trimmed,
    originalTarget: target,
  };
}

/**
 * Check if target is a skill reference.
 */
export function isSkillRef(target: string): boolean {
  return target.trim().startsWith("@") && !target.trim().startsWith("\\@");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION-LEVEL LEARNING
// ═══════════════════════════════════════════════════════════════════════════════

// In-memory store for session-learned coords (text literals)
// Key format: "platform:textLiteral" or "unknown:textLiteral"
const sessionLearningStore = new Map<string, SessionLearnedCoords>();

// TTL: 1 hour in milliseconds
const SESSION_LEARNING_TTL_MS = 60 * 60 * 1000;

// Cleanup interval: run every 10 minutes
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cleanup interval for expired session learning entries.
 */
export function startSessionLearningCleanup(): void {
  if (cleanupInterval) return;
  
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of sessionLearningStore.entries()) {
      if (now - entry.timestamp > SESSION_LEARNING_TTL_MS) {
        sessionLearningStore.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[session-learning] Cleaned ${cleaned} expired entries, ${sessionLearningStore.size} remaining`);
    }
  }, 10 * 60 * 1000); // Every 10 minutes
}

/**
 * Stop the cleanup interval.
 */
export function stopSessionLearningCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Generate key for session learning store.
 */
function makeSessionKey(textLiteral: string, platform?: string): string {
  const p = platform?.toLowerCase() || "unknown";
  return `${p}:${textLiteral.toLowerCase()}`;
}

/**
 * Get session-learned coords for a text literal.
 * Returns null if not found or expired.
 */
export function getSessionLearnedCoords(
  textLiteral: string, 
  platform?: string
): NormalizedCoords | null {
  const key = makeSessionKey(textLiteral, platform);
  const entry = sessionLearningStore.get(key);
  
  if (!entry) return null;
  
  // Check TTL
  if (Date.now() - entry.timestamp > SESSION_LEARNING_TTL_MS) {
    sessionLearningStore.delete(key);
    return null;
  }
  
  // Increment hit count
  entry.hits++;
  
  return entry.coords;
}

/**
 * Store session-learned coords for a text literal.
 */
export function setSessionLearnedCoords(
  textLiteral: string,
  coords: NormalizedCoords,
  platform?: string
): void {
  const key = makeSessionKey(textLiteral, platform);
  
  const existing = sessionLearningStore.get(key);
  if (existing) {
    // Update existing entry
    existing.coords = coords;
    existing.timestamp = Date.now();
    existing.hits++;
    console.log(`[session-learning] Updated coords for "${textLiteral}" (hits: ${existing.hits})`);
  } else {
    // New entry
    sessionLearningStore.set(key, {
      coords,
      timestamp: Date.now(),
      hits: 1,
      platform,
    });
    console.log(`[session-learning] Learned coords for "${textLiteral}": (${coords.x.toFixed(3)}, ${coords.y.toFixed(3)})`);
  }
}

/**
 * Clear all session-learned coords (for testing or restart).
 */
export function clearSessionLearning(): void {
  const size = sessionLearningStore.size;
  sessionLearningStore.clear();
  console.log(`[session-learning] Cleared ${size} entries`);
}

/**
 * Get session learning stats.
 */
export function getSessionLearningStats(): {
  count: number;
  entries: Array<{ key: string; hits: number; ageMs: number }>;
} {
  const now = Date.now();
  const entries: Array<{ key: string; hits: number; ageMs: number }> = [];
  
  for (const [key, entry] of sessionLearningStore.entries()) {
    entries.push({
      key,
      hits: entry.hits,
      ageMs: now - entry.timestamp,
    });
  }
  
  return {
    count: sessionLearningStore.size,
    entries: entries.sort((a, b) => b.hits - a.hits),
  };
}

// Start cleanup on module load
startSessionLearningCleanup();
