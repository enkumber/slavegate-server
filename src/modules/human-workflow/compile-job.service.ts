import { randomUUID } from "crypto";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";
import {
  getResourceRuntimePolicy,
  ResourceRuntimePolicyUnavailableError,
} from "../runtime-policy/resource-runtime-policy.service";

export type HumanWorkflowCompileJobSource = "cache" | "shortcut" | "llm";
export type HumanWorkflowCompileJobErrorClass = "timeout" | "provider_error" | "validation_error" | "unknown";

export interface HumanWorkflowCompileJobRecord {
  id: string;
  requestKey: string;
  deviceId: string;
  accountId: string | null;
  intent: string;
  platform: string;
  status: string;
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
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: string | null;
  leaseHeartbeatAt: string | null;
  claimedAt: string | null;
  executionAttemptId: string | null;
}

export interface HumanWorkflowCompileJobState {
  initial: boolean;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
}

const DEFAULT_STALE_RUNNING_JOB_MS = 150_000;
const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;
const COMPILE_JOB_RESOURCE_TABLE = "human_workflow_compile_jobs";

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

function runtimePolicyNumber(policy: Record<string, unknown>, key: string): number {
  const value = policy[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ResourceRuntimePolicyUnavailableError(
      `runtime policy for ${COMPILE_JOB_RESOURCE_TABLE} is missing positive numeric ${key}`,
    );
  }
  return Math.floor(value);
}

async function compileJobRuntimePolicy(): Promise<{ leaseMs: number; reconcileBatchSize: number; reconcileIntervalMs: number }> {
  const policy = await getResourceRuntimePolicy(COMPILE_JOB_RESOURCE_TABLE);
  return {
    leaseMs: runtimePolicyNumber(policy, "leaseMs"),
    reconcileBatchSize: runtimePolicyNumber(policy, "reconcileBatchSize"),
    reconcileIntervalMs: runtimePolicyNumber(policy, "reconcileIntervalMs"),
  };
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
    status: String(row.status),
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
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseGeneration: Number(row.lease_generation ?? 0),
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    leaseHeartbeatAt: (row.lease_heartbeat_at as string | null) ?? null,
    claimedAt: (row.claimed_at as string | null) ?? null,
    executionAttemptId: (row.execution_attempt_id as string | null) ?? null,
  };
}

async function isStaleCompileJob(row: Record<string, unknown>): Promise<boolean> {
  if (!row.llm_started_at) return false;
  const startedAt = new Date(row.llm_started_at as string).getTime();
  if (!Number.isFinite(startedAt) || Date.now() - startedAt <= staleRunningJobMs()) {
    return false;
  }
  const result = await getDb().query(
    `SELECT state.terminal
       FROM human_workflow_compile_jobs job
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key = job.lifecycle_key
        AND state.status = job.status
      WHERE job.id = $1`,
    [row.id],
  );
  return result.rows[0]?.terminal === false;
}

interface CompileJobPatch {
  cacheKey?: string | null;
  source?: HumanWorkflowCompileJobSource;
  shortcutId?: string | null;
  error?: string | null;
  providerErrorCode?: string | null;
  result?: Record<string, unknown> | null;
  appendDebug?: Record<string, unknown> | null;
  incrementRetry?: boolean;
  markRetried?: boolean;
  clearResult?: boolean;
}

