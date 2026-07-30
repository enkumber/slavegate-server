import crypto from "crypto";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";
import {
  humanWorkflowCompileJobRuntimePolicy,
  type HumanWorkflowCompileJobRuntimePolicy,
} from "./compile-job-runtime-policy";

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
  requestPayloadHash: string | null;
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

const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;

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
    requestPayloadHash: (row.request_payload_hash as string | null) ?? null,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseGeneration: Number(row.lease_generation ?? 0),
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    leaseHeartbeatAt: (row.lease_heartbeat_at as string | null) ?? null,
    claimedAt: (row.claimed_at as string | null) ?? null,
    executionAttemptId: (row.execution_attempt_id as string | null) ?? null,
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
}

export type HumanWorkflowCompileJobRunner = (
  job: HumanWorkflowCompileJobRecord,
) => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>;

function requestPayloadHash(input: {
  requestKey: string;
  deviceId: string;
  accountId: string | null;
  intent: string;
  platform: string;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    input.requestKey,
    input.deviceId,
    input.accountId,
    input.intent,
    input.platform,
  ])).digest("hex");
}

function idempotencyConflict(): Error & { status: number; code: string } {
  return Object.assign(
    new Error("request key is already bound to a different compile payload"),
    { status: 409, code: "COMPILE_REQUEST_IDEMPOTENCY_CONFLICT" },
  );
}

