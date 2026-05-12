/**
 * hbe/session-mood.ts
 * Session mood — controls pacing and engagement behavior per session.
 * Mood is picked once per session and affects all timings via multiplier.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §3 (HBE)
 */

import { weightedChoice } from "./distributions";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Mood = "focused" | "engaged" | "casual" | "explorer";

export interface MoodProfile {
  mood: Mood;
  /** Speed multiplier for all timing (>1 = slower, <1 = faster) */
  timingMultiplier: number;
  /** Probability of engaging with content (like/comment) */
  engagementRate: number;
  /** Probability of exploring (profile visits, hashtag clicks) */
  explorationRate: number;
  /** Probability of making an error (accidental back nav, scroll past) */
  errorRate: number;
  /** Average session duration multiplier */
  sessionDurationMultiplier: number;
}

// ─── Mood profiles ────────────────────────────────────────────────────────────

export const MOOD_PROFILES: Record<Mood, MoodProfile> = {
  focused: {
    mood:                      "focused",
    timingMultiplier:          0.85,   // Slightly faster, purposeful
    engagementRate:            0.15,   // Low — focused on consuming, not engaging
    explorationRate:           0.05,   // Stays on task
    errorRate:                 0.02,   // Few mistakes
    sessionDurationMultiplier: 0.8,    // Shorter sessions
  },
  engaged: {
    mood:                      "engaged",
    timingMultiplier:          1.0,    // Normal pace
    engagementRate:            0.40,   // High engagement
    explorationRate:           0.20,   // Moderate exploration
    errorRate:                 0.05,   // Normal error rate
    sessionDurationMultiplier: 1.2,    // Longer sessions
  },
  casual: {
    mood:                      "casual",
    timingMultiplier:          1.3,    // Slower, more relaxed
    engagementRate:            0.20,   // Moderate engagement
    explorationRate:           0.25,   // Wanders a bit
    errorRate:                 0.08,   // More casual mistakes
    sessionDurationMultiplier: 1.0,    // Normal duration
  },
  explorer: {
    mood:                      "explorer",
    timingMultiplier:          1.1,    // Slightly slower (reading everything)
    engagementRate:            0.25,   // Moderate
    explorationRate:           0.50,   // High — clicks profiles, hashtags
    errorRate:                 0.06,   // Normal
    sessionDurationMultiplier: 1.4,    // Long sessions
  },
};

// ─── Mood selection ────────────────────────────────────────────────────────────

/** Mood distribution weights — 'engaged' and 'casual' most common */
const MOOD_WEIGHTS: Record<Mood, number> = {
  focused:  15,
  engaged:  35,
  casual:   35,
  explorer: 15,
};

const MOOD_KEYS = Object.keys(MOOD_WEIGHTS) as Mood[];
const MOOD_WEIGHT_ARRAY = MOOD_KEYS.map(m => MOOD_WEIGHTS[m]);

/**
 * Pick a mood for a new session.
 * Mood is stable for the entire session (picked once at session start).
 */
export function pickSessionMood(): MoodProfile {
  const idx = weightedChoice(MOOD_WEIGHT_ARRAY);
  return MOOD_PROFILES[MOOD_KEYS[idx]];
}

/**
 * Serialize mood for storage in workflow checkpoint / HBE params JSONB.
 */
export function serializeMood(profile: MoodProfile): Record<string, unknown> {
  return { ...profile };
}

export function deserializeMood(data: Record<string, unknown>): MoodProfile {
  const mood = data.mood as Mood;
  if (!MOOD_PROFILES[mood]) throw new Error(`Unknown mood: ${mood}`);
  return MOOD_PROFILES[mood];
}
