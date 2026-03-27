/**
 * hbe/distributions.ts
 * Statistical distributions for human behavior simulation.
 * All functions are pure — no side effects, fully testable.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §3 (HBE)
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Box-Muller transform — unit normal N(0,1) */
function gaussianUnit(): number {
  // Two independent uniform samples → one normal sample
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

/** Normal distribution N(mean, σ) */
export function normal(mean: number, sigma: number): number {
  return mean + sigma * gaussianUnit();
}

/** Log-normal distribution: X = e^N(μ,σ) where μ,σ are log-space params */
export function logNormal(meanMs: number, sigmaFactor: number = 0.5): number {
  // Convert desired mean → log-space μ
  // E[X] = e^(μ + σ²/2)  →  μ = ln(mean) - σ²/2
  const sigma = Math.log(1 + sigmaFactor);
  const mu = Math.log(meanMs) - (sigma * sigma) / 2;
  return Math.exp(mu + sigma * gaussianUnit());
}

/** Uniform [min, max] */
export function uniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Weighted choice: picks index proportional to weights */
export function weightedChoice(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Clamp value to [min, max] */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Touch jitter ─────────────────────────────────────────────────────────────

export interface JitteredCoords {
  x: number;
  y: number;
}

/**
 * Apply Gaussian touch jitter — σ=8px as specified in v3.
 * Human taps are never pixel-perfect; center of finger is ~8px off target.
 */
export function applyTouchJitter(
  x: number,
  y: number,
  sigma: number = 8
): JitteredCoords {
  return {
    x: Math.round(clamp(normal(x, sigma), 0, 4096)),
    y: Math.round(clamp(normal(y, sigma), 0, 4096)),
  };
}

// ─── Timing profiles ─────────────────────────────────────────────────────────

export interface TimingProfile {
  /** Time to read/view content (ms) */
  readTimeMs(contentLengthChars: number): number;
  /** Micro-pause between actions (ms) */
  microPauseMs(): number;
  /** Pause between scrolls (ms) */
  scrollPauseMs(): number;
  /** Typing speed (chars/second) */
  typingCps(): number;
  /** Time between keystrokes (ms) */
  keystrokeDelayMs(): number;
}

/**
 * Base timing profile — realistic human reading and interaction speeds.
 * All timings are randomized via distributions; no hardcoded constants.
 */
export class BaseTimingProfile implements TimingProfile {
  constructor(
    private readonly moodMultiplier: number = 1.0,
    private readonly driftMultiplier: number = 1.0
  ) {}

  readTimeMs(contentLengthChars: number): number {
    // ~200-250 wpm average reading speed = ~4-5 chars/ms... wait, no.
    // 200 wpm = 200 * 5 chars/min = 1000 chars/min ≈ 16.7 chars/sec
    // 60 chars per second → ~16ms per char
    // For short posts (~100 chars): 1.5-3s; long posts (~500 chars): 5-15s
    const baseMs = (contentLengthChars / 16.7) * 1000;
    return logNormal(
      baseMs * this.moodMultiplier * this.driftMultiplier,
      0.4
    );
  }

  microPauseMs(): number {
    // Between individual actions: 100-500ms, normal distribution
    return clamp(
      normal(300 * this.moodMultiplier, 80),
      80,
      1500
    );
  }

  scrollPauseMs(): number {
    // After scroll before next action: log-normal, mean 3-5s
    return clamp(
      logNormal(3500 * this.moodMultiplier, 0.5),
      500,
      15000
    );
  }

  typingCps(): number {
    // 40-60 WPM ≈ 3-5 chars/sec; with mood variance
    return clamp(normal(4.0 * this.moodMultiplier, 0.8), 1.5, 8.0);
  }

  keystrokeDelayMs(): number {
    // 1000ms / typingCps, with micro-variance per keystroke
    const cps = this.typingCps();
    const baseDelay = 1000 / cps;
    return clamp(normal(baseDelay, baseDelay * 0.2), 50, 800);
  }
}

// ─── Bezier scroll curves ─────────────────────────────────────────────────────

export interface ScrollCurvePoint {
  t: number;   // time 0.0-1.0
  d: number;   // distance 0.0-1.0 (normalized)
}

/**
 * Generate a cubic bezier scroll curve — smooth acceleration/deceleration.
 * Returns array of (t, distance) points for smooth gesture simulation.
 * Based on human fling gesture physics.
 */
export function scrollBezierCurve(
  totalDistancePx: number,
  durationMs: number,
  steps: number = 20
): Array<{ timeMs: number; distancePx: number }> {
  // Control points: ease-in-out-ease — starts fast, decelerates
  const p0 = 0, p1 = 0.3, p2 = 0.85, p3 = 1.0;

  const result: Array<{ timeMs: number; distancePx: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Cubic bezier formula: B(t) = (1-t)³p0 + 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³·p3
    const d = Math.pow(1 - t, 3) * p0
            + 3 * Math.pow(1 - t, 2) * t * p1
            + 3 * (1 - t) * t * t * p2
            + Math.pow(t, 3) * p3;
    result.push({
      timeMs:     Math.round(t * durationMs),
      distancePx: Math.round(d * totalDistancePx),
    });
  }
  return result;
}
