/**
 * checkpoints/checkpoint.service.ts
 * Session state recovery for interrupted workflows.
 */

import { getDb } from "../../db/client";

export interface CheckpointState {
  evaluated?: number;
  matched?: number;
  last_target?: string;
  scroll_position?: number;
  partial_results?: unknown[];
  [key: string]: unknown;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  taskId: string;
  deviceId: string;
  accountId: string;
  phase: string;
  state: CheckpointState;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

class CheckpointService {
  /**
   * Save or update checkpoint for a task/device pair.
   * Uses UPSERT — safe to call repeatedly.
   */
  async save(
    sessionId: string,
    taskId: string,
    deviceId: string,
    accountId: string,
    phase: string,
    state: CheckpointState
  ): Promise<void> {
    const db = getDb();
    await db.query(`
      INSERT INTO execution_checkpoints 
        (session_id, task_id, device_id, account_id, phase, state, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
      ON CONFLICT (task_id, device_id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        account_id = EXCLUDED.account_id,
        phase = EXCLUDED.phase,
        state = EXCLUDED.state,
        expires_at = NOW() + INTERVAL '24 hours'
    `, [sessionId, taskId, deviceId, accountId, phase, JSON.stringify(state)]);
  }

  /**
   * Load checkpoint for a task/device pair.
   * Returns null if not found or expired.
   */
  async load(taskId: string, deviceId: string): Promise<Checkpoint | null> {
    const db = getDb();
    const result = await db.query(`
      SELECT * FROM execution_checkpoints
      WHERE task_id = $1 AND device_id = $2 AND expires_at > NOW()
    `, [taskId, deviceId]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      deviceId: row.device_id,
      accountId: row.account_id,
      phase: row.phase,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Clear checkpoint after successful completion.
   */
  async clear(taskId: string, deviceId: string): Promise<void> {
    const db = getDb();
    await db.query(`
      DELETE FROM execution_checkpoints
      WHERE task_id = $1 AND device_id = $2
    `, [taskId, deviceId]);
  }

  /**
   * Get all active checkpoints for a device (debugging/monitoring).
   */
  async getByDevice(deviceId: string): Promise<Checkpoint[]> {
    const db = getDb();
    const result = await db.query(`
      SELECT * FROM execution_checkpoints
      WHERE device_id = $1 AND expires_at > NOW()
      ORDER BY updated_at DESC
    `, [deviceId]);

    return result.rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      deviceId: row.device_id,
      accountId: row.account_id,
      phase: row.phase,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    }));
  }

  /**
   * Cleanup expired checkpoints (call from cron or startup).
   */
  async cleanupExpired(): Promise<number> {
    const db = getDb();
    const result = await db.query(`
      DELETE FROM execution_checkpoints
      WHERE expires_at < NOW()
      RETURNING id
    `);
    return result.rowCount ?? 0;
  }
}

export const checkpointService = new CheckpointService();