async function transitionCompileJob(
  id: string,
  selector: LifecycleTransitionSelector,
  patch: CompileJobPatch = {},
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
            updated_at = NOW()
       FROM selected
      WHERE job.id = selected.id
      RETURNING job.*`,
    [id, serializeLifecycleTransitionSelector(selector), JSON.stringify(patch)],
  );
  return result.rows[0] ? rowToJob(result.rows[0]) : null;
}

export class HumanWorkflowCompileJobService {
  private runner: HumanWorkflowCompileJobRunner | null = null;
  private owner = crypto.randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  configureRunner(runner: HumanWorkflowCompileJobRunner): void {
    this.runner = runner;
  }

  async createOrGet(input: {
    requestKey: string;
    deviceId: string;
    accountId: string | null;
    intent: string;
    platform: string;
  }): Promise<HumanWorkflowCompileJobRecord> {
    const payloadHash = requestPayloadHash(input);
    const result = await getDb().query(
      `WITH inserted AS (
         INSERT INTO human_workflow_compile_jobs
           (request_key, device_id, account_id, intent, platform, source, timeout_ms,
            request_payload_hash)
         VALUES ($1, $2, $3, $4, $5, 'llm', $6, $7)
         ON CONFLICT (request_key) DO NOTHING
         RETURNING *
       )
       SELECT *, false AS reused FROM inserted
       UNION ALL
       SELECT existing.*, true AS reused
         FROM human_workflow_compile_jobs existing
        WHERE existing.request_key = $1
          AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [
        input.requestKey,
        input.deviceId,
        input.accountId,
        input.intent,
        input.platform,
        humanWorkflowCompileTimeoutMs(),
        payloadHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("compile job insert/replay returned no row");
    if (
      row.reused === true
      && (
        (row.request_payload_hash !== null && row.request_payload_hash !== payloadHash)
        || row.device_id !== input.deviceId
        || (row.account_id ?? null) !== input.accountId
        || row.intent !== input.intent
        || row.platform !== input.platform
      )
    ) {
      await getDb().query(
        `INSERT INTO human_workflow_compile_job_events
           (job_id, event_key, lease_generation, metadata)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          row.id,
          "idempotency_conflict",
          row.lease_generation,
          JSON.stringify({ presentedPayloadHash: payloadHash }),
        ],
      );
      throw idempotencyConflict();
    }
    if (row.request_payload_hash === null) {
      const backfilled = await getDb().query(
        `UPDATE human_workflow_compile_jobs
            SET request_payload_hash = $2,
                updated_at = NOW()
          WHERE id = $1
            AND request_payload_hash IS NULL
          RETURNING *`,
        [row.id, payloadHash],
      );
      if (backfilled.rows[0]) return rowToJob(backfilled.rows[0]);
      const reread = await getDb().query(
        "SELECT * FROM human_workflow_compile_jobs WHERE id = $1",
        [row.id],
      );
      if (!reread.rows[0]?.request_payload_hash
          || reread.rows[0].request_payload_hash !== payloadHash) {
        throw idempotencyConflict();
      }
      return rowToJob(reread.rows[0]);
    }
    return rowToJob(row);
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

  private async claimOne(policy: HumanWorkflowCompileJobRuntimePolicy): Promise<HumanWorkflowCompileJobRecord | null> {
    const result = await getDb().query(
      `WITH locked AS (
         SELECT job.id, job.status, job.lifecycle_key, definition.dispatchable
           FROM human_workflow_compile_jobs job
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = job.lifecycle_key
            AND definition.status = job.status
          WHERE NOT definition.terminal
            AND job.lease_generation < $4
            AND (
              (definition.dispatchable AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= NOW()))
              OR (job.lease_expires_at <= NOW())
            )
          ORDER BY job.created_at, job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
       ),
       candidate AS (
         SELECT locked.id, locked.status, locked.dispatchable,
                target.status AS to_status,
                COUNT(target.status) OVER (PARTITION BY locked.id) AS transition_count
           FROM locked
           LEFT JOIN lifecycle_transitions transition
             ON transition.lifecycle_key = locked.lifecycle_key
            AND transition.from_status = locked.status
            AND transition.automatic
           LEFT JOIN lifecycle_state_definitions target
             ON target.lifecycle_key = transition.lifecycle_key
            AND target.status = transition.to_status
            AND NOT target.terminal
       ),
       claimable AS (
         SELECT *
           FROM candidate
          WHERE NOT dispatchable OR transition_count = 1
       ),
       claimed AS (
         UPDATE human_workflow_compile_jobs job
            SET status = CASE WHEN claimable.dispatchable THEN claimable.to_status ELSE job.status END,
                lease_owner = $1,
                lease_generation = job.lease_generation + 1,
                lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
                lease_heartbeat_at = NOW(),
                claimed_at = NOW(),
                execution_attempt_id = gen_random_uuid(),
                llm_started_at = COALESCE(job.llm_started_at, NOW()),
                updated_at = NOW()
           FROM claimable
          WHERE job.id = claimable.id
          RETURNING job.*
       ),
       audited AS (
         INSERT INTO human_workflow_compile_job_events
           (job_id, event_key, lease_owner, lease_generation, policy_version, metadata)
         SELECT id, $5, lease_owner, lease_generation, $3, '{}'::jsonb
           FROM claimed
       )
       SELECT * FROM claimed`,
      [
        this.owner,
        policy.leaseDurationMs,
        policy.version,
        policy.maxAttempts,
        "lease_claimed",
      ],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  private async renewLease(
    jobId: string,
    generation: number,
    policy: HumanWorkflowCompileJobRuntimePolicy,
  ): Promise<boolean> {
    const result = await getDb().query(
      `UPDATE human_workflow_compile_jobs
          SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
              lease_heartbeat_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND lease_generation = $3
          AND lease_expires_at > NOW()
        RETURNING id`,
      [jobId, this.owner, generation, policy.leaseDurationMs],
    );
    return result.rows.length === 1;
  }

  private async finishClaim(
    job: HumanWorkflowCompileJobRecord,
    outcome: {
      result?: Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null };
      error?: Error & { validationErrors?: string[]; debugPayload?: Record<string, unknown> };
    },
  ): Promise<boolean> {
    const success = !!outcome.result;
    const validationDetail = outcome.error?.validationErrors?.length
      ? `: ${outcome.error.validationErrors.slice(0, 6).join("; ")}`
      : "";
    const patch = success
      ? {
          cacheKey: outcome.result?.cacheKey ?? null,
          shortcutId: outcome.result?.shortcutId ?? null,
          result: outcome.result,
        }
      : {
          error: `${outcome.error?.message ?? "compile worker failed"}${validationDetail}`,
          appendDebug: outcome.error?.debugPayload ?? null,
        };
    const selector: LifecycleTransitionSelector = success
      ? {
          targetTerminal: true,
          targetRetryable: false,
          transitionMarkCompleted: true,
          transitionClearFailure: true,
        }
      : {
          targetTerminal: true,
          targetRetryable: true,
          transitionAutomatic: true,
          transitionMarkCompleted: true,
        };
    const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$5");
    const result = await getDb().query(
      `WITH locked AS (
         SELECT *
           FROM human_workflow_compile_jobs
          WHERE id = $1
            AND lease_owner = $2
            AND lease_generation = $3
          FOR UPDATE
       ),
       candidates AS (
         SELECT locked.id, transition.to_status,
                COUNT(*) OVER (PARTITION BY locked.id) AS candidate_count
           FROM locked
           JOIN lifecycle_transitions transition
             ON transition.lifecycle_key = locked.lifecycle_key
            AND transition.from_status = locked.status
           JOIN lifecycle_state_definitions target
             ON target.lifecycle_key = transition.lifecycle_key
            AND target.status = transition.to_status
          WHERE ${selectorPredicate}
       ),
       completed AS (
         UPDATE human_workflow_compile_jobs job
            SET status = candidates.to_status,
                cache_key = CASE WHEN $4::jsonb ? 'cacheKey'
                  THEN NULLIF($4::jsonb->>'cacheKey', '') ELSE job.cache_key END,
                shortcut_id = CASE WHEN $4::jsonb ? 'shortcutId'
                  THEN NULLIF($4::jsonb->>'shortcutId', '')::uuid ELSE job.shortcut_id END,
                source = CASE WHEN $6::boolean THEN 'llm' ELSE job.source END,
                result = CASE
                  WHEN $4::jsonb ? 'result' THEN COALESCE($4::jsonb->'result', '{}'::jsonb)
                  WHEN $4::jsonb ? 'appendDebug' THEN
                    COALESCE(job.result, '{}'::jsonb)
                    || jsonb_build_object(
                      'llmDebug', $4::jsonb->'appendDebug'->'llmDebug',
                      'llmDebugHistory', COALESCE(job.result->'llmDebugHistory', '[]'::jsonb)
                        || jsonb_build_array($4::jsonb->'appendDebug'->'llmDebug')
                    )
                  ELSE job.result
                END,
                error = CASE WHEN $6::boolean THEN NULL ELSE $4::jsonb->>'error' END,
                llm_completed_at = NOW(),
                completed_at = NOW(),
                lease_owner = NULL,
                lease_expires_at = NULL,
                lease_heartbeat_at = NULL,
                updated_at = NOW()
           FROM candidates
          WHERE job.id = candidates.id
            AND candidates.candidate_count = 1
            AND job.lease_owner = $2
            AND job.lease_generation = $3
          RETURNING job.*
       ),
       audited AS (
         INSERT INTO human_workflow_compile_job_events
           (job_id, event_key, lease_owner, lease_generation, metadata)
         SELECT $1, CASE WHEN EXISTS (SELECT 1 FROM completed) THEN $7 ELSE $8 END,
                $2, $3, '{}'::jsonb
       )
       SELECT * FROM completed`,
      [
        job.id,
        this.owner,
        job.leaseGeneration,
        JSON.stringify(patch),
        serializeLifecycleTransitionSelector(selector),
        success,
        "lease_completed",
        "stale_generation_rejected",
      ],
    );
    return result.rows.length === 1;
  }

  private async executeClaim(
    job: HumanWorkflowCompileJobRecord,
    policy: HumanWorkflowCompileJobRuntimePolicy,
  ): Promise<void> {
    if (!this.runner) throw new Error("human workflow compile-job runner is not configured");
    let ownsLease = true;
    const heartbeat = setInterval(() => {
      void this.renewLease(job.id, job.leaseGeneration, policy).then((renewed) => {
        ownsLease = renewed;
      }).catch(() => {
        ownsLease = false;
      });
    }, policy.heartbeatIntervalMs);
    try {
      const result = await this.runner(job);
      if (ownsLease) await this.finishClaim(job, { result });
    } catch (error) {
      if (ownsLease) {
        await this.finishClaim(job, {
          error: error as Error & { validationErrors?: string[]; debugPayload?: Record<string, unknown> },
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async reconcileOnce(): Promise<number> {
    if (!this.runner) throw new Error("human workflow compile-job runner is not configured");
    const policy = await humanWorkflowCompileJobRuntimePolicy();
    let claimed = 0;
    for (; claimed < policy.batchSize; claimed += 1) {
      const job = await this.claimOne(policy);
      if (!job) break;
      void this.executeClaim(job, policy);
    }
    return claimed;
  }

  async startReconciler(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const schedule = async (): Promise<void> => {
      if (this.stopped) return;
      const policy = await humanWorkflowCompileJobRuntimePolicy();
      await this.reconcileOnce();
      if (!this.stopped) {
        this.timer = setTimeout(() => void schedule().catch(() => {
          this.stopped = true;
        }), policy.reconcileIntervalMs);
      }
    };
    await schedule();
  }

  stopReconciler(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  runInProcess(
    _jobId: string,
    _runner: () => Promise<Record<string, unknown> & { cacheKey?: string; shortcutId?: string | null }>,
  ): void {
    void this.reconcileOnce().catch((error) => {
      console.error("[human-compile-reconciler] wake failed:", (error as Error).message);
    });
  }
}

export const humanWorkflowCompileJobService = new HumanWorkflowCompileJobService();
