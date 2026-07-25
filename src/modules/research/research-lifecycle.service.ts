import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import { lifecycleKeys } from "../lifecycle/lifecycle.service";

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
  actionKey: string,
  patch: ResearchLifecyclePatch = {},
  db: Queryable = getDb(),
): Promise<Record<string, unknown> | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT job.id, transition.*
         FROM research_jobs job
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = job.lifecycle_key
          AND transition.from_status = job.status
          AND transition.action_key = $2
        WHERE job.id = $1
          AND job.lifecycle_key = $4
        FOR UPDATE OF job
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
    [jobId, actionKey, JSON.stringify(patch), lifecycleKeys.researchJob],
  );
  return result.rows[0] ?? null;
}
