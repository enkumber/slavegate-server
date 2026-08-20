import crypto from "crypto";
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
  ownerToken: string | null;
  ownerGeneration: number;
  leaseExpiresAt: string | null;
  workerAttemptCount: number;
  lastWorkerHeartbeatAt: string | null;
}

export interface HumanWorkflowCompileJobState {
  initial: boolean;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
}

const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;

export function humanWorkflowCompileTimeoutMs(): number {
  const configured = Number.parseInt(process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COMPILE_TIMEOUT_MS;
}

export class HumanWorkflowCompileJobPolicyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanWorkflowCompileJobPolicyUnavailableError";
  }
}

export class HumanWorkflowCompileJobConflictError extends Error {
  readonly status = 409;
  readonly code = "HUMAN_WORKFLOW_COMPILE_JOB_IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "HumanWorkflowCompileJobConflictError";
  }
}

export class HumanWorkflowCompileJobLeaseFenceError extends Error {
  readonly code = "HUMAN_WORKFLOW_COMPILE_JOB_LEASE_FENCE";

  constructor(message: string) {
    super(message);
    this.name = "HumanWorkflowCompileJobLeaseFenceError";
  }
}

interface HumanWorkflowCompileJobRuntimePolicy {
  claimLimit: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  reconcileIntervalMs: number;
  maxAttempts: number;
  serverActor: string;
}

interface CompileJobClaim {
  job: HumanWorkflowCompileJobRecord;
  ownerToken: string;
  ownerGeneration: number;
}

export type HumanWorkflowCompileJobRunner = (
  job: HumanWorkflowCompileJobRecord,
  claim: CompileJobClaim,
) => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>;

