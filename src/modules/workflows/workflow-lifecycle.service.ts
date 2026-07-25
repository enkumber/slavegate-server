import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleKeys,
  listLifecycleStates,
  type LifecycleStateDefinition,
} from "../lifecycle/lifecycle.service";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface WorkflowLifecyclePatch {
  checkpoint?: unknown;
  currentStep?: number;
  totalSteps?: number | null;
  error?: string | null;
}

export interface WorkflowLifecycleRow extends Record<string, unknown> {
  id: string;
  status: string;
}

export async function listWorkflowStatusDefinitions(
  db: Queryable = getDb(),
): Promise<LifecycleStateDefinition[]> {
  return listLifecycleStates(lifecycleKeys.workflowExecution, db);
}

export async function transitionWorkflow(
  workflowId: string,
  actionKey: string,
  patch: WorkflowLifecyclePatch = {},
  db: Queryable = getDb(),
): Promise<WorkflowLifecycleRow | null> {
  return transitionWorkflowWhere(workflowId, actionKey, patch, db);
}

export async function transitionWorkflowWhere(
  workflowId: string,
  actionKey: string,
  patch: WorkflowLifecyclePatch,
  db: Queryable = getDb(),
  extraPredicate = "TRUE",
  extraParams: unknown[] = [],
): Promise<WorkflowLifecycleRow | null> {
  const patchIndex = extraParams.length + 3;
  const result = await db.query(
    `WITH selected AS (
       SELECT workflow.id, transition.*
         FROM workflows workflow
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = workflow.lifecycle_key
          AND transition.from_status = workflow.status
          AND transition.action_key = $2
        WHERE workflow.id = $1
          AND workflow.lifecycle_key = $${extraParams.length + 4}
          AND (${extraPredicate})
        FOR UPDATE OF workflow
     )
     UPDATE workflows workflow
        SET status = selected.to_status,
            started_at = CASE
              WHEN selected.mark_started THEN COALESCE(workflow.started_at, NOW())
              ELSE workflow.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE workflow.completed_at
            END,
            checkpoint = CASE
              WHEN $${patchIndex}::jsonb ? 'checkpoint' THEN $${patchIndex}::jsonb->'checkpoint'
              ELSE workflow.checkpoint
            END,
            current_step = CASE
              WHEN $${patchIndex}::jsonb ? 'currentStep' THEN ($${patchIndex}::jsonb->>'currentStep')::integer
              ELSE workflow.current_step
            END,
            total_steps = CASE
              WHEN $${patchIndex}::jsonb ? 'totalSteps' THEN ($${patchIndex}::jsonb->>'totalSteps')::integer
              ELSE workflow.total_steps
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $${patchIndex}::jsonb ? 'error' THEN $${patchIndex}::jsonb->>'error'
              ELSE workflow.error
            END
       FROM selected
      WHERE workflow.id = selected.id
      RETURNING workflow.*`,
    [workflowId, actionKey, ...extraParams, JSON.stringify(patch), lifecycleKeys.workflowExecution],
  );
  return (result.rows[0] as WorkflowLifecycleRow | undefined) ?? null;
}

export async function transitionWorkflowFromExternalStatus(
  workflowId: string,
  targetStatus: string,
  patch: WorkflowLifecyclePatch = {},
  db: Queryable = getDb(),
): Promise<WorkflowLifecycleRow | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT workflow.id, transition.*
         FROM workflows workflow
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = workflow.lifecycle_key
          AND transition.from_status = workflow.status
          AND transition.to_status = $2
          AND transition.external_allowed
        WHERE workflow.id = $1
          AND workflow.lifecycle_key = $4
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF workflow
     )
     UPDATE workflows workflow
        SET status = selected.to_status,
            started_at = CASE
              WHEN selected.mark_started THEN COALESCE(workflow.started_at, NOW())
              ELSE workflow.started_at
            END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE workflow.completed_at
            END,
            checkpoint = CASE
              WHEN $3::jsonb ? 'checkpoint' THEN $3::jsonb->'checkpoint'
              ELSE workflow.checkpoint
            END,
            current_step = CASE
              WHEN $3::jsonb ? 'currentStep' THEN ($3::jsonb->>'currentStep')::integer
              ELSE workflow.current_step
            END,
            total_steps = CASE
              WHEN $3::jsonb ? 'totalSteps' THEN ($3::jsonb->>'totalSteps')::integer
              ELSE workflow.total_steps
            END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE workflow.error
            END
       FROM selected
      WHERE workflow.id = selected.id
      RETURNING workflow.*`,
    [workflowId, targetStatus, JSON.stringify(patch), lifecycleKeys.workflowExecution],
  );
  return (result.rows[0] as WorkflowLifecycleRow | undefined) ?? null;
}
