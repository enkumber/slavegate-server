/**
 * hbe/behavioral-drift.ts
 * Behavioral drift — accounts evolve from new user to mature user.
 * Affects timing, engagement, and error simulation over account lifetime.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §3 (HBE)
 *
 * Lifecycle:
 * - Days 0-14:  warmup — slow, hesitant, low engagement, high error rate
 * - Days 14-60: growth — increasing engagement, normalizing speed
 * - Days 60+:   mature — confident, higher engagement, natural patterns
 */

import { clamp } from "./distributions";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriftProfile {
  phase:                  "warmup" | "growth" | "mature";
  agedays:                number;
  timingMultiplier:       number;  // >1 = slower (warmup), ~1 = normal (mature)
  engagementMultiplier:   number;  // engagement probability scale
  errorRateMultiplier:    number;  // error simulation scale
  sessionLengthMultiplier: number; // session duration scale
  dailySessionsMax:       number;  // max sessions per day
}

// ─── Phase boundaries ─────────────────────────────────────────────────────────

const WARMUP_DAYS = 14;
const GROWTH_DAYS = 60;

// ─── Drift calculation ────────────────────────────────────────────────────────

/**
 * Calculate drift profile based on account age.
 * Uses smooth S-curve interpolation (sigmoid-like) between phases.
 */
export function getDriftProfile(accountAgeDays: number): DriftProfile {
  const age = Math.max(0, accountAgeDays);

  if (age < WARMUP_DAYS) {
    // Warmup: slow progress from day 0 to day 14
    const progress = age / WARMUP_DAYS; // 0.0 → 1.0
    const smooth   = smoothstep(progress);
    return {
      phase:                   "warmup",
      agedays:                 age,
      timingMultiplier:        lerp(1.8, 1.3, smooth),   // Very slow → less slow
      engagementMultiplier:    lerp(0.2, 0.5, smooth),   // Very low → moderate
      errorRateMultiplier:     lerp(2.0, 1.3, smooth),   // Many errors → fewer
      sessionLengthMultiplier: lerp(0.5, 0.7, smooth),   // Short → slightly longer
      dailySessionsMax:        Math.round(lerp(2, 3, smooth)),
    };
  }

  if (age < GROWTH_DAYS) {
    // Growth: steady improvement from day 14 to day 60
    const progress = (age - WARMUP_DAYS) / (GROWTH_DAYS - WARMUP_DAYS);
    const smooth   = smoothstep(progress);
    return {
      phase:                   "growth",
      agedays:                 age,
      timingMultiplier:        lerp(1.3, 1.0, smooth),
      engagementMultiplier:    lerp(0.5, 1.0, smooth),
      errorRateMultiplier:     lerp(1.3, 1.0, smooth),
      sessionLengthMultiplier: lerp(0.7, 1.0, smooth),
      dailySessionsMax:        Math.round(lerp(3, 5, smooth)),
    };
  }

  // Mature: stable natural behavior with subtle daily variance
  return {
    phase:                   "mature",
    agedays:                 age,
    timingMultiplier:        1.0,
    engagementMultiplier:    1.0,
    errorRateMultiplier:     1.0,
    sessionLengthMultiplier: 1.0,
    dailySessionsMax:        5,
  };
}

/**
 * Combined timing multiplier (mood × drift).
 * Used to scale all HBE timing values.
 */
export function combineMultipliers(drift: DriftProfile, moodMultiplier: number): number {
  return clamp(drift.timingMultiplier * moodMultiplier, 0.5, 3.0);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Linear interpolation */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/** Smooth S-curve: 3t² - 2t³ (smoothstep) */
function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}
