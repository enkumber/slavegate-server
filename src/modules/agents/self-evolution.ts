/**
 * agents/self-evolution.ts
 * Self-Evolution Memory: Tips + Shortcuts.
 * Mobile-Agent-E research: +22% efficiency.
 *
 * Tips: Learned observations about UI behavior
 *   - "Instagram Following count is at x=0.82, y=0.16 on 1080x2160"
 *   - "After scroll in followers list, wait 500ms for render"
 *
 * Shortcuts: Reusable action sequences for common sub-tasks
 *   - instagram_goto_following: [tap profile, wait, tap following count]
 *   - instagram_unfollow_user: [tap following btn, wait, tap confirm]
 *
 * Auto-creation:
 *   - Tips: created after repeated failures or discoveries
 *   - Shortcuts: created after successfully executing the same sequence 2+ times
 */

import { getDb } from "../../db/client";
import type { ExecutorAction, PlanStep } from "./types";

// ─── Auto-migration ──────────────────────────────────────────────────────────

let _tablesEnsured = false;

async function ensureTables(): Promise<void> {
  if (_tablesEnsured) return;
  try {
    const db = getDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS agent_tips (
        id          SERIAL PRIMARY KEY,
        platform    VARCHAR(32) NOT NULL,
        category    VARCHAR(32) NOT NULL DEFAULT 'general',
        tip         TEXT NOT NULL,
        source      VARCHAR(32) NOT NULL DEFAULT 'auto',
        relevance   REAL NOT NULL DEFAULT 1.0,
        use_count   INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(platform, tip)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS agent_shortcuts (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(128) NOT NULL,
        platform    VARCHAR(32) NOT NULL,
        description TEXT,
        steps_json  JSONB NOT NULL,
        use_count   INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(name, platform)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_tips_platform ON agent_tips (platform)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_shortcuts_platform ON agent_shortcuts (platform)`);
    _tablesEnsured = true;
  } catch (err) {
    console.warn(`[self-evolution] Auto-migration failed: ${(err as Error).message}`);
  }
}

// ─── Tips ─────────────────────────────────────────────────────────────────────

export interface Tip {
  id: number;
  platform: string;
  category: string;
  tip: string;
  relevance: number;
}

/**
 * Get relevant tips for a platform + optional category filter.
 * Returns top tips sorted by relevance.
 */
export async function getTips(
  platform: string,
  category?: string,
  limit = 10,
): Promise<Tip[]> {
  await ensureTables();
  try {
    const db = getDb();
    const where = category
      ? `WHERE platform = $1 AND category = $2`
      : `WHERE platform = $1`;
    const params = category ? [platform, category, limit] : [platform, limit];
    const paramLimit = category ? "$3" : "$2";

    const result = await db.query(
      `SELECT id, platform, category, tip, relevance
       FROM agent_tips
       ${where}
       ORDER BY relevance DESC, use_count DESC
       LIMIT ${paramLimit}`,
      params,
    );

    // Increment use_count for returned tips
    const ids = result.rows.map((r: { id: number }) => r.id);
    if (ids.length > 0) {
      db.query(
        `UPDATE agent_tips SET use_count = use_count + 1 WHERE id = ANY($1)`,
        [ids],
      ).catch(() => {});
    }

    return result.rows as Tip[];
  } catch (err) {
    console.warn(`[self-evolution] getTips error: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Add a new tip (or update relevance if exists).
 */
export async function addTip(
  platform: string,
  tip: string,
  category = "general",
  source = "auto",
  relevance = 1.0,
): Promise<void> {
  await ensureTables();
  try {
    const db = getDb();
    await db.query(
      `INSERT INTO agent_tips (platform, category, tip, source, relevance)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, tip)
       DO UPDATE SET relevance = GREATEST(agent_tips.relevance, EXCLUDED.relevance),
                     use_count = agent_tips.use_count + 1`,
      [platform, category, tip, source, relevance],
    );
    console.log(`[self-evolution] Tip added: [${platform}/${category}] ${tip.slice(0, 60)}`);
  } catch (err) {
    console.warn(`[self-evolution] addTip error: ${(err as Error).message}`);
  }
}

/**
 * Decrease relevance of a tip that led to failure.
 */
export async function decayTip(tipId: number): Promise<void> {
  try {
    const db = getDb();
    await db.query(
      `UPDATE agent_tips SET relevance = GREATEST(0.1, relevance * 0.8) WHERE id = $1`,
      [tipId],
    );
  } catch { /* non-fatal */ }
}

// ─── Shortcuts ────────────────────────────────────────────────────────────────

export interface Shortcut {
  id: number;
  name: string;
  platform: string;
  description: string | null;
  steps: ExecutorAction[];
  useCount: number;
  successRate: number;
}

/**
 * Get shortcuts for a platform.
 */
export async function getShortcuts(
  platform: string,
  limit = 20,
): Promise<Shortcut[]> {
  await ensureTables();
  try {
    const db = getDb();
    const result = await db.query(
      `SELECT id, name, platform, description, steps_json,
              use_count, success_count, fail_count
       FROM agent_shortcuts
       WHERE platform = $1
       ORDER BY use_count DESC
       LIMIT $2`,
      [platform, limit],
    );

    return result.rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      name: r.name as string,
      platform: r.platform as string,
      description: r.description as string | null,
      steps: r.steps_json as ExecutorAction[],
      useCount: r.use_count as number,
      successRate: ((r.success_count as number) + (r.fail_count as number)) > 0
        ? (r.success_count as number) / ((r.success_count as number) + (r.fail_count as number))
        : 1.0,
    }));
  } catch (err) {
    console.warn(`[self-evolution] getShortcuts error: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Find a shortcut by name.
 */
export async function findShortcut(
  name: string,
  platform: string,
): Promise<Shortcut | null> {
  await ensureTables();
  try {
    const db = getDb();
    const result = await db.query(
      `SELECT id, name, platform, description, steps_json,
              use_count, success_count, fail_count
       FROM agent_shortcuts
       WHERE name = $1 AND platform = $2
       LIMIT 1`,
      [name, platform],
    );
    if (result.rows.length === 0) return null;

    const r = result.rows[0] as Record<string, unknown>;

    // Increment use count
    db.query(`UPDATE agent_shortcuts SET use_count = use_count + 1 WHERE id = $1`, [r.id]).catch(() => {});

    return {
      id: r.id as number,
      name: r.name as string,
      platform: r.platform as string,
      description: r.description as string | null,
      steps: r.steps_json as ExecutorAction[],
      useCount: (r.use_count as number) + 1,
      successRate: ((r.success_count as number) + (r.fail_count as number)) > 0
        ? (r.success_count as number) / ((r.success_count as number) + (r.fail_count as number))
        : 1.0,
    };
  } catch {
    return null;
  }
}

/**
 * Save a new shortcut (or update if exists).
 */
export async function saveShortcut(
  name: string,
  platform: string,
  steps: ExecutorAction[],
  description?: string,
): Promise<void> {
  await ensureTables();
  try {
    const db = getDb();
    await db.query(
      `INSERT INTO agent_shortcuts (name, platform, description, steps_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, platform)
       DO UPDATE SET steps_json = EXCLUDED.steps_json,
                     description = COALESCE(EXCLUDED.description, agent_shortcuts.description)`,
      [name, platform, description || null, JSON.stringify(steps)],
    );
    console.log(`[self-evolution] Shortcut saved: ${name} (${steps.length} steps)`);
  } catch (err) {
    console.warn(`[self-evolution] saveShortcut error: ${(err as Error).message}`);
  }
}

/**
 * Record shortcut execution outcome.
 */
export async function recordShortcutOutcome(
  shortcutId: number,
  success: boolean,
): Promise<void> {
  try {
    const db = getDb();
    const col = success ? "success_count" : "fail_count";
    await db.query(`UPDATE agent_shortcuts SET ${col} = ${col} + 1 WHERE id = $1`, [shortcutId]);
  } catch { /* non-fatal */ }
}

// ─── Auto-learning from execution ─────────────────────────────────────────────

/**
 * Learn from a successful step execution.
 * Creates tips about coordinate locations and timing.
 */
export async function learnFromSuccess(
  platform: string,
  step: PlanStep,
  action: ExecutorAction,
  durationMs: number,
): Promise<void> {
  // Learn coordinate tip for tap actions
  if (action.type === "tap" && action.x !== undefined && action.y !== undefined && action.element) {
    await addTip(
      platform,
      `Element "${action.element}" found at coordinates (${action.x.toFixed(3)}, ${action.y.toFixed(3)})`,
      "coordinates",
      "auto",
      0.8,
    );
  }

  // Learn timing tip if action was slow
  if (durationMs > 2000 && step.action === "tap") {
    await addTip(
      platform,
      `After "${step.description}", wait at least ${Math.ceil(durationMs / 500) * 500}ms for UI to settle`,
      "timing",
      "auto",
      0.6,
    );
  }
}

/**
 * Learn from a failed step execution.
 * Creates tips about what doesn't work.
 */
export async function learnFromFailure(
  platform: string,
  step: PlanStep,
  action: ExecutorAction,
  reason: string,
): Promise<void> {
  if (action.type === "tap" && action.element) {
    await addTip(
      platform,
      `Element "${action.element}" may not be at (${action.x?.toFixed(3)}, ${action.y?.toFixed(3)}) — ${reason.slice(0, 100)}`,
      "warnings",
      "auto",
      0.7,
    );
  }
}

/**
 * Build tips context string for executor prompt injection.
 */
export async function buildTipsContext(platform: string): Promise<string> {
  const tips = await getTips(platform, undefined, 8);
  if (tips.length === 0) return "";

  const lines = tips.map((t) => `- [${t.category}] ${t.tip}`);
  return `\nLEARNED TIPS (from previous executions):\n${lines.join("\n")}\n`;
}
