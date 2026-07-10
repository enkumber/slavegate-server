import { getDb } from "../../db/client";

export type HumanWorkflowCompileJobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";
export type HumanWorkflowCompileJobSource = "cache" | "shortcut" | "llm";
export type HumanWorkflowCompileJobErrorClass = "timeout" | "provider_error" | "validation_error" | "unknown";

export interface HumanWorkflowCompileJobRecord {
  id: string;
  requestKey: string;
  deviceId: string;
  accountId: string | null;
  intent: string;
  platform: string;
  status: HumanWorkflowCompileJobStatus;
  cacheKey: string | null;
  source: HumanWorkflowCompileJobSource | null;
  shortcutId: string | null;
  error: string | null;
  errorClass: HumanWorkflowCompileJobErrorClass | null;
  providerErrorCode: string | null;
  result: Record<string, unknown> | null;
  llmStartedAt: string | null;
  llmCompletedAt: string | null;
  retryCount: number;
  lastRetriedAt: string | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const DEFAULT_STALE_RUNNING_JOB_MS = 150_000;
const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;

function staleRunningJobMs(): number {
  const configured = Number.parseInt(process.env.HUMAN_WORKFLOW_COMPILE_JOB_STALE_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_RUNNING_JOB_MS;
}

export function humanWorkflowCompileTimeoutMs(): number {
  const configured = Number.parseInt(process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COMPILE_TIMEOUT_MS;
}

function errorClassFromError(error: string | null | undefined): HumanWorkflowCompileJobErrorClass | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("expired") || normalized.includes("aborted")) return "timeout";
  if (normalized.includes("validation")) return "validation_error";
  if (normalized.includes("provider")) return "provider_error";
  return "unknown";
}

function rowToJob(row: Record<string, unknown>): HumanWorkflowCompileJobRecord {
  const error = (row.error as string | null) ?? null;
  return {
    id: row.id as string,
    requestKey: row.request_key as string,
    deviceId: row.device_id as string,
    accountId: (row.account_id as string | null) ?? null,
    intent: row.intent as string,
    platform: row.platform as string,
    status: row.status as HumanWorkflowCompileJobStatus,
    cacheKey: (row.cache_key as string | null) ?? null,
    source: (row.source as HumanWorkflowCompileJobSource | null) ?? null,
    shortcutId: (row.shortcut_id as string | null) ?? null,
    error,
    errorClass: errorClassFromError(error),
    providerErrorCode: (row.provider_error_code as string | null) ?? null,
    result: (row.result as Record<string, unknown> | null) ?? null,
    llmStartedAt: (row.llm_started_at as string | null) ?? null,
    llmCompletedAt: (row.llm_completed_at as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    lastRetriedAt: (row.last_retried_at as string | null) ?? null,
    timeoutMs: Number(row.timeout_ms ?? humanWorkflowCompileTimeoutMs()),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

function isStaleRunningJob(row: Record<string, unknown>): boolean {
  if (row.status !== "running" || !row.llm_started_at) return false;
  const startedAt = new Date(row.llm_started_at as string).getTime();
  return Number.isFinite(startedAt) && Date.now() - startedAt > staleRunningJobMs();
}

export class HumanWorkflowCompileJobService {
  private running = new Set<string>();

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string | null;
    intent: string;
    platform: string;
  }): Promise<HumanWorkflowCompileJobRecord> {
    const result = await getDb().query(
      `INSERT INTO human_workflow_compile_jobs
         (request_key, device_id, account_id, intent, platform, status, source, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, 'queued', 'llm', $6)
       ON CONFLICT (request_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [input.requestKey, input.deviceId, input.accountId, input.intent, input.platform, humanWorkflowCompileTimeoutMs()],
    );
    return rowToJob(result.rows[0]);
  }

  async getById(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    if (isStaleRunningJob(result.rows[0])) return this.markStaleRunningFailed(id);
    return rowToJob(result.rows[0]);
  }

  async getByRequestKey(requestKey: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE request_key = $1`, [requestKey]);
    if (result.rows.length === 0) return null;
    if (isStaleRunningJob(result.rows[0])) return this.markStaleRunningFailed(result.rows[0].id as string);
    return rowToJob(result.rows[0]);
  }

  private async markStaleRunningFailed(id: string): Promise<HumanWorkflowCompileJobRecord> {
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs
       SET status = 'failed',
           error = 'compile job worker expired; retry compile',
           llm_completed_at = NOW(),
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id],
    );
    return rowToJob(result.rows[0]);
  }

  async requeueFailed(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs
       SET status = 'queued',
           retry_count = COALESCE(retry_count, 0) + 1,
           last_retried_at = NOW(),
           error = NULL,
           llm_completed_at = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'failed'
       RETURNING *`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0]);
  }

  async requeueMissingArtifact(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs
       SET status = 'queued',
           retry_count = COALESCE(retry_count, 0) + 1,
           last_retried_at = NOW(),
           cache_key = NULL,
           error = NULL,
           provider_error_code = NULL,
           result = NULL,
           llm_started_at = NULL,
           llm_completed_at = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'ready'
       RETURNING *`,
      [id],
    );
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
           WHERE id = $1 AND (
             status IN ('queued', 'failed')
             OR (status = 'running' AND llm_started_at < NOW() - ($2::int * INTERVAL '1 millisecond'))
           )
           RETURNING *`,
          [jobId, staleRunningJobMs()],
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
        const typed = err as Error & { validationErrors?: string[] };
        const validationDetail = Array.isArray(typed.validationErrors) && typed.validationErrors.length > 0
          ? `: ${typed.validationErrors.slice(0, 6).join("; ")}`
          : "";
        await getDb().query(
          `UPDATE human_workflow_compile_jobs
           SET status = 'failed',
               error = $2,
               llm_completed_at = NOW(),
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [jobId, `${typed.message}${validationDetail}`],
        ).catch(() => {});
      } finally {
        this.running.delete(jobId);
      }
    });
  }
}

export const humanWorkflowCompileJobService = new HumanWorkflowCompileJobService();
