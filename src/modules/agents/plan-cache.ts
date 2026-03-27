/**
 * agents/plan-cache.ts
 * Cache successful plans for reuse on similar tasks.
 * APC research: -50% cost, -27% latency.
 *
 * Hash strategy: SHA-256 of normalized(task_lowercase + platform).
 * "Unfollow non-followers" and "unfollow non followers" produce same hash.
 */

import crypto from "crypto";
import { getDb } from "../../db/client";
import type { PlannerOutput } from "./types";

// ─── Hash generation ──────────────────────────────────────────────────────────

/**
 * Normalize task text for consistent hashing:
 * - lowercase
 * - collapse whitespace
 * - strip punctuation
 * - trim
 */
function normalizeTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^\w\s]/g, "")   // strip punctuation
    .replace(/\s+/g, " ")      // collapse whitespace
    .trim();
}

export function computeTaskHash(task: string, platform: string): string {
  const normalized = `${normalizeTask(task)}::${platform.toLowerCase()}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ─── Cache operations ─────────────────────────────────────────────────────────

/** Minimum success rate to reuse a cached plan */
const MIN_SUCCESS_RATE = 0.5;
/** Minimum hits before we trust success rate */
const MIN_HITS_FOR_RATE = 3;

export interface CachedPlan {
  id: number;
  plan: PlannerOutput;
  hitCount: number;
  successCount: number;
}

/**
 * Look up a cached plan by task+platform hash.
 * Returns null on miss or if cached plan has poor success rate.
 */
let _tableEnsured = false;

/** Create plan_cache table if it doesn't exist (auto-migration). */
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  try {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS plan_cache (
        id            SERIAL PRIMARY KEY,
        task_hash     VARCHAR(64) NOT NULL,
        task_text     TEXT NOT NULL,
        platform      VARCHAR(32) NOT NULL,
        steps_json    JSONB NOT NULL,
        complexity    VARCHAR(16),
        hit_count     INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count    INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMPTZ,
        UNIQUE(task_hash, platform)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_plan_cache_lookup ON plan_cache (task_hash, platform)`);
    _tableEnsured = true;
  } catch (err) {
    console.warn(`[plan-cache] Auto-migration failed: ${(err as Error).message}`);
  }
}

export async function getCachedPlan(
  task: string,
  platform: string,
): Promise<CachedPlan | null> {
  await ensureTable();
  const hash = computeTaskHash(task, platform);

  try {
    const db = getDb();
    const result = await db.query(
      `SELECT id, steps_json, hit_count, success_count, fail_count
       FROM plan_cache
       WHERE task_hash = $1 AND platform = $2
       LIMIT 1`,
      [hash, platform.toLowerCase()],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as {
      id: number;
      steps_json: PlannerOutput;
      hit_count: number;
      success_count: number;
      fail_count: number;
    };

    // Check success rate — don't reuse plans that keep failing
    const totalUsed = row.success_count + row.fail_count;
    if (totalUsed >= MIN_HITS_FOR_RATE) {
      const rate = row.success_count / totalUsed;
      if (rate < MIN_SUCCESS_RATE) {
        console.log(`[plan-cache] Cache hit but low success rate (${(rate * 100).toFixed(0)}%) — skipping`);
        return null;
      }
    }

    // Update hit count + last_used_at
    await db.query(
      `UPDATE plan_cache SET hit_count = hit_count + 1, last_used_at = NOW() WHERE id = $1`,
      [row.id],
    ).catch(() => {}); // non-fatal

    console.log(`[plan-cache] Cache HIT: ${hash.slice(0, 12)} (hits=${row.hit_count + 1}, success_rate=${totalUsed > 0 ? ((row.success_count / totalUsed) * 100).toFixed(0) : "n/a"}%)`);

    return {
      id: row.id,
      plan: row.steps_json,
      hitCount: row.hit_count + 1,
      successCount: row.success_count,
    };
  } catch (err) {
    console.warn(`[plan-cache] Lookup error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Save a successful plan to cache.
 * Uses UPSERT — if same task+platform exists, updates steps (plan may improve over time).
 */
export async function savePlanToCache(
  task: string,
  platform: string,
  plan: PlannerOutput,
): Promise<void> {
  await ensureTable();
  const hash = computeTaskHash(task, platform);

  try {
    const db = getDb();
    await db.query(
      `INSERT INTO plan_cache (task_hash, task_text, platform, steps_json, complexity)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_hash, platform)
       DO UPDATE SET steps_json = EXCLUDED.steps_json,
                     complexity = EXCLUDED.complexity,
                     last_used_at = NOW()`,
      [hash, task, platform.toLowerCase(), JSON.stringify(plan), plan.complexity],
    );
    console.log(`[plan-cache] Saved: ${hash.slice(0, 12)} (${plan.steps.length} steps, ${plan.complexity})`);
  } catch (err) {
    console.warn(`[plan-cache] Save error: ${(err as Error).message}`);
  }
}

/**
 * Record outcome of a cached plan execution.
 */
export async function recordPlanOutcome(
  cacheId: number,
  success: boolean,
): Promise<void> {
  try {
    const db = getDb();
    const col = success ? "success_count" : "fail_count";
    await db.query(
      `UPDATE plan_cache SET ${col} = ${col} + 1 WHERE id = $1`,
      [cacheId],
    );
  } catch {
    // non-fatal
  }
}
