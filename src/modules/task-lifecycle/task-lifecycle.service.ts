import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleKeys,
  listLifecycleStates,
  getLifecycleState,
} from "../lifecycle/lifecycle.service";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface TaskStatusDefinition {
  status: string;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
  manual: boolean;
  description: string | null;
}

export type TaskLifecycleAction = string;

export interface TaskTransitionPatch {
  result?: Record<string, unknown>;
  error?: string | null;
  retryCount?: number;
  rootErrorCode?: string | null;
  rootErrorMessage?: string | null;
  rootErrorDetails?: Record<string, unknown>;
}

function rowToDefinition(row: Record<string, unknown>): TaskStatusDefinition {
  return {
    status: String(row.status),
    terminal: row.terminal === true,
    retryable: row.retryable === true,
    administrative: row.administrative === true,
    dispatchable: row.dispatchable === true,
    manual: row.manual === true,
    description: typeof row.description === "string" ? row.description : null,
  };
}

export async function getStatusDefinition(status: string, db: Queryable = getDb()): Promise<TaskStatusDefinition | null> {
  const definition = await getLifecycleState(lifecycleKeys.task, status, db);
  return definition ? {
    status: definition.status,
    terminal: definition.terminal,
    retryable: definition.retryable,
    administrative: definition.administrative,
    dispatchable: definition.dispatchable,
    manual: definition.manual,
    description: definition.description,
  } : null;
}

export async function listStatusDefinitions(db: Queryable = getDb()): Promise<TaskStatusDefinition[]> {
  const definitions = await listLifecycleStates(lifecycleKeys.task, db);
  return definitions.map((definition) => ({
    status: definition.status,
    terminal: definition.terminal,
    retryable: definition.retryable,
    administrative: definition.administrative,
    dispatchable: definition.dispatchable,
    manual: definition.manual,
    description: definition.description,
  }));
}

export async function isTransitionAllowed(from: string, to: string, db: Queryable = getDb()): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM lifecycle_transitions transition
        WHERE transition.lifecycle_key = $1
          AND transition.from_status = $2
          AND transition.to_status = $3
     ) AS allowed`,
    [lifecycleKeys.task, from, to],
  );
  return result.rows[0]?.allowed === true;
}

export async function getAllowedTransitions(from: string, db: Queryable = getDb()): Promise<TaskStatusDefinition[]> {
  const result = await db.query(
    `SELECT target.status, target.terminal, target.retryable, target.administrative,
            target.dispatchable, target.manual, target.description
       FROM lifecycle_transitions transition
       JOIN lifecycle_state_definitions target
         ON target.lifecycle_key = transition.lifecycle_key
        AND target.status = transition.to_status
      WHERE transition.lifecycle_key = $1
        AND transition.from_status = $2
      ORDER BY target.sort_order, target.status`,
    [lifecycleKeys.task, from],
  );
  return result.rows.map(rowToDefinition);
}

export async function transitionTask<T extends Record<string, unknown> = Record<string, unknown>>(
  taskId: string,
  action: TaskLifecycleAction,
  patch: TaskTransitionPatch = {},
  db: Queryable = getDb(),
): Promise<T | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT t.id, transition.*
         FROM tasks t
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = t.lifecycle_key
          AND transition.from_status = t.status
          AND transition.action_key = $2
        WHERE t.id = $1
          AND t.lifecycle_key = $4
        FOR UPDATE OF t
     )
     UPDATE tasks
        SET status = selected.to_status,
            started_at = CASE WHEN selected.mark_started THEN COALESCE(tasks.started_at, NOW()) ELSE tasks.started_at END,
            completed_at = CASE
              WHEN selected.mark_completed THEN NOW()
              WHEN selected.clear_completed THEN NULL
              ELSE tasks.completed_at
            END,
            retry_count = CASE
              WHEN selected.reset_retry THEN 0
              WHEN $3::jsonb ? 'retryCount' THEN ($3::jsonb->>'retryCount')::integer
              ELSE tasks.retry_count
            END,
            result = CASE WHEN $3::jsonb ? 'result' THEN $3::jsonb->'result' ELSE tasks.result END,
            error = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'error' THEN $3::jsonb->>'error'
              ELSE tasks.error
            END,
            root_error_code = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'rootErrorCode' THEN $3::jsonb->>'rootErrorCode'
              ELSE tasks.root_error_code
            END,
            root_error_message = CASE
              WHEN selected.clear_failure THEN NULL
              WHEN $3::jsonb ? 'rootErrorMessage' THEN $3::jsonb->>'rootErrorMessage'
              ELSE tasks.root_error_message
            END,
            root_error_details = CASE
              WHEN selected.clear_failure THEN '{}'::jsonb
              WHEN $3::jsonb ? 'rootErrorDetails' THEN $3::jsonb->'rootErrorDetails'
              ELSE tasks.root_error_details
            END,
            updated_at = NOW()
       FROM selected
      WHERE tasks.id = selected.id
      RETURNING tasks.*`,
    [taskId, action, JSON.stringify(patch), lifecycleKeys.task],
  );
  return (result.rows[0] as T | undefined) ?? null;
}

