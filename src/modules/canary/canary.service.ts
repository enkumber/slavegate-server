/**
 * modules/canary/canary.service.ts
 * Canary device workflow rollout: deploy → observe → promote/rollback.
 *
 * Flow:
 *   1. New workflow template created → mark for canary validation
 *   2. Deploy ONLY on canary device (is_canary=true)
 *   3. Observe for configured window (default 2h)
 *   4. If error_rate < threshold → auto-promote to fleet
 *   5. If error_rate ≥ threshold → auto-rollback + alert
 *
 * Error rate threshold: 20% (configurable per rollout)
 *
 * Reference: PHASE4_PLAN.md C2
 */

import { getDb } from "../../db/client";
import { alerting, AlertType } from "../observability/alerts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RolloutStatus = "observing" | "passed" | "failed" | "promoted" | "rolled_back";

export interface CanaryRollout {
  id:              string;
  templateId:      string;
  canaryDeviceId:  string;
  status:          RolloutStatus;
  observeUntil:    string;   // ISO — auto-promote after this
  errorRate:       number | null;
  totalRuns:       number;
  failedRuns:      number;
  promotedAt:      string | null;
  createdAt:       string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class CanaryService {
  private readonly ERROR_RATE_THRESHOLD = 0.20;  // 20% failure → rollback
  private readonly MIN_RUNS_FOR_DECISION = 3;    // Need at least 3 runs to decide

  /**
   * Start canary observation for a new workflow template.
   * Template deployed ONLY on canary device until promoted.
   */
  async startRollout(
    templateId:     string,
    observeMinutes: number = 120
  ): Promise<CanaryRollout | null> {
    const db = getDb();

    const canary = await db.query(
      "SELECT id FROM devices WHERE is_canary = TRUE AND status = 'online' LIMIT 1"
    );
    if (!canary.rows[0]) {
      console.warn("[canary] No online canary device — skipping canary rollout");
      return null;
    }
    const canaryDeviceId = canary.rows[0].id as string;
    const observeUntil   = new Date(Date.now() + observeMinutes * 60_000).toISOString();

    const result = await db.query(
      `INSERT INTO canary_rollouts (template_id, canary_device_id, observe_until)
       VALUES ($1, $2, $3) RETURNING *`,
      [templateId, canaryDeviceId, observeUntil]
    );
    console.log(`[canary] Rollout started for template ${templateId} on device ${canaryDeviceId}`);
    return rowToRollout(result.rows[0]);
  }

  /**
   * Record a workflow run result for a canary rollout.
   * Called after each workflow completes on the canary device.
   */
  async recordRun(templateId: string, failed: boolean): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE canary_rollouts
       SET total_runs  = total_runs + 1,
           failed_runs = failed_runs + $1
       WHERE template_id = $2 AND status = 'observing'`,
      [failed ? 1 : 0, templateId]
    );
  }

  /**
   * Check all observing rollouts — auto-promote or auto-rollback.
   * Call via setInterval (every 5 min) or BullMQ repeatable.
   */
  async processRollouts(): Promise<void> {
    const db = getDb();
    const rows = await db.query(
      "SELECT * FROM canary_rollouts WHERE status = 'observing'"
    );
    for (const row of rows.rows) {
      await this.evaluateRollout(rowToRollout(row));
    }
  }

  private async evaluateRollout(rollout: CanaryRollout): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const observeUntil = new Date(rollout.observeUntil).getTime();

    const errorRate = rollout.totalRuns > 0
      ? rollout.failedRuns / rollout.totalRuns
      : 0;

    // Immediate rollback if error rate too high with enough data
    if (rollout.totalRuns >= this.MIN_RUNS_FOR_DECISION && errorRate >= this.ERROR_RATE_THRESHOLD) {
      await this.rollback(rollout, errorRate);
      return;
    }

    // Auto-promote when observation window ends + error rate acceptable
    if (now >= observeUntil && rollout.totalRuns >= this.MIN_RUNS_FOR_DECISION) {
      await this.promote(rollout, errorRate);
      return;
    }

    // Edge case: window expired but not enough runs to decide.
    // Without this, rollout stays 'observing' forever (silent hang).
    // Conservative choice: auto-promote if no failures recorded, rollback if any.
    if (now >= observeUntil && rollout.totalRuns < this.MIN_RUNS_FOR_DECISION) {
      const windowMin = Math.round((now - new Date(rollout.createdAt).getTime()) / 60_000);
      if (rollout.failedRuns === 0) {
        console.warn(`[canary] Rollout ${rollout.id}: window expired with only ${rollout.totalRuns} runs (min: ${this.MIN_RUNS_FOR_DECISION}) — auto-promoting (0 failures in ${windowMin}min)`);
        await this.promote(rollout, 0);
      } else {
        console.warn(`[canary] Rollout ${rollout.id}: window expired with insufficient runs (${rollout.totalRuns}) and ${rollout.failedRuns} failures — rolling back`);
        await this.rollback(rollout, errorRate);
      }
      return;
    }

    // Still observing — log status
    if (rollout.totalRuns > 0) {
      console.log(`[canary] Rollout ${rollout.id}: ${rollout.totalRuns} runs, ${Math.round(errorRate * 100)}% errors, ${Math.round((observeUntil - now) / 60_000)}min remaining`);
    }
  }

  private async promote(rollout: CanaryRollout, errorRate: number): Promise<void> {
    const db = getDb();
    // AND status = 'observing' guard prevents double-promote if processRollouts runs concurrently
    const result = await db.query(
      `UPDATE canary_rollouts
       SET status = 'promoted', error_rate = $1, promoted_at = NOW()
       WHERE id = $2 AND status = 'observing'`,
      [errorRate, rollout.id]
    );
    if ((result.rowCount ?? 0) === 0) return; // already processed by concurrent call
    console.log(`[canary] Rollout ${rollout.id} PROMOTED (${Math.round(errorRate * 100)}% error rate)`);
  }

  private async rollback(rollout: CanaryRollout, errorRate: number): Promise<void> {
    const db = getDb();
    // AND status = 'observing' guard prevents double-alert if processRollouts runs concurrently
    const result = await db.query(
      `UPDATE canary_rollouts SET status = 'rolled_back', error_rate = $1
       WHERE id = $2 AND status = 'observing'`,
      [errorRate, rollout.id]
    );
    if ((result.rowCount ?? 0) === 0) return; // already processed by concurrent call
    await alerting.send(AlertType.OTA_FAILED, {
      deploymentId: rollout.id,
      deviceId:     rollout.canaryDeviceId,
      error:        `Canary rollback: ${Math.round(errorRate * 100)}% error rate (threshold: ${this.ERROR_RATE_THRESHOLD * 100}%)`,
    });
    console.error(`[canary] Rollout ${rollout.id} ROLLED BACK (${Math.round(errorRate * 100)}% errors)`);
  }

  /**
   * Get canary device ID for this server.
   * Used by routes to restrict new template deployment.
   */
  async getCanaryDeviceId(): Promise<string | null> {
    const db = getDb();
    const row = await db.query("SELECT id FROM devices WHERE is_canary = TRUE LIMIT 1");
    return row.rows[0]?.id ?? null;
  }

  /** Check if a template is in active canary observation */
  async isInObservation(templateId: string): Promise<boolean> {
    const db = getDb();
    const row = await db.query(
      "SELECT id FROM canary_rollouts WHERE template_id = $1 AND status = 'observing'",
      [templateId]
    );
    return row.rows.length > 0;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  async getRollout(rolloutId: string): Promise<CanaryRollout | null> {
    const db = getDb();
    const result = await db.query(
      "SELECT * FROM canary_rollouts WHERE id = $1",
      [rolloutId]
    );
    if (result.rows.length === 0) return null;
    return rowToRollout(result.rows[0]);
  }

  async listRollouts(status?: RolloutStatus): Promise<CanaryRollout[]> {
    const db = getDb();
    const result = status
      ? await db.query("SELECT * FROM canary_rollouts WHERE status = $1 ORDER BY created_at DESC", [status])
      : await db.query("SELECT * FROM canary_rollouts ORDER BY created_at DESC");
    return result.rows.map(rowToRollout);
  }

  // ─── Manual promote / rollback ────────────────────────────────────────────

  /**
   * Manually promote a rollout before the observation window ends.
   * Requires status = 'observing'. Skips error rate check — admin override.
   */
  async manualPromote(rolloutId: string, initiatedBy = "admin"): Promise<{ ok: boolean; error?: string }> {
    const db = getDb();
    const rollout = await this.getRollout(rolloutId);
    if (!rollout) return { ok: false, error: "Rollout not found" };
    if (rollout.status !== "observing") {
      return { ok: false, error: `Cannot promote rollout with status '${rollout.status}'` };
    }
    const errorRate = rollout.totalRuns > 0 ? rollout.failedRuns / rollout.totalRuns : 0;
    await this.promote(rollout, errorRate);
    console.log(`[canary] Rollout ${rolloutId} manually promoted by ${initiatedBy} (${Math.round(errorRate * 100)}% errors)`);
    return { ok: true };
  }

  /**
   * Manually roll back a rollout.
   * Works on any non-terminal status. Sends alert to operators.
   */
  async manualRollback(rolloutId: string, reason = "Manual rollback", initiatedBy = "admin"): Promise<{ ok: boolean; error?: string }> {
    const db = getDb();
    const rollout = await this.getRollout(rolloutId);
    if (!rollout) return { ok: false, error: "Rollout not found" };
    if (rollout.status === "promoted" || rollout.status === "rolled_back") {
      return { ok: false, error: `Cannot rollback rollout with terminal status '${rollout.status}'` };
    }
    const errorRate = rollout.totalRuns > 0 ? rollout.failedRuns / rollout.totalRuns : 0;
    await db.query(
      `UPDATE canary_rollouts SET status = 'rolled_back', error_rate = $1 WHERE id = $2`,
      [errorRate, rolloutId]
    );
    await alerting.send(AlertType.OTA_FAILED, {
      deploymentId: rolloutId,
      deviceId:     rollout.canaryDeviceId,
      error:        `Manual rollback by ${initiatedBy}: ${reason}`,
    });
    console.warn(`[canary] Rollout ${rolloutId} manually rolled back by ${initiatedBy}: ${reason}`);
    return { ok: true };
  }

  // ─── Canary device management ─────────────────────────────────────────────

  /**
   * Mark a device as canary (or unmark it).
   * Only one canary device is used per rollout — multiple are allowed in DB
   * but startRollout() picks the first online canary.
   */
  async setCanaryDevice(deviceId: string, isCanary: boolean): Promise<boolean> {
    const db = getDb();
    const result = await db.query(
      "UPDATE devices SET is_canary = $1 WHERE id = $2 RETURNING id",
      [isCanary, deviceId]
    );
    const ok = (result.rowCount ?? 0) > 0;
    if (ok) {
      console.log(`[canary] Device ${deviceId} is_canary = ${isCanary}`);
    }
    return ok;
  }
}

function rowToRollout(row: Record<string, unknown>): CanaryRollout {
  return {
    id:             row.id as string,
    templateId:     row.template_id as string,
    canaryDeviceId: row.canary_device_id as string,
    status:         row.status as RolloutStatus,
    observeUntil:   (row.observe_until as Date).toISOString(),
    errorRate:      row.error_rate as number | null,
    totalRuns:      row.total_runs as number,
    failedRuns:     row.failed_runs as number,
    promotedAt:     row.promoted_at ? (row.promoted_at as Date).toISOString() : null,
    createdAt:      (row.created_at as Date).toISOString(),
  };
}

export const canaryService = new CanaryService();
