import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  listResourceLifecycleStates,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
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
  return listResourceLifecycleStates("workflows", "status", db);
}

export async function transitionWorkflow(
  workflowId: string,
  selector: LifecycleTransitionSelector,
  patch: WorkflowLifecyclePatch = {},
  db: Queryable = getDb(),
): Promise<WorkflowLifecycleRow | null> {
  return transitionWorkflowWhere(workflowId, selector, patch, db);
}

export async function transitionWorkflowWhere(
  workflowId: string,
  selector: LifecycleTransitionSelector,
  patch: WorkflowLifecyclePatch,
  db: Queryable = getDb(),
  extraPredicate = "TRUE",
  extraParams: unknown[] = [],
): Promise<WorkflowLifecycleRow | null> {
  const patchIndex = extraParams.length + 2;
  const selectorIndex = extraParams.length + 3;
  const selectorPredicate = lifecycleTransitionSelectorPredicate(
    "transition",
    "target",
    `$${selectorIndex}`,
  );
  const result = await db.query(
    `WITH locked AS (
       SELECT workflow.*
         FROM workflows workflow
        WHERE workflow.id = $1
          AND (${extraPredicate})
        FOR UPDATE
     ),
     candidates AS (
       SELECT DISTINCT workflow.id, transition.to_status, transition.mark_started,
              transition.mark_completed, transition.clear_completed,
              transition.clear_failure, transition.reset_retry
         FROM locked workflow
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = workflow.lifecycle_key
          AND transition.from_status = workflow.status
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
    [
      workflowId,
      ...extraParams,
      JSON.stringify(patch),
      serializeLifecycleTransitionSelector(selector),
    ],
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
    [workflowId, targetStatus, JSON.stringify(patch)],
  );
  return (result.rows[0] as WorkflowLifecycleRow | undefined) ?? null;
}