async function transitionCompileJob(
  id: string,
  selector: LifecycleTransitionSelector,
  patch: CompileJobPatch = {},
  fence?: { leaseOwner: string; leaseGeneration: number },
): Promise<HumanWorkflowCompileJobRecord | null> {
  const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await getDb().query(
    `WITH locked AS (
       SELECT job.*
         FROM human_workflow_compile_jobs job
        WHERE job.id = $1
        FOR UPDATE
     ),
     candidates AS (
       SELECT DISTINCT job.id, transition.to_status, transition.mark_started,
              transition.mark_completed, transition.clear_completed,
              transition.clear_failure, transition.reset_retry
         FROM locked job
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = job.lifecycle_key
          AND transition.from_status = job.status
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
        WHERE ${selectorPredicate}
     ),
     selected AS (
       SELECT ranked.*
         FROM (
           SELECT candidates.*, COUNT(*) OVER (PARTITION BY id) AS candidate_count
             FROM candidates
         ) ranked
        WHERE ranked.candidate_count = 1
     )
     UPDATE human_workflow_compile_jobs job
        SET status = selected.to_status,
            cache_key = CASE
              WHEN $3::jsonb ? 'cacheKey' THEN NULLIF($3::jsonb->>'cacheKey', '')
              ELSE job.cache_key
            END,
            source = CASE
              WHEN $3::jsonb ? 'source' THEN $3::jsonb->>'source'
              ELSE job.source
            END,
            shortcut_id = CASE
              WHEN $3::jsonb ? 'shortcutId'
                THEN NULLIF($3::jsonb->>'shortcutId', '')::uuid
              ELSE job.shortcut_id
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE job.error
            END,
            provider_error_code = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'providerErrorCode' THEN $3::jsonb->>'providerErrorCode'
              ELSE job.provider_error_code
            END,
            result = CASE
              WHEN COALESCE(($3::jsonb->>'clearResult')::boolean, false) THEN NULL
              WHEN $3::jsonb ? 'appendDebug' THEN
                jsonb_build_object(
                  'llmDebug', $3::jsonb->'appendDebug'->'llmDebug',
                  'llmDebugHistory', COALESCE(job.result->'llmDebugHistory', '[]'::jsonb)
                    || jsonb_build_array($3::jsonb->'appendDebug'->'llmDebug')
                )
              WHEN $3::jsonb ? 'result' THEN
                (COALESCE(job.result, '{}'::jsonb) - 'llmDebug')
                  || (COALESCE($3::jsonb->'result', '{}'::jsonb) - 'llmDebug')
                  || jsonb_build_object(
                    'llmDebug', $3::jsonb->'result'->'llmDebug',
                    'llmDebugHistory', COALESCE(job.result->'llmDebugHistory', '[]'::jsonb)
                      || jsonb_build_array($3::jsonb->'result'->'llmDebug')
                  )
              ELSE job.result
            END,
            llm_started_at = CASE
              WHEN selected.mark_started THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE job.llm_started_at
            END,
            llm_completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE job.llm_completed_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE job.completed_at
            END,
            retry_count = CASE
              WHEN COALESCE(($3::jsonb->>'incrementRetry')::boolean, false)
                THEN COALESCE(job.retry_count, 0) + 1
              WHEN selected.reset_retry THEN 0
              ELSE job.retry_count
            END,
            last_retried_at = CASE
              WHEN COALESCE(($3::jsonb->>'markRetried')::boolean, false) THEN NOW()
              ELSE job.last_retried_at
            END,
            lease_owner = CASE
              WHEN selected.mark_completed THEN NULL
              ELSE job.lease_owner
            END,
            lease_expires_at = CASE
              WHEN selected.mark_completed THEN NULL
              ELSE job.lease_expires_at
            END,
            lease_heartbeat_at = CASE
              WHEN selected.mark_completed THEN NULL
              ELSE job.lease_heartbeat_at
            END,
            updated_at = NOW()
       FROM selected
      WHERE job.id = selected.id
        AND ($4::text IS NULL OR (job.lease_owner = $4 AND job.lease_generation = $5::integer))
      RETURNING job.*`,
    [
      id,
      serializeLifecycleTransitionSelector(selector),
      JSON.stringify(patch),
      fence?.leaseOwner ?? null,
      fence?.leaseGeneration ?? null,
    ],
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

export class HumanWorkflowCompileJobService {
  private running = new Set<string>();
  private reconcilerTimer: NodeJS.Timeout | null = null;
  private reconcilerRunning = false;

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string | null;
    intent: string;
    platform: string;
  }): Promise<HumanWorkflowCompileJobRecord> {
    const result = await getDb().query(
      `INSERT INTO human_workflow_compile_jobs
         (request_key, device_id, account_id, intent, platform, source, timeout_ms)
       VALUES ($1, $2, $3, $4, $5, 'llm', $6)
       ON CONFLICT (request_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [input.requestKey, input.deviceId, input.accountId, input.intent, input.platform, humanWorkflowCompileTimeoutMs()],
    );
    return rowToJob(result.rows[0]);
  }

  async getById(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    if (await isStaleCompileJob(result.rows[0])) return this.markStaleRunningFailed(id);
    return rowToJob(result.rows[0]);
  }

  async getByRequestKey(requestKey: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE request_key = $1`, [requestKey]);
    if (result.rows.length === 0) return null;
    if (await isStaleCompileJob(result.rows[0])) return this.markStaleRunningFailed(result.rows[0].id as string);
    return rowToJob(result.rows[0]);
  }

  async state(job: Pick<HumanWorkflowCompileJobRecord, "id">): Promise<HumanWorkflowCompileJobState | null> {
    const result = await getDb().query(
      `SELECT definition.initial, definition.terminal, definition.retryable,
              definition.administrative, definition.dispatchable
         FROM human_workflow_compile_jobs compile_job
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = compile_job.lifecycle_key
          AND definition.status = compile_job.status
        WHERE compile_job.id = $1`,
      [job.id],
    );
    const row = result.rows[0];
    return row ? {
      initial: row.initial === true,
      terminal: row.terminal === true,
      retryable: row.retryable === true,
      administrative: row.administrative === true,
      dispatchable: row.dispatchable === true,
    } : null;
  }

  private async markStaleRunningFailed(id: string): Promise<HumanWorkflowCompileJobRecord> {
    const transitioned = await transitionCompileJob(id, {
      targetTerminal: true,
      targetRetryable: true,
      transitionAutomatic: true,
      transitionMarkCompleted: true,
    }, {
      error: "compile job worker expired; retry compile",
    });
    if (!transitioned) {
      const current = await getDb().query(
        "SELECT * FROM human_workflow_compile_jobs WHERE id = $1",
        [id],
      );
      if (!current.rows[0]) throw new Error("compile job disappeared while expiring stale worker");
      return rowToJob(current.rows[0]);
    }
    return transitioned;
  }

  async requeueFailed(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    return transitionCompileJob(id, {
      targetInitial: true,
      targetDispatchable: true,
      transitionClearCompleted: true,
      transitionClearFailure: true,
    }, {
      incrementRetry: true,
      markRetried: true,
    });
  }

  async requeueMissingArtifact(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    return transitionCompileJob(id, {
      targetInitial: true,
      targetDispatchable: true,
      transitionClearCompleted: true,
      transitionClearFailure: true,
    }, {
      incrementRetry: true,
      markRetried: true,
      cacheKey: null,
      clearResult: true,
    });
  }

  async claimNext(owner = `compile-worker:${process.pid}:${randomUUID()}`): Promise<HumanWorkflowCompileJobRecord | null> {
    const policy = await compileJobRuntimePolicy();
    const result = await getDb().query(
      `WITH candidate AS (
         SELECT job.id,
                (job.lease_owner IS NOT NULL AND job.lease_expires_at < NOW()) AS reclaim_running
           FROM human_workflow_compile_jobs job
          JOIN lifecycle_state_definitions state
             ON state.lifecycle_key = job.lifecycle_key
            AND state.status = job.status
          WHERE state.terminal = false
            AND (state.initial = true OR state.dispatchable = true OR job.lease_expires_at < NOW())
            AND (job.lease_owner IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at < NOW())
          ORDER BY COALESCE(job.lease_expires_at, job.created_at), job.created_at
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED
       ),
       transition AS (
         SELECT candidate.id, job.status AS to_status, false AS mark_started
           FROM candidate
           JOIN human_workflow_compile_jobs job ON job.id = candidate.id
          WHERE candidate.reclaim_running
         UNION ALL
         SELECT DISTINCT candidate.id, lifecycle_transition.to_status,
                lifecycle_transition.mark_started
           FROM candidate
           JOIN human_workflow_compile_jobs job ON job.id = candidate.id
           JOIN lifecycle_transitions lifecycle_transition
             ON lifecycle_transition.lifecycle_key = job.lifecycle_key
            AND lifecycle_transition.from_status = job.status
           JOIN lifecycle_state_definitions target
             ON target.lifecycle_key = lifecycle_transition.lifecycle_key
            AND target.status = lifecycle_transition.to_status
          WHERE target.terminal = false
            AND lifecycle_transition.mark_started = true
            AND NOT candidate.reclaim_running
       ),
       selected AS (
         SELECT ranked.*
           FROM (
             SELECT transition.*, COUNT(*) OVER (PARTITION BY id) AS candidate_count
               FROM transition
           ) ranked
          WHERE ranked.candidate_count = 1
       )
       UPDATE human_workflow_compile_jobs job
          SET status = selected.to_status,
              llm_started_at = CASE WHEN selected.mark_started THEN NOW() ELSE job.llm_started_at END,
              lease_owner = $1,
              lease_generation = job.lease_generation + 1,
              lease_expires_at = NOW() + ($2::integer * INTERVAL '1 millisecond'),
              lease_heartbeat_at = NOW(),
              claimed_at = NOW(),
              execution_attempt_id = gen_random_uuid(),
              updated_at = NOW()
         FROM selected
        WHERE job.id = selected.id
        RETURNING job.*`,
      [owner, policy.leaseMs],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async heartbeatLease(job: Pick<HumanWorkflowCompileJobRecord, "id" | "leaseOwner" | "leaseGeneration">): Promise<boolean> {
    if (!job.leaseOwner) return false;
    const policy = await compileJobRuntimePolicy();
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs
          SET lease_expires_at = NOW() + ($4::integer * INTERVAL '1 millisecond'),
              lease_heartbeat_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND lease_generation = $3
        RETURNING id`,
      [job.id, job.leaseOwner, job.leaseGeneration, policy.leaseMs],
    );
    return result.rowCount === 1;
  }

  async runClaimed(
    job: HumanWorkflowCompileJobRecord,
    runner: () => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>,
  ): Promise<void> {
    if (!job.leaseOwner) throw new Error("compile job must be durably claimed before execution");
    try {
      const result = await runner();
      await transitionCompileJob(job.id, {
        targetTerminal: true,
        targetRetryable: false,
        transitionMarkCompleted: true,
        transitionClearFailure: true,
      }, {
        cacheKey: result.cacheKey ?? null,
        source: "llm",
        shortcutId: result.shortcutId ?? null,
        result,
      }, {
        leaseOwner: job.leaseOwner,
        leaseGeneration: job.leaseGeneration,
      });
    } catch (err) {
      const typed = err as Error & { validationErrors?: string[]; debugPayload?: Record<string, unknown> };
      const validationDetail = Array.isArray(typed.validationErrors) && typed.validationErrors.length > 0
        ? `: ${typed.validationErrors.slice(0, 6).join("; ")}`
        : "";
      await transitionCompileJob(job.id, {
        targetTerminal: true,
        targetRetryable: true,
        transitionAutomatic: true,
        transitionMarkCompleted: true,
      }, {
        error: `${typed.message}${validationDetail}`,
        appendDebug: typed.debugPayload ?? null,
      }, {
        leaseOwner: job.leaseOwner,
        leaseGeneration: job.leaseGeneration,
      }).catch(() => {});
    }
  }

  async reconcileOnce(runnerForJob: (job: HumanWorkflowCompileJobRecord) => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>): Promise<number> {
    const policy = await compileJobRuntimePolicy();
    let claimed = 0;
    for (let i = 0; i < policy.reconcileBatchSize; i += 1) {
      const job = await this.claimNext();
      if (!job) break;
      claimed += 1;
      this.dispatchClaimed(job, runnerForJob);
    }
    return claimed;
  }

  startReconciler(runnerForJob: (job: HumanWorkflowCompileJobRecord) => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>): void {
    if (this.reconcilerTimer) return;
    const tick = async () => {
      if (this.reconcilerRunning) return;
      this.reconcilerRunning = true;
      try {
        await this.reconcileOnce(runnerForJob);
      } catch (err) {
        console.error("[human-workflow] compile job reconciliation failed:", (err as Error).message);
      } finally {
        this.reconcilerRunning = false;
      }
    };
    void tick();
    void compileJobRuntimePolicy().then((policy) => {
      this.reconcilerTimer = setInterval(() => void tick(), policy.reconcileIntervalMs);
    }).catch((err) => {
      console.error("[human-workflow] compile job reconciler disabled:", (err as Error).message);
    });
  }

  stopReconciler(): void {
    if (!this.reconcilerTimer) return;
    clearInterval(this.reconcilerTimer);
    this.reconcilerTimer = null;
  }

  private dispatchClaimed(
    job: HumanWorkflowCompileJobRecord,
    runnerForJob: (job: HumanWorkflowCompileJobRecord) => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>,
  ): void {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    void Promise.resolve().then(async () => {
      try {
        await this.runClaimed(job, () => runnerForJob(job));
      } finally {
        this.running.delete(job.id);
      }
    });
  }

  runInProcess(jobId: string, runner: () => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>): void {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    void Promise.resolve().then(async () => {
      try {
        const claimed = await this.claimSpecific(jobId);
        if (!claimed) return;
        await this.runClaimed(claimed, runner);
      } finally {
        this.running.delete(jobId);
      }
    });
  }

  private async claimSpecific(jobId: string, owner = `compile-worker:${process.pid}:${randomUUID()}`): Promise<HumanWorkflowCompileJobRecord | null> {
    const policy = await compileJobRuntimePolicy();
    const result = await getDb().query(
      `WITH candidate AS (
         SELECT job.id,
                (job.lease_owner IS NOT NULL AND job.lease_expires_at < NOW()) AS reclaim_running
           FROM human_workflow_compile_jobs job
          JOIN lifecycle_state_definitions state
             ON state.lifecycle_key = job.lifecycle_key
            AND state.status = job.status
          WHERE job.id = $1
            AND state.terminal = false
            AND (job.lease_owner IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at < NOW())
          FOR UPDATE OF job
       ),
       transition AS (
         SELECT candidate.id, job.status AS to_status, false AS mark_started
           FROM candidate
           JOIN human_workflow_compile_jobs job ON job.id = candidate.id
          WHERE candidate.reclaim_running
         UNION ALL
         SELECT DISTINCT candidate.id, lifecycle_transition.to_status,
                lifecycle_transition.mark_started
           FROM candidate
           JOIN human_workflow_compile_jobs job ON job.id = candidate.id
           JOIN lifecycle_transitions lifecycle_transition
             ON lifecycle_transition.lifecycle_key = job.lifecycle_key
            AND lifecycle_transition.from_status = job.status
           JOIN lifecycle_state_definitions target
             ON target.lifecycle_key = lifecycle_transition.lifecycle_key
            AND target.status = lifecycle_transition.to_status
          WHERE target.terminal = false
            AND lifecycle_transition.mark_started = true
            AND NOT candidate.reclaim_running
       ),
       selected AS (
         SELECT ranked.*
           FROM (
             SELECT transition.*, COUNT(*) OVER (PARTITION BY id) AS candidate_count
               FROM transition
           ) ranked
          WHERE ranked.candidate_count = 1
       )
       UPDATE human_workflow_compile_jobs job
          SET status = selected.to_status,
              llm_started_at = CASE WHEN selected.mark_started THEN NOW() ELSE job.llm_started_at END,
              lease_owner = $2,
              lease_generation = job.lease_generation + 1,
              lease_expires_at = NOW() + ($3::integer * INTERVAL '1 millisecond'),
              lease_heartbeat_at = NOW(),
              claimed_at = NOW(),
              execution_attempt_id = gen_random_uuid(),
              updated_at = NOW()
         FROM selected
        WHERE job.id = selected.id
        RETURNING job.*`,
      [jobId, owner, policy.leaseMs],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }
}

export const humanWorkflowCompileJobService = new HumanWorkflowCompileJobService();
