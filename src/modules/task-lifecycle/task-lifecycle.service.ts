import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  listResourceLifecycleStates,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
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
  const result = await db.query(
    `SELECT state.status, state.terminal, state.retryable, state.administrative,
            state.dispatchable, state.manual, state.description
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key = binding.lifecycle_key
      WHERE binding.resource_table = to_regclass($1)
        AND state.status = $2`,
    ["tasks", status],
  );
  return result.rows[0] ? rowToDefinition(result.rows[0]) : null;
}

export async function listStatusDefinitions(db: Queryable = getDb()): Promise<TaskStatusDefinition[]> {
  const definitions = await listResourceLifecycleStates("tasks", db);
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
         FROM lifecycle_resource_bindings binding
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = binding.lifecycle_key
        WHERE binding.resource_table = to_regclass($1)
          AND transition.from_status = $2
          AND transition.to_status = $3
     ) AS allowed`,
    ["tasks", from, to],
  );
  return result.rows[0]?.allowed === true;
}

export async function getAllowedTransitions(from: string, db: Queryable = getDb()): Promise<TaskStatusDefinition[]> {
  const result = await db.query(
    `SELECT target.status, target.terminal, target.retryable, target.administrative,
            target.dispatchable, target.manual, target.description
       FROM lifecycle_transitions transition
       JOIN lifecycle_resource_bindings binding
         ON binding.lifecycle_key = transition.lifecycle_key
       JOIN lifecycle_state_definitions target
         ON target.lifecycle_key = transition.lifecycle_key
        AND target.status = transition.to_status
      WHERE binding.resource_table = to_regclass($1)
        AND transition.from_status = $2
      ORDER BY target.sort_order, target.status`,
    ["tasks", from],
  );
  return result.rows.map(rowToDefinition);
}

export async function transitionTask<T extends Record<string, unknown> = Record<string, unknown>>(
  taskId: string,
  selector: LifecycleTransitionSelector,
  patch: TaskTransitionPatch = {},
  db: Queryable = getDb(),
): Promise<T | null> {
  const selectorPredicate = lifecycleTransitionSelectorPredicate("transition", "target", "$2");
  const result = await db.query(
    `WITH locked AS (
       SELECT t.*
         FROM tasks t
        WHERE t.id = $1
        FOR UPDATE
     ),
     candidates AS (
       SELECT DISTINCT t.id, transition.to_status, transition.mark_started,
              transition.mark_completed, transition.clear_completed,
              transition.clear_failure, transition.reset_retry
         FROM locked t
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = t.lifecycle_key
          AND transition.from_status = t.status
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
    [taskId, serializeLifecycleTransitionSelector(selector), JSON.stringify(patch)],
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
       SELECT t.id, transition.*
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
        ORDER BY transition.action_key
        LIMIT 1
     ),
     updated AS (
       UPDATE tasks
          SET status = selected.to_status,
              started_at = CASE WHEN selected.mark_started THEN COALESCE(tasks.started_at, NOW()) ELSE tasks.started_at END,
              completed_at = CASE
                WHEN selected.mark_completed THEN NOW()
                WHEN selected.clear_completed THEN NULL
                ELSE tasks.completed_at
              END,
              error = CASE WHEN selected.clear_failure THEN NULL ELSE tasks.error END,
              root_error_code = CASE WHEN selected.clear_failure THEN NULL ELSE tasks.root_error_code END,
              root_error_message = CASE WHEN selected.clear_failure THEN NULL ELSE tasks.root_error_message END,
              root_error_details = CASE WHEN selected.clear_failure THEN '{}'::jsonb ELSE tasks.root_error_details END,
              updated_at = NOW()
         FROM selected
        WHERE tasks.id = selected.id
        RETURNING tasks.*
     )
     SELECT * FROM updated`,
    [taskId, targetStatus],
  );
  return (result.rows[0] as T | undefined) ?? null;
}

export async function retryConfiguredTasks(
  db: Queryable = getDb(),
): Promise<number> {
  const result = await db.query(`
    WITH locked AS (
      SELECT t.*
        FROM tasks t
       FOR UPDATE SKIP LOCKED
    ),
    eligible AS (
      SELECT DISTINCT t.id, transition.to_status, transition.reset_retry,
             transition.clear_completed, transition.clear_failure
        FROM locked t
        JOIN lifecycle_state_definitions state
          ON state.lifecycle_key = t.lifecycle_key
         AND state.status = t.status
        JOIN lifecycle_transitions transition
          ON transition.lifecycle_key = t.lifecycle_key
         AND transition.from_status = t.status
         AND transition.reset_retry
         AND transition.clear_completed
         AND transition.clear_failure
        JOIN lifecycle_state_definitions target
          ON target.lifecycle_key = transition.lifecycle_key
         AND target.status = transition.to_status
         AND target.initial
         AND target.dispatchable
       WHERE state.retryable
    ),
    candidates AS (
      SELECT ranked.*
        FROM (
          SELECT eligible.*, COUNT(*) OVER (PARTITION BY id) AS candidate_count
            FROM eligible
        ) ranked
       WHERE ranked.candidate_count = 1
    ),
    updated AS (
      UPDATE tasks t
         SET status = candidates.to_status,
             retry_count = CASE WHEN candidates.reset_retry THEN 0 ELSE t.retry_count END,
             completed_at = CASE WHEN candidates.clear_completed THEN NULL ELSE t.completed_at END,
             error = CASE WHEN candidates.clear_failure THEN NULL ELSE t.error END,
             root_error_code = CASE WHEN candidates.clear_failure THEN NULL ELSE t.root_error_code END,
             root_error_message = CASE WHEN candidates.clear_failure THEN NULL ELSE t.root_error_message END,
             root_error_details = CASE WHEN candidates.clear_failure THEN '{}'::jsonb ELSE t.root_error_details END,
             updated_at = NOW()
        FROM candidates
       WHERE t.id = candidates.id
       RETURNING t.id
    )
    SELECT COUNT(*)::int AS count FROM updated
  `);
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
     WHERE state.retryable
       AND EXISTS (
         SELECT 1
           FROM lifecycle_resource_bindings binding
          WHERE binding.resource_table = to_regclass($2)
            AND binding.lifecycle_key = t.lifecycle_key
       )
  `, [maxRetries, "tasks"]);
  return {
    totalFailed: Number(result.rows[0]?.total ?? 0),
    retryableCount: Number(result.rows[0]?.retryable ?? 0),
    exhaustedCount: Number(result.rows[0]?.exhausted ?? 0),
  };
}
