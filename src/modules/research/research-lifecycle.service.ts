import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";

type Queryable = Pick<Pool | PoolClient, "query">;

interface ResearchLifecyclePatch {
  deviceId?: string | null;
  output?: unknown;
  error?: string | null;
  expiresAt?: string | null;
  scheduledAtNow?: boolean;
}

export async function transitionResearchJob(
  jobId: string,
  selector: LifecycleTransitionSelector,
  patch: ResearchLifecyclePatch = {},
  db: Queryable = getDb(),
): Promise<Record<string, unknown> | null> {
  const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await db.query(
    `WITH locked AS (
       SELECT job.*
         FROM research_jobs job
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
     UPDATE research_jobs job
        SET status = selected.to_status,
            device_id = CASE
              WHEN selected.reset_retry THEN NULL
              WHEN $3::jsonb ? 'deviceId' THEN ($3::jsonb->>'deviceId')::uuid
              ELSE job.device_id
            END,
            scheduled_at = CASE
              WHEN COALESCE(($3::jsonb->>'scheduledAtNow')::boolean, FALSE) THEN NOW()
              WHEN selected.reset_retry THEN NULL
              ELSE job.scheduled_at
            END,
            started_at = CASE
              WHEN selected.mark_started THEN COALESCE(job.started_at, NOW())
              WHEN selected.reset_retry THEN NULL
              ELSE job.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE job.completed_at
            END,
            output = CASE WHEN $3::jsonb ? 'output' THEN $3::jsonb->'output' ELSE job.output END,
            expires_at = CASE
              WHEN $3::jsonb ? 'expiresAt' THEN ($3::jsonb->>'expiresAt')::timestamptz
              ELSE job.expires_at
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE job.error
            END
       FROM selected
      WHERE job.id = selected.id
      RETURNING job.*`,
    [jobId, serializeLifecycleTransitionSelector(selector), JSON.stringify(patch)],
  );
  return result.rows[0] ?? null;
}
