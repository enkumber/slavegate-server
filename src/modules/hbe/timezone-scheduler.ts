/**
 * hbe/timezone-scheduler.ts
 * Timezone-aware session scheduling.
 * Sessions happen during realistic hours relative to SIMULATED timezone.
 * Physical device timezone is irrelevant — only simulated timezone matters.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §3 (HBE)
 *
 * Rules:
 * - Peak morning: 07:00-09:00 (commute/wake-up)
 * - Lunch:        12:00-13:30
 * - Evening peak: 18:00-23:00 (most activity)
 * - Late night:   23:00-00:00 (rare)
 * - Dead zone:    00:00-06:00 (zero sessions)
 */

import { weightedChoice, uniform, logNormal, clamp } from "./distributions";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionWindow {
  /** Start hour in simulated timezone (0-23) */
  startHour: number;
  /** End hour in simulated timezone (0-23) */
  endHour: number;
  /** Relative weight for session selection */
  weight: number;
  /** Base session duration mean (ms) */
  durationMeanMs: number;
}

export interface ScheduledSession {
  /** UTC timestamp when session should start */
  scheduledAt: Date;
  /** Session duration in ms */
  durationMs: number;
  /** Human-local hour at which this session falls */
  localHour: number;
}

// ─── Session windows ──────────────────────────────────────────────────────────

const SESSION_WINDOWS: SessionWindow[] = [
  { startHour: 7,  endHour: 9,  weight: 20, durationMeanMs: 8  * 60_000 },   // Morning commute
  { startHour: 12, endHour: 13, weight: 15, durationMeanMs: 10 * 60_000 },   // Lunch
  { startHour: 15, endHour: 17, weight: 10, durationMeanMs: 6  * 60_000 },   // Afternoon break
  { startHour: 18, endHour: 21, weight: 35, durationMeanMs: 15 * 60_000 },   // Evening prime time
  { startHour: 21, endHour: 23, weight: 15, durationMeanMs: 12 * 60_000 },   // Late evening
  { startHour: 23, endHour: 24, weight:  5, durationMeanMs: 5  * 60_000 },   // Late night (rare)
];

const WINDOW_WEIGHTS = SESSION_WINDOWS.map(w => w.weight);

// ─── Timezone offset resolution ───────────────────────────────────────────────

/**
 * Get current UTC offset in minutes for a simulated IANA timezone.
 * Used to convert local session hours to UTC dispatch times.
 */
function getUtcOffsetMinutes(ianaTimezone: string): number {
  // Use Intl to get offset by formatting current date in timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTimezone,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(now);
  const offsetPart = parts.find(p => p.type === "timeZoneName")?.value ?? "UTC";
  // offsetPart e.g. "GMT+2", "GMT-5", "GMT+5:30"
  const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign    = match[1] === "+" ? 1 : -1;
  const hours   = parseInt(match[2], 10);
  const minutes = parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
}

// ─── Schedule generation ──────────────────────────────────────────────────────

/**
 * Generate session schedule for the next N sessions.
 * Sessions are scheduled within realistic windows relative to simulated timezone.
 *
 * @param simulatedTimezone  IANA timezone string (from account.simulated_timezone)
 * @param count              Number of sessions to schedule
 * @param durationMultiplier Mood × drift multiplier for session length
 * @param dailySessionsMax   Max sessions per day (from drift profile)
 */
export function generateSchedule(
  simulatedTimezone: string,
  count: number,
  durationMultiplier: number = 1.0,
  dailySessionsMax: number = 5
): ScheduledSession[] {
  const sessions: ScheduledSession[] = [];
  const offsetMinutes = getUtcOffsetMinutes(simulatedTimezone);

  // Current UTC time and current "local" time expressed as minutes-since-epoch in local TZ.
  // We work entirely in "local minutes from epoch" to avoid Date timezone confusion.
  const nowUtcMs = Date.now();

  // localDayStartUtcMs: UTC timestamp of 00:00:00 local time TODAY.
  // Formula: floor the local time to the nearest local day.
  //   localMs = nowUtcMs + offsetMs
  //   localDayStart (local) = floor(localMs / dayMs) * dayMs
  //   localDayStartUtcMs = localDayStart (local) - offsetMs
  const offsetMs        = offsetMinutes * 60_000;
  const dayMs           = 24 * 60 * 60_000;
  const localNowMs      = nowUtcMs + offsetMs;                              // "local" ms
  const localDayStartMs = Math.floor(localNowMs / dayMs) * dayMs;           // 00:00 local today
  const localNowHours   = (localNowMs % dayMs) / 3_600_000;                 // fractional local hour

  // sessionsPerDay tracks how many sessions we've accepted for the current dayOffset
  let dayOffset = 0;          // 0 = today, 1 = tomorrow, ...
  let sessionsPerDay = 0;
  // Detect stale days: if we can't find a valid window after MAX_TRIES, advance to next day
  const MAX_TRIES_PER_DAY = 200;
  let triesThisDay = 0;

  while (sessions.length < count) {
    // Cap per day → advance to next day
    if (sessionsPerDay >= dailySessionsMax) {
      dayOffset++;
      sessionsPerDay = 0;
      triesThisDay = 0;
      continue;
    }

    // Safety: if we've tried too many times on this day (e.g. all windows in the past),
    // advance to the next day. Prevents infinite loop on e.g. 23:58 local time.
    if (triesThisDay >= MAX_TRIES_PER_DAY) {
      dayOffset++;
      sessionsPerDay = 0;
      triesThisDay = 0;
      continue;
    }
    triesThisDay++;

    // Pick a random session window
    const winIdx = weightedChoice(WINDOW_WEIGHTS);
    const win    = SESSION_WINDOWS[winIdx];

    // Random start time within the window (fractional hours)
    const localHour   = uniform(win.startHour, win.endHour);
    const localMinute = uniform(0, 60);
    // "local" ms for this candidate session
    const candidateLocalMs = localDayStartMs + dayOffset * dayMs
                           + (localHour * 60 + localMinute) * 60_000;

    // Skip slots in the past (only for today — future days are always valid)
    if (dayOffset === 0 && candidateLocalMs <= localNowMs) {
      continue;
    }

    // Convert candidate local ms → UTC ms
    const scheduledUtcMs = candidateLocalMs - offsetMs;

    // Session duration: log-normal around window mean
    const durationMs = clamp(
      logNormal(win.durationMeanMs * durationMultiplier, 0.4),
      2  * 60_000,   // min 2 minutes
      45 * 60_000    // max 45 minutes
    );

    sessions.push({
      scheduledAt: new Date(scheduledUtcMs),
      durationMs:  Math.round(durationMs),
      localHour:   Math.floor(localHour),
    });
    sessionsPerDay++;
  }

  // Sort chronologically (sessions may be out of order due to random window selection)
  sessions.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return sessions.slice(0, count);
}

// Expose localNowHours for tests / internal use
export function getLocalHour(simulatedTimezone: string): number {
  const offsetMs   = getUtcOffsetMinutes(simulatedTimezone) * 60_000;
  const localNowMs = Date.now() + offsetMs;
  return (localNowMs % (24 * 60 * 60_000)) / 3_600_000;
}

/**
 * Compute next session start time for a given account.
 * Returns null if account is in dead zone (00:00-06:00 local).
 */
export function nextSessionStart(
  simulatedTimezone: string,
  durationMultiplier: number = 1.0
): ScheduledSession | null {
  const sessions = generateSchedule(simulatedTimezone, 1, durationMultiplier, 5);
  return sessions[0] ?? null;
}
