/**
 * hbe/hbe.service.ts
 * Human Behavior Engine — server-side timing and behavior generator.
 *
 * Responsibilities:
 * - Generate timing parameters for each workflow step (agent executes as-is)
 * - Pick session mood at session start
 * - Apply behavioral drift based on account age
 * - Schedule next sessions per simulated timezone
 * - Generate error simulation parameters (typos, accidental back-nav)
 *
 * Agent receives timing values. Agent does NOT generate them.
 * All intelligence is here; agent is a pure executor.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §3 (HBE)
 */

import {
  applyTouchJitter,
  logNormal,
  normal,
  uniform,
  clamp,
  type JitteredCoords,
} from "./distributions";
import { pickSessionMood, type MoodProfile, type Mood } from "./session-mood";
import { getDriftProfile, combineMultipliers, type DriftProfile } from "./behavioral-drift";
import { generateSchedule, type ScheduledSession } from "./timezone-scheduler";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HbeSessionParams {
  mood:              MoodProfile;
  drift:             DriftProfile;
  timingMultiplier:  number;  // combined mood × drift
  sessionDurationMs: number;
  scheduledSessions: ScheduledSession[];
}

export interface HbeActionParams {
  /** Pre-action pause (ms) — agent waits this long before executing */
  preActionDelayMs: number;
  /** Post-action settle time (ms) — agent waits this long after executing */
  postActionDelayMs: number;
  /** Touch coordinates with jitter applied (for tap actions) */
  jitteredCoords?: JitteredCoords;
  /** Typing: individual keystroke delays (one per character) */
  keystrokeDelaysMs?: number[];
  /** Scroll: bezier-curved distance (px) and duration (ms) */
  scrollParams?: { distancePx: number; durationMs: number };
  /** Whether to simulate an error on this action (false = normal) */
  simulateError: boolean;
  errorType?: "accidental_back" | "scroll_past" | "typo" | "double_tap";
}

