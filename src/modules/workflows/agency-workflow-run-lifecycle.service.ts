import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface AgencyWorkflowRunPatch {
  taskId?: string | null;
  workflowId?: string | null;
  output?: unknown;
  tokenUsage?: unknown;
  recoveryRequests?: number;
  error?: string | null;
  rootErrorCode?: string | null;
  rootErrorMessage?: string | null;
  rootErrorDetails?: unknown;
}

export async function transitionAgencyWorkflowRun(
  runId: string,
  selector: LifecycleTransitionSelector,
  patch: AgencyWorkflowRunPatch = {},
  db: Queryable = getDb(),
): Promise<Record<string, unknown> | null> {
  const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await db.query(
    `WITH locked AS (
       SELECT run.*
         FROM agency_workflow_runs run
        WHERE run.id = $1
        FOR UPDATE
     ),
     candidates AS (
       SELECT DISTINCT run.id, transition.to_status, transition.mark_started,
              transition.mark_completed, transition.clear_completed,
              transition.clear_failure, transition.reset_retry
         FROM locked run
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = run.lifecycle_key
          AND transition.from_status = run.status
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
     UPDATE agency_workflow_runs run
        SET status = selected.to_status,
            started_at = CASE
              WHEN selected.mark_started THEN COALESCE(run.started_at, NOW())
              ELSE run.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE run.completed_at
            END,
            updated_at = NOW(),
            task_id = CASE WHEN $3::jsonb ? 'taskId' THEN ($3::jsonb->>'taskId')::uuid ELSE run.task_id END,
            workflow_id = CASE WHEN $3::jsonb ? 'workflowId' THEN ($3::jsonb->>'workflowId')::uuid ELSE run.workflow_id END,
            output = CASE WHEN $3::jsonb ? 'output' THEN $3::jsonb->'output' ELSE run.output END,
            token_usage = CASE WHEN $3::jsonb ? 'tokenUsage' THEN $3::jsonb->'tokenUsage' ELSE run.token_usage END,
            recovery_requests = CASE
              WHEN $3::jsonb ? 'recoveryRequests' THEN ($3::jsonb->>'recoveryRequests')::integer
              ELSE run.recovery_requests
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE run.error
            END,
            root_error_code = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'rootErrorCode' THEN $3::jsonb->>'rootErrorCode'
              ELSE run.root_error_code
            END,
            root_error_message = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'rootErrorMessage' THEN $3::jsonb->>'rootErrorMessage'
              ELSE run.root_error_message
            END,
            root_error_details = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'rootErrorDetails' THEN $3::jsonb->'rootErrorDetails'
              ELSE run.root_error_details
            END
       FROM selected
      WHERE run.id = selected.id
      RETURNING run.*`,
    [runId, serializeLifecycleTransitionSelector(selector), JSON.stringify(patch)],
  );
  return result.rows[0] ?? null;
}
