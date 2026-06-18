import { getDb } from "../../db/client";

export type HumanWorkflowCompileJobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";
export type HumanWorkflowCompileJobSource = "cache" | "shortcut" | "llm";

export interface HumanWorkflowCompileJobRecord {
  id: string;
  requestKey: string;
  deviceId: string;
  accountId: string;
  intent: string;
  platform: string;
  status: HumanWorkflowCompileJobStatus;
  cacheKey: string | null;
  source: HumanWorkflowCompileJobSource | null;
  shortcutId: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function rowToJob(row: Record<string, unknown>): HumanWorkflowCompileJobRecord {
  return {
    id: row.id as string,
    requestKey: row.request_key as string,
    deviceId: row.device_id as string,
    accountId: row.account_id as string,
    intent: row.intent as string,
    platform: row.platform as string,
    status: row.status as HumanWorkflowCompileJobStatus,
    cacheKey: (row.cache_key as string | null) ?? null,
    source: (row.source as HumanWorkflowCompileJobSource | null) ?? null,
    shortcutId: (row.shortcut_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    result: (row.result as Record<string, unknown> | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export class HumanWorkflowCompileJobService {
  private running = new Set<string>();

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string;
    intent: string;
    platform: string;
  }): Promise<HumanWorkflowCompileJobRecord> {
    const result = await getDb().query(
      `INSERT INTO human_workflow_compile_jobs
         (request_key, device_id, account_id, intent, platform, status, source)
       VALUES ($1, $2, $3, $4, $5, 'queued', 'llm')
       ON CONFLICT (request_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [input.requestKey, input.deviceId, input.accountId, input.intent, input.platform],
    );
    return rowToJob(result.rows[0]);
  }

  async getById(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0]);
  }

  async getByRequestKey(requestKey: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE request_key = $1`, [requestKey]);
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0]);
  }

  runInProcess(jobId: string, runner: () => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>): void {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    setImmediate(async () => {
      try {
        const claimed = await getDb().query(
          `UPDATE human_workflow_compile_jobs
           SET status = 'running', llm_started_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status IN ('queued', 'failed')
           RETURNING *`,
          [jobId],
        );
        if (claimed.rows.length === 0) return;
        const result = await runner();
        await getDb().query(
          `UPDATE human_workflow_compile_jobs
           SET status = 'ready',
               cache_key = $2,
               source = 'llm',
               shortcut_id = $3,
               error = NULL,
               result = $4,
               llm_completed_at = NOW(),
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [jobId, result.cacheKey ?? null, result.shortcutId ?? null, JSON.stringify(result)],
        );
      } catch (err) {
        await getDb().query(
          `UPDATE human_workflow_compile_jobs
           SET status = 'failed',
               error = $2,
               llm_completed_at = NOW(),
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [jobId, (err as Error).message],
        ).catch(() => {});
      } finally {
        this.running.delete(jobId);
      }
    });
  }
}

export const humanWorkflowCompileJobService = new HumanWorkflowCompileJobService();