export interface HbeStepParams {
  /** Action timing params */
  action: HbeActionParams;
  /** Verification strategy for this step (server decides, not agent) */
  verificationStrategy: "local_only" | "local_with_screenshot";
  /** L2 settle time (ms) — wait after action before taking afterScreenshot */
  l2SettleMs: number;
  /** L1 timeout (ms) — how long to wait for UI tree change */
  l1TimeoutMs: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class HbeService {
  /**
   * Initialize session HBE params for a new workflow execution.
   * Called once per session start — mood is stable for the entire session.
   */
  initSession(
    accountAgeDays: number,
    simulatedTimezone: string,
    sessionsToSchedule: number = 3
  ): HbeSessionParams {
    const mood  = pickSessionMood();
    const drift = getDriftProfile(accountAgeDays);
    const timingMultiplier = combineMultipliers(drift, mood.timingMultiplier);

    // Session duration: log-normal around 15min, scaled by mood + drift
    const baseDurationMs = 15 * 60_000;
    const sessionDurationMs = clamp(
      logNormal(
        baseDurationMs * mood.sessionDurationMultiplier * drift.sessionLengthMultiplier,
        0.4
      ),
      3  * 60_000,   // min 3 min
      60 * 60_000    // max 60 min
    );

    const scheduledSessions = generateSchedule(
      simulatedTimezone,
      sessionsToSchedule,
      timingMultiplier,
      drift.dailySessionsMax
    );

    return { mood, drift, timingMultiplier, sessionDurationMs, scheduledSessions };
  }

  /**
   * Generate action params for a single workflow step.
   * Called per step — agent executes the returned timing values exactly.
   */
  getActionParams(
    actionType: "tap" | "swipe" | "type" | "scroll" | "navigate" | "wait",
    session: HbeSessionParams,
    options: {
      targetX?:          number;
      targetY?:          number;
      text?:             string;
      scrollDistancePx?: number;
      verificationStrategy?: "local_only" | "local_with_screenshot";
    } = {}
  ): HbeStepParams {
    const m = session.timingMultiplier;

    // Pre-action delay: micro-pause — humans don't act instantly
    const preActionDelayMs = clamp(
      logNormal(250 * m, 0.5),
      50,
      2000
    );

    // Post-action delay: settle time after action
    const postActionDelayMs = clamp(
      logNormal(this.getBasePostDelay(actionType) * m, 0.4),
      100,
      8000
    );

    // Error simulation
    // errorRate = mood.errorRate (0.02–0.08) × drift.errorRateMultiplier (1.0–2.0) → 2–16% range
    // Previously multiplied by 0.04 which compressed to <1% — too low for realistic simulation
    const errorRate = session.mood.errorRate * session.drift.errorRateMultiplier;
    const simulateError = Math.random() < errorRate;
    const errorType = simulateError ? this.pickErrorType(actionType) : undefined;

    // Touch jitter for tap actions
    let jitteredCoords: JitteredCoords | undefined;
    if (actionType === "tap" && options.targetX !== undefined && options.targetY !== undefined) {
      jitteredCoords = applyTouchJitter(options.targetX, options.targetY, 8);
    }

    // Keystroke delays for typing
    let keystrokeDelaysMs: number[] | undefined;
    if (actionType === "type" && options.text) {
      keystrokeDelaysMs = this.generateKeystrokeDelays(options.text, m);
    }

    // Scroll params
    let scrollParams: { distancePx: number; durationMs: number } | undefined;
    if (actionType === "scroll" && options.scrollDistancePx) {
      const distancePx = clamp(
        normal(options.scrollDistancePx, options.scrollDistancePx * 0.15),
        100,
        1200
      );
      const durationMs = clamp(logNormal(400 * m, 0.3), 150, 1200);
      scrollParams = { distancePx: Math.round(distancePx), durationMs: Math.round(durationMs) };
    }

    const verificationStrategy = options.verificationStrategy ?? this.defaultVerificationStrategy(actionType);

    return {
      action: {
        preActionDelayMs:  Math.round(preActionDelayMs),
        postActionDelayMs: Math.round(postActionDelayMs),
        jitteredCoords,
        keystrokeDelaysMs,
        scrollParams,
        simulateError,
        errorType,
      },
      verificationStrategy,
      l2SettleMs:  Math.round(clamp(normal(500 * m, 100), 200, 1500)),
      l1TimeoutMs: 2000,
    };
  }

  /**
   * Generate scroll pause duration for feed browsing.
   * Separate from action params — this is the wait between scrolls.
   */
  getScrollPauseMs(session: HbeSessionParams): number {
    return Math.round(clamp(
      logNormal(3500 * session.timingMultiplier, 0.5),
      500,
      15000
    ));
  }

  /**
   * Decide whether to engage with current content (like/comment/follow).
   * Based on mood engagement rate and drift multiplier.
   */
  shouldEngage(session: HbeSessionParams): boolean {
    const rate = session.mood.engagementRate * session.drift.engagementMultiplier;
    return Math.random() < clamp(rate, 0, 0.8);
  }

  /**
   * Decide whether to explore (visit profile, tap hashtag).
   */
  shouldExplore(session: HbeSessionParams): boolean {
    const rate = session.mood.explorationRate * session.drift.engagementMultiplier;
    return Math.random() < clamp(rate, 0, 0.6);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private getBasePostDelay(actionType: string): number {
    const delays: Record<string, number> = {
      tap:      800,
      swipe:    600,
      type:     300,
      scroll:   1200,
      navigate: 2000,
      wait:     0,
    };
    return delays[actionType] ?? 800;
  }

  private generateKeystrokeDelays(text: string, multiplier: number): number[] {
    const delays: number[] = [];
    for (const char of text) {
      // Space/punctuation: slightly longer pause (end of word)
      const isWord = char === " " || char === "," || char === "." || char === "!";
      const base = isWord ? 300 : 220;
      delays.push(Math.round(clamp(normal(base * multiplier, base * 0.25), 40, 800)));
    }
    return delays;
  }

  private pickErrorType(
    actionType: string
  ): "accidental_back" | "scroll_past" | "typo" | "double_tap" {
    if (actionType === "type")   return "typo";
    if (actionType === "scroll") return "scroll_past";
    if (actionType === "tap")    return Math.random() < 0.5 ? "double_tap" : "accidental_back";
    return "accidental_back";
  }

  private defaultVerificationStrategy(
    actionType: string
  ): "local_only" | "local_with_screenshot" {
    // Low-risk actions: local_only. Medium-risk: local_with_screenshot.
    // full_cascade / vlm_required are set explicitly in workflow template steps.
    const lowRisk = ["scroll", "navigate", "wait", "open_app", "close_app"];
    return lowRisk.includes(actionType) ? "local_only" : "local_with_screenshot";
  }
}

export const hbeService = new HbeService();
