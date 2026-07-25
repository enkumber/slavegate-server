import type { Pool, PoolClient } from "pg";
import { getDb } from "../../db/client";

export type LifecycleQueryable = Pick<Pool | PoolClient, "query">;

export interface LifecycleStateDefinition {
  lifecycleKey: string;
  status: string;
  initial: boolean;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
  manual: boolean;
  staleAfterMs: number | null;
  staleActionKey: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface LifecycleTransition {
  lifecycleKey: string;
  actionKey: string;
  fromStatus: string;
  toStatus: string;
  manualAllowed: boolean;
  externalAllowed: boolean;
  automatic: boolean;
  markStarted: boolean;
  markCompleted: boolean;
  clearCompleted: boolean;
  clearFailure: boolean;
  resetRetry: boolean;
  metadata: Record<string, unknown>;
}

export const lifecycleKeys = {
  task: "task",
  dispatcherJob: "dispatcher_job",
} as const;

function rowToState(row: Record<string, unknown>): LifecycleStateDefinition {
  return {
    lifecycleKey: String(row.lifecycle_key),
    status: String(row.status),
    initial: row.initial === true,
    terminal: row.terminal === true,
    retryable: row.retryable === true,
    administrative: row.administrative === true,
    dispatchable: row.dispatchable === true,
    manual: row.manual === true,
    staleAfterMs: row.stale_after_ms === null || row.stale_after_ms === undefined
      ? null
      : Number(row.stale_after_ms),
    staleActionKey: typeof row.stale_action_key === "string" ? row.stale_action_key : null,
    description: typeof row.description === "string" ? row.description : null,
    metadata: row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {},
  };
}

function rowToTransition(row: Record<string, unknown>): LifecycleTransition {
  return {
    lifecycleKey: String(row.lifecycle_key),
    actionKey: String(row.action_key),
    fromStatus: String(row.from_status),
    toStatus: String(row.to_status),
    manualAllowed: row.manual_allowed === true,
    externalAllowed: row.external_allowed === true,
    automatic: row.automatic === true,
    markStarted: row.mark_started === true,
    markCompleted: row.mark_completed === true,
    clearCompleted: row.clear_completed === true,
    clearFailure: row.clear_failure === true,
    resetRetry: row.reset_retry === true,
    metadata: row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {},
  };
}

export async function listLifecycleStates(
  lifecycleKey: string,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition[]> {
  const result = await db.query(
    `SELECT lifecycle_key, status, initial, terminal, retryable, administrative,
            dispatchable, manual, stale_after_ms, stale_action_key, description, metadata
       FROM lifecycle_state_definitions
      WHERE lifecycle_key = $1
      ORDER BY sort_order, status`,
    [lifecycleKey],
  );
  return result.rows.map(rowToState);
}

export async function getLifecycleState(
  lifecycleKey: string,
  status: string,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition | null> {
  const result = await db.query(
    `SELECT lifecycle_key, status, initial, terminal, retryable, administrative,
            dispatchable, manual, stale_after_ms, stale_action_key, description, metadata
       FROM lifecycle_state_definitions
      WHERE lifecycle_key = $1 AND status = $2`,
    [lifecycleKey, status],
  );
  return result.rows[0] ? rowToState(result.rows[0]) : null;
}

export async function getLifecycleTransition(
  lifecycleKey: string,
  fromStatus: string,
  actionKey: string,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleTransition | null> {
  const result = await db.query(
    `SELECT lifecycle_key, action_key, from_status, to_status, manual_allowed,
            external_allowed, automatic, mark_started, mark_completed,
            clear_completed, clear_failure, reset_retry, metadata
       FROM lifecycle_transitions
      WHERE lifecycle_key = $1
        AND from_status = $2
        AND action_key = $3`,
    [lifecycleKey, fromStatus, actionKey],
  );
  return result.rows[0] ? rowToTransition(result.rows[0]) : null;
}

export async function listLifecycleTransitions(
  lifecycleKey: string,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleTransition[]> {
  const result = await db.query(
    `SELECT lifecycle_key, action_key, from_status, to_status, manual_allowed,
            external_allowed, automatic, mark_started, mark_completed,
            clear_completed, clear_failure, reset_retry, metadata
       FROM lifecycle_transitions
      WHERE lifecycle_key = $1
      ORDER BY from_status, action_key`,
    [lifecycleKey],
  );
  return result.rows.map(rowToTransition);
}
