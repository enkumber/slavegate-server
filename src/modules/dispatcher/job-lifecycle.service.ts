import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleKeys,
  listLifecycleStates,
  type LifecycleStateDefinition,
} from "../lifecycle/lifecycle.service";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface JobLifecyclePatch {
  output?: unknown;
  error?: string | null;
  durationMs?: number;
  startedAt?: Date | null;
}

export interface JobLifecycleRow extends Record<string, unknown> {
  id: string;
  device_id: string;
  status: string;
}

export async function listJobStatusDefinitions(
  db: Queryable = getDb(),
): Promise<LifecycleStateDefinition[]> {
  return listLifecycleStates(lifecycleKeys.dispatcherJob, db);
}

export async function transitionJob(
  jobId: string,
  actionKey: string,
  patch: JobLifecyclePatch = {},
  db: Queryable = getDb(),
  expectedDeviceId: string | null = null,
): Promise<JobLifecycleRow | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT j.id, transition.*
         FROM jobs j
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = j.lifecycle_key
          AND transition.from_status = j.status
          AND transition.action_key = $2
        WHERE j.id = $1
          AND j.lifecycle_key = $4
          AND ($5::text IS NULL OR j.device_id = $5)
        FOR UPDATE OF j
     )
     UPDATE jobs
        SET status = selected.to_status,
            started_at = CASE
              WHEN $3::jsonb ? 'startedAt' THEN ($3::jsonb->>'startedAt')::timestamptz
              WHEN selected.mark_started THEN COALESCE(jobs.started_at, NOW())
              ELSE jobs.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE jobs.completed_at
            END,
            output = CASE WHEN $3::jsonb ? 'output' THEN $3::jsonb->'output' ELSE jobs.output END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE jobs.error
            END,
            duration_ms = CASE
              WHEN $3::jsonb ? 'durationMs' THEN ($3::jsonb->>'durationMs')::integer
              ELSE jobs.duration_ms
            END
       FROM selected
      WHERE jobs.id = selected.id
      RETURNING jobs.*`,
    [jobId, actionKey, JSON.stringify(serializePatch(patch)), lifecycleKeys.dispatcherJob, expectedDeviceId],
  );
  return (result.rows[0] as JobLifecycleRow | undefined) ?? null;
}

export async function transitionJobFromExternalStatus(
  jobId: string,
  targetStatus: string,
  patch: JobLifecyclePatch = {},
  db: Queryable = getDb(),
  expectedDeviceId: string | null = null,
): Promise<JobLifecycleRow | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT j.id, transition.*
         FROM jobs j
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = j.lifecycle_key
          AND transition.from_status = j.status
          AND transition.to_status = $2
          AND transition.external_allowed
        WHERE j.id = $1
          AND j.lifecycle_key = $4
          AND ($5::text IS NULL OR j.device_id = $5)
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF j
     )
     UPDATE jobs
        SET status = selected.to_status,
            started_at = CASE
              WHEN $3::jsonb ? 'startedAt' THEN ($3::jsonb->>'startedAt')::timestamptz
              WHEN selected.mark_started THEN COALESCE(jobs.started_at, NOW())
              ELSE jobs.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE jobs.completed_at
            END,
            output = CASE WHEN $3::jsonb ? 'output' THEN $3::jsonb->'output' ELSE jobs.output END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE jobs.error
            END,
            duration_ms = CASE
              WHEN $3::jsonb ? 'durationMs' THEN ($3::jsonb->>'durationMs')::integer
              ELSE jobs.duration_ms
            END
       FROM selected
      WHERE jobs.id = selected.id
      RETURNING jobs.*`,
    [jobId, targetStatus, JSON.stringify(serializePatch(patch)), lifecycleKeys.dispatcherJob, expectedDeviceId],
  );
  return (result.rows[0] as JobLifecycleRow | undefined) ?? null;
}

export async function transitionJobManually(
  jobId: string,
  targetStatus: string,
  db: Queryable = getDb(),
): Promise<JobLifecycleRow | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT j.id, transition.*
         FROM jobs j
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = j.lifecycle_key
          AND transition.from_status = j.status
          AND transition.to_status = $2
          AND transition.manual_allowed
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
          AND target.manual
        WHERE j.id = $1
          AND j.lifecycle_key = $3
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF j
     )
     UPDATE jobs
        SET status = selected.to_status,
            started_at = CASE WHEN selected.mark_started THEN COALESCE(jobs.started_at, NOW()) ELSE jobs.started_at END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE jobs.completed_at
            END,
            error = CASE WHEN selected.clear_failure THEN NULL ELSE jobs.error END
       FROM selected
      WHERE jobs.id = selected.id
      RETURNING jobs.*`,
    [jobId, targetStatus, lifecycleKeys.dispatcherJob],
  );
  return (result.rows[0] as JobLifecycleRow | undefined) ?? null;
}

export async function expireStaleJobs(
  db: Queryable = getDb(),
): Promise<JobLifecycleRow[]> {
  const result = await db.query(
    `WITH candidates AS (
       SELECT j.id, transition.to_status, transition.mark_completed
         FROM jobs j
         JOIN lifecycle_state_definitions state
           ON state.lifecycle_key = j.lifecycle_key
          AND state.status = j.status
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = j.lifecycle_key
          AND transition.from_status = j.status
          AND transition.action_key = state.stale_action_key
          AND transition.automatic
        WHERE j.lifecycle_key = $1
          AND state.stale_after_ms IS NOT NULL
          AND j.created_at + (state.stale_after_ms * INTERVAL '1 millisecond') <= NOW()
        FOR UPDATE OF j SKIP LOCKED
     )
     UPDATE jobs
        SET status = candidates.to_status,
            completed_at = CASE WHEN candidates.mark_completed THEN NOW() ELSE jobs.completed_at END,
            error = COALESCE(jobs.error, 'Lifecycle deadline exceeded before execution')
       FROM candidates
      WHERE jobs.id = candidates.id
      RETURNING jobs.*`,
    [lifecycleKeys.dispatcherJob],
  );
  return result.rows as JobLifecycleRow[];
}

function serializePatch(patch: JobLifecyclePatch): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...patch };
  if (patch.startedAt instanceof Date) {
    serialized.startedAt = patch.startedAt.toISOString();
  } else {
    delete serialized.startedAt;
  }
  return serialized;
}
