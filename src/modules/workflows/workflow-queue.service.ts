import type { PoolClient } from "pg";
import { getDb } from "../../db/client";

export type WorkflowQueueStatus = "queued" | "working" | "done" | "failed";

export interface WorkflowQueueRecord {
  id: string;
  deviceId: string;
  workflowId: string;
  sequence: number;
  status: WorkflowQueueStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function rowToRecord(row: Record<string, unknown>): WorkflowQueueRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    workflowId: String(row.workflow_id),
    sequence: Number(row.queue_sequence),
    status: row.status as WorkflowQueueStatus,
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    startedAt: row.started_at == null ? null : new Date(row.started_at as string | Date).toISOString(),
    finishedAt: row.finished_at == null ? null : new Date(row.finished_at as string | Date).toISOString(),
  };
}

async function lockDevice(client: PoolClient, deviceId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    ["workflow_queue", deviceId],
  );
}

export class WorkflowQueueService {
  async hasWorkingWorkflow(deviceId: string): Promise<boolean> {
    const result = await getDb().query(
      `SELECT 1
       FROM workflow_queue
       WHERE device_id = $1 AND status = 'working'
       LIMIT 1`,
      [deviceId],
    );
    return Boolean(result.rows[0]);
  }

  async enqueue(workflowId: string, deviceId: string): Promise<WorkflowQueueRecord> {
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      await lockDevice(client, deviceId);

      const existing = await client.query(
        "SELECT * FROM workflow_queue WHERE workflow_id = $1",
        [workflowId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return rowToRecord(existing.rows[0]);
      }

      const inserted = await client.query(
        `INSERT INTO workflow_queue (device_id, workflow_id, queue_sequence, status)
         SELECT $1, $2, COALESCE(MAX(queue_sequence), 0) + 1, 'queued'
         FROM workflow_queue
         WHERE device_id = $1
         RETURNING *`,
        [deviceId, workflowId],
      );
      await client.query("COMMIT");
      return rowToRecord(inserted.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async claimNext(deviceId: string): Promise<WorkflowQueueRecord | null> {
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      await lockDevice(client, deviceId);

      const working = await client.query(
        "SELECT id FROM workflow_queue WHERE device_id = $1 AND status = 'working' LIMIT 1",
        [deviceId],
      );
      if (working.rows[0]) {
        await client.query("COMMIT");
        return null;
      }

      const next = await client.query(
        `SELECT id
         FROM workflow_queue
         WHERE device_id = $1 AND status = 'queued'
         ORDER BY queue_sequence ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [deviceId],
      );
      if (!next.rows[0]) {
        await client.query("COMMIT");
        return null;
      }

      const claimed = await client.query(
        `UPDATE workflow_queue
         SET status = 'working', started_at = COALESCE(started_at, NOW()), error = NULL
         WHERE id = $1 AND status = 'queued'
         RETURNING *`,
        [next.rows[0].id],
      );
      await client.query("COMMIT");
      return claimed.rows[0] ? rowToRecord(claimed.rows[0]) : null;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseClaim(workflowId: string, error: string): Promise<void> {
    await getDb().query(
      `UPDATE workflow_queue
       SET status = 'queued', started_at = NULL, error = $2
       WHERE workflow_id = $1 AND status = 'working'`,
      [workflowId, error],
    );
  }

  async markDone(workflowId: string): Promise<void> {
    await getDb().query(
      `UPDATE workflow_queue
       SET status = 'done', finished_at = COALESCE(finished_at, NOW()), error = NULL
       WHERE workflow_id = $1 AND status = 'working'`,
      [workflowId],
    );
  }

  async markFailed(workflowId: string, error: string): Promise<void> {
    await getDb().query(
      `UPDATE workflow_queue
       SET status = 'failed', finished_at = COALESCE(finished_at, NOW()), error = $2
       WHERE workflow_id = $1 AND status = 'working'`,
      [workflowId, error],
    );
  }

  async reconcileTerminalWorkflows(): Promise<number> {
    const result = await getDb().query(
      `UPDATE workflow_queue q
       SET status = CASE WHEN w.status = 'completed' THEN 'done' ELSE 'failed' END,
           finished_at = COALESCE(q.finished_at, w.completed_at, NOW()),
           error = CASE
             WHEN w.status = 'completed' THEN NULL
             ELSE COALESCE(w.error, 'workflow became terminal while queue was recovering')
           END
       FROM workflows w
       WHERE q.workflow_id = w.id
         AND q.status = 'working'
         AND w.status IN ('completed', 'failed', 'cancelled')`,
    );
    return result.rowCount ?? 0;
  }

  async listWorking(): Promise<WorkflowQueueRecord[]> {
    const result = await getDb().query(
      "SELECT * FROM workflow_queue WHERE status = 'working' ORDER BY device_id, queue_sequence",
    );
    return result.rows.map(rowToRecord);
  }

  async listReadyDeviceIds(): Promise<string[]> {
    const result = await getDb().query(
      `SELECT DISTINCT q.device_id
       FROM workflow_queue q
       WHERE q.status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM workflow_queue active
           WHERE active.device_id = q.device_id AND active.status = 'working'
         )
       ORDER BY q.device_id`,
    );
    return result.rows.map((row) => String(row.device_id));
  }
}

export const workflowQueueService = new WorkflowQueueService();