export async function transitionTaskManually<T extends Record<string, unknown> = Record<string, unknown>>(
  taskId: string,
  targetStatus: string,
  db: Queryable = getDb(),
): Promise<T | null> {
  const result = await db.query(
    `WITH selected AS (
       SELECT transition.action_key
         FROM tasks t
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = t.lifecycle_key
          AND transition.from_status = t.status
          AND transition.to_status = $2
          AND transition.manual_allowed
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
          AND target.manual
        WHERE t.id = $1
          AND t.lifecycle_key = $3
        ORDER BY transition.action_key
        LIMIT 1
     )
     SELECT selected.action_key FROM selected`,
    [taskId, targetStatus, lifecycleKeys.task],
  );
  const action = result.rows[0]?.action_key;
  if (typeof action !== "string") return null;
  return transitionTask<T>(taskId, action as TaskLifecycleAction, {}, db);
}

export async function retryConfiguredTasks(
  action: TaskLifecycleAction = "retry",
  db: Queryable = getDb(),
): Promise<number> {
  const result = await db.query(`
    WITH candidates AS (
      SELECT t.id, t.status AS from_status
        FROM tasks t
        JOIN lifecycle_state_definitions state
          ON state.lifecycle_key = t.lifecycle_key
         AND state.status = t.status
        JOIN lifecycle_transitions transition
          ON transition.lifecycle_key = t.lifecycle_key
         AND transition.from_status = t.status
         AND transition.action_key = $1
       WHERE t.lifecycle_key = $2
         AND state.retryable
       FOR UPDATE OF t SKIP LOCKED
    ),
    updated AS (
      UPDATE tasks t
         SET status = transition.to_status,
             retry_count = CASE WHEN transition.reset_retry THEN 0 ELSE t.retry_count END,
             completed_at = CASE WHEN transition.clear_completed THEN NULL ELSE t.completed_at END,
             error = CASE WHEN transition.clear_failure THEN NULL ELSE t.error END,
             root_error_code = CASE WHEN transition.clear_failure THEN NULL ELSE t.root_error_code END,
             root_error_message = CASE WHEN transition.clear_failure THEN NULL ELSE t.root_error_message END,
             root_error_details = CASE WHEN transition.clear_failure THEN '{}'::jsonb ELSE t.root_error_details END,
             updated_at = NOW()
        FROM candidates
        JOIN lifecycle_transitions transition
          ON transition.lifecycle_key = $2
         AND transition.from_status = candidates.from_status
         AND transition.action_key = $1
       WHERE t.id = candidates.id
       RETURNING t.id
    )
    SELECT COUNT(*)::int AS count FROM updated
  `, [action, lifecycleKeys.task]);
  return Number(result.rows[0]?.count ?? 0);
}

export async function getConfiguredRetryStats(
  maxRetries: number,
  db: Queryable = getDb(),
): Promise<{ totalFailed: number; retryableCount: number; exhaustedCount: number }> {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(t.retry_count, 0) < $1)::int AS retryable,
      COUNT(*) FILTER (WHERE COALESCE(t.retry_count, 0) >= $1)::int AS exhausted
      FROM tasks t
      JOIN lifecycle_state_definitions state
        ON state.lifecycle_key = t.lifecycle_key
       AND state.status = t.status
     WHERE t.lifecycle_key = $2
       AND state.retryable
  `, [maxRetries, lifecycleKeys.task]);
  return {
    totalFailed: Number(result.rows[0]?.total ?? 0),
    retryableCount: Number(result.rows[0]?.retryable ?? 0),
    exhaustedCount: Number(result.rows[0]?.exhausted ?? 0),
  };
}