function positiveInteger(policy: Record<string, unknown>, key: string): number {
  const value = policy[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(`compile job runtime policy field ${key} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(policy: Record<string, unknown>, key: string): string {
  const value = policy[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HumanWorkflowCompileJobPolicyUnavailableError(`compile job runtime policy field ${key} must be configured`);
  }
  return value.trim();
}

async function loadCompileJobRuntimePolicy(): Promise<HumanWorkflowCompileJobRuntimePolicy> {
  try {
    const policy = await getResourceRuntimePolicy("human_workflow_compile_jobs");
    if (policy.enabled !== true) {
      throw new HumanWorkflowCompileJobPolicyUnavailableError("compile job runtime policy is not enabled");
    }
    return {
      claimLimit: positiveInteger(policy, "claimLimit"),
      leaseMs: positiveInteger(policy, "leaseMs"),
      heartbeatIntervalMs: positiveInteger(policy, "heartbeatIntervalMs"),
      reconcileIntervalMs: positiveInteger(policy, "reconcileIntervalMs"),
      maxAttempts: positiveInteger(policy, "maxAttempts"),
      serverActor: nonEmptyString(policy, "serverActor"),
    };
  } catch (error) {
    if (error instanceof ResourceRuntimePolicyUnavailableError) {
      throw new HumanWorkflowCompileJobPolicyUnavailableError(error.message);
    }
    throw error;
  }
}

function errorClassFromError(error: string | null | undefined): HumanWorkflowCompileJobErrorClass | null {
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("expired") || normalized.includes("aborted")) return "timeout";
  if (normalized.includes("validation")) return "validation_error";
  if (normalized.includes("provider")) return "provider_error";
  return "unknown";
}

function dbTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
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
    llmStartedAt: dbTimestamp(row.llm_started_at),
    llmCompletedAt: dbTimestamp(row.llm_completed_at),
    retryCount: Number(row.retry_count ?? 0),
    lastRetriedAt: dbTimestamp(row.last_retried_at),
    timeoutMs: Number(row.timeout_ms ?? humanWorkflowCompileTimeoutMs()),
    createdAt: dbTimestamp(row.created_at) ?? "",
    updatedAt: dbTimestamp(row.updated_at) ?? "",
    completedAt: dbTimestamp(row.completed_at),
    ownerToken: (row.owner_token as string | null) ?? null,
    ownerGeneration: Number(row.owner_generation ?? 0),
    leaseExpiresAt: dbTimestamp(row.lease_expires_at),
    workerAttemptCount: Number(row.worker_attempt_count ?? 0),
    lastWorkerHeartbeatAt: dbTimestamp(row.last_worker_heartbeat_at),
  };
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
  clearOwner?: boolean;
}

async function transitionCompileJob(
  id: string,
  selector: LifecycleTransitionSelector,
  patch: CompileJobPatch = {},
  fence?: { ownerToken: string; ownerGeneration: number },
): Promise<HumanWorkflowCompileJobRecord | null> {
  const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await getDb().query(
    `WITH locked AS (
       SELECT job.*
         FROM human_workflow_compile_jobs job
        WHERE job.id = $1
          AND ($4::text IS NULL OR job.owner_token = $4)
          AND ($5::bigint IS NULL OR job.owner_generation = $5::bigint)
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
            owner_token = CASE
              WHEN COALESCE(($3::jsonb->>'clearOwner')::boolean, false) THEN NULL
              ELSE job.owner_token
            END,
            lease_expires_at = CASE
              WHEN COALESCE(($3::jsonb->>'clearOwner')::boolean, false) THEN NULL
              ELSE job.lease_expires_at
            END,
            updated_at = NOW()
       FROM selected
      WHERE job.id = selected.id
      RETURNING job.*`,
    [
      id,
      serializeLifecycleTransitionSelector(selector),
      JSON.stringify(patch),
      fence?.ownerToken ?? null,
      fence?.ownerGeneration ?? null,
    ],
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

async function compileJobEvent(
  jobId: string,
  eventType: string,
  actor: string,
  payload: Record<string, unknown> = {},
  claim?: { ownerToken: string; ownerGeneration: number },
): Promise<void> {
  await getDb().query(
    `INSERT INTO human_workflow_compile_job_events
       (job_id, event_type, actor, owner_token, owner_generation, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [jobId, eventType, actor, claim?.ownerToken ?? null, claim?.ownerGeneration ?? null, JSON.stringify(payload)],
  );
}

export class HumanWorkflowCompileJobService {
  private running = new Set<string>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string | null;
    intent: string;
    platform: string;
  }): Promise<HumanWorkflowCompileJobRecord> {
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO human_workflow_compile_jobs
           (request_key, device_id, account_id, intent, platform, source, timeout_ms)
         VALUES ($1, $2, $3, $4, $5, 'llm', $6)
         ON CONFLICT (request_key) DO NOTHING
         RETURNING *`,
        [input.requestKey, input.deviceId, input.accountId, input.intent, input.platform, humanWorkflowCompileTimeoutMs()],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return rowToJob(inserted.rows[0]);
      }
      const existing = await client.query(
        `SELECT * FROM human_workflow_compile_jobs WHERE request_key = $1 FOR UPDATE`,
        [input.requestKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("compile job idempotency lookup disappeared");
      if (
        row.device_id !== input.deviceId
        || (row.account_id ?? null) !== (input.accountId ?? null)
        || row.intent !== input.intent
        || row.platform !== input.platform
      ) {
        throw new HumanWorkflowCompileJobConflictError(
          "request key is already bound to a different human workflow compile payload",
        );
      }
      await client.query("COMMIT");
      return rowToJob(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE id = $1`, [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async getByRequestKey(requestKey: string): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(`SELECT * FROM human_workflow_compile_jobs WHERE request_key = $1`, [requestKey]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
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

  async claimNext(actor?: string): Promise<CompileJobClaim | null> {
    const policy = await loadCompileJobRuntimePolicy();
    const selector = serializeLifecycleTransitionSelector({
      targetTerminal: false,
      transitionAutomatic: true,
      transitionMarkStarted: true,
    });
    const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$3");
    const ownerToken = crypto.randomUUID();
    const result = await getDb().query(
      `WITH candidate AS (
         SELECT job.id
           FROM human_workflow_compile_jobs job
           JOIN lifecycle_state_definitions state
             ON state.lifecycle_key = job.lifecycle_key
            AND state.status = job.status
          WHERE NOT state.terminal
            AND job.worker_attempt_count < $4
            AND (
              (state.initial AND state.dispatchable)
              OR (job.lease_expires_at IS NOT NULL AND job.lease_expires_at < NOW())
            )
          ORDER BY
            CASE WHEN job.lease_expires_at IS NOT NULL AND job.lease_expires_at < NOW() THEN 0 ELSE 1 END,
            job.created_at ASC
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED
       ),
       selected AS (
         SELECT job.id, transition.to_status
           FROM candidate
           JOIN human_workflow_compile_jobs job ON job.id = candidate.id
           JOIN lifecycle_transitions transition
             ON transition.lifecycle_key = job.lifecycle_key
            AND transition.from_status = job.status
           JOIN lifecycle_state_definitions target
             ON target.lifecycle_key = transition.lifecycle_key
            AND target.status = transition.to_status
          WHERE ${selectorPredicate}
          LIMIT 1
       )
       UPDATE human_workflow_compile_jobs job
          SET status = selected.to_status,
              owner_token = $1,
              owner_generation = job.owner_generation + 1,
              lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              last_worker_heartbeat_at = NOW(),
              worker_attempt_count = job.worker_attempt_count + 1,
              llm_started_at = NOW(),
              llm_completed_at = NULL,
              completed_at = NULL,
              error = NULL,
              provider_error_code = NULL,
              updated_at = NOW()
         FROM selected
        WHERE job.id = selected.id
        RETURNING job.*`,
      [ownerToken, policy.leaseMs, selector, policy.maxAttempts],
    );
    if (!result.rows[0]) return null;
    const job = rowToJob(result.rows[0]);
    const claim = { job, ownerToken, ownerGeneration: job.ownerGeneration };
    await compileJobEvent(job.id, "claimed", actor ?? policy.serverActor, { leaseExpiresAt: job.leaseExpiresAt }, claim);
    return claim;
  }

  async heartbeat(claim: CompileJobClaim): Promise<void> {
    const policy = await loadCompileJobRuntimePolicy();
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs job
          SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
              last_worker_heartbeat_at = NOW(),
              updated_at = NOW()
         FROM lifecycle_state_definitions state
        WHERE job.id = $1
          AND job.owner_token = $2
          AND job.owner_generation = $3::bigint
          AND state.lifecycle_key = job.lifecycle_key
          AND state.status = job.status
          AND NOT state.terminal
        RETURNING job.id`,
      [claim.job.id, claim.ownerToken, claim.ownerGeneration, policy.leaseMs],
    );
    if (!result.rows[0]) throw new HumanWorkflowCompileJobLeaseFenceError("compile job heartbeat was fenced");
  }

  async completeClaim(
    claim: CompileJobClaim,
    result: Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null },
  ): Promise<HumanWorkflowCompileJobRecord> {
    const transitioned = await transitionCompileJob(claim.job.id, {
      targetTerminal: true,
      targetRetryable: false,
      transitionAutomatic: true,
      transitionMarkCompleted: true,
      transitionClearFailure: true,
    }, {
      cacheKey: result.cacheKey ?? null,
      source: "llm",
      shortcutId: result.shortcutId ?? null,
      result,
      clearOwner: true,
    }, claim);
    if (!transitioned) throw new HumanWorkflowCompileJobLeaseFenceError("compile job completion was fenced");
    await compileJobEvent(claim.job.id, "completed", "human_workflow_compile_reconciler", { cacheKey: transitioned.cacheKey }, claim);
    return transitioned;
  }

  async failClaim(
    claim: CompileJobClaim,
    err: Error & { validationErrors?: string[]; debugPayload?: Record<string, unknown>; providerErrorCode?: string },
  ): Promise<HumanWorkflowCompileJobRecord | null> {
    const validationDetail = Array.isArray(err.validationErrors) && err.validationErrors.length > 0
      ? `: ${err.validationErrors.slice(0, 6).join("; ")}`
      : "";
    const transitioned = await transitionCompileJob(claim.job.id, {
      targetTerminal: true,
      targetRetryable: true,
      transitionAutomatic: true,
      transitionMarkCompleted: true,
    }, {
      error: `${err.message}${validationDetail}`,
      providerErrorCode: err.providerErrorCode ?? null,
      appendDebug: err.debugPayload ?? null,
      clearOwner: true,
    }, claim);
    if (transitioned) {
      await compileJobEvent(claim.job.id, "failed", "human_workflow_compile_reconciler", { error: transitioned.error }, claim);
    }
    return transitioned;
  }

  async reconcileOnce(runner: HumanWorkflowCompileJobRunner, actor?: string): Promise<{ claimed: number }> {
    if (this.shuttingDown) return { claimed: 0 };
    const policy = await loadCompileJobRuntimePolicy();
    let claimed = 0;
    for (let index = 0; index < policy.claimLimit; index += 1) {
      const claim = await this.claimNext(actor ?? policy.serverActor);
      if (!claim) break;
      claimed += 1;
      void this.processClaim(claim, runner);
    }
    return { claimed };
  }

  startReconciler(runner: HumanWorkflowCompileJobRunner): void {
    if (this.reconcileTimer) return;
    this.shuttingDown = false;
    const schedule = async (): Promise<void> => {
      if (this.shuttingDown) return;
      try {
        const policy = await loadCompileJobRuntimePolicy();
        await this.reconcileOnce(runner, policy.serverActor);
        this.reconcileTimer = setTimeout(schedule, policy.reconcileIntervalMs);
        this.reconcileTimer.unref();
      } catch (error) {
        console.error("[human-workflow-compile] reconciler failed closed:", (error as Error).message);
        this.reconcileTimer = null;
      }
    };
    void schedule();
  }

  async stopReconciler(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private async processClaim(claim: CompileJobClaim, runner: HumanWorkflowCompileJobRunner): Promise<void> {
    if (this.running.has(claim.job.id)) return;
    this.running.add(claim.job.id);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      const policy = await loadCompileJobRuntimePolicy();
      heartbeatTimer = setInterval(() => {
        this.heartbeat(claim).catch((error) => {
          console.error("[human-workflow-compile] heartbeat failed:", (error as Error).message);
        });
      }, policy.heartbeatIntervalMs);
      heartbeatTimer.unref();
      const result = await runner(claim.job, claim);
      await this.completeClaim(claim, result);
    } catch (err) {
      if (err instanceof HumanWorkflowCompileJobLeaseFenceError) return;
      await this.failClaim(claim, err as Error & { validationErrors?: string[]; debugPayload?: Record<string, unknown> }).catch(() => {});
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.running.delete(claim.job.id);
    }
  }
}

export const humanWorkflowCompileJobService = new HumanWorkflowCompileJobService();
