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

export interface LifecycleStalePolicyUpdate {
  staleAfterMs: number | null;
  staleActionKey: string | null;
}

export interface LifecycleStateUpsert {
  initial: boolean;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
  manual: boolean;
  staleAfterMs: number | null;
  staleActionKey: string | null;
  sortOrder: number;
  description: string | null;
  metadata: Record<string, unknown>;
}

export interface LifecycleTransitionUpsert {
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

export interface LifecycleTransitionSelector {
  targetInitial?: boolean;
  targetTerminal?: boolean;
  targetRetryable?: boolean;
  targetAdministrative?: boolean;
  targetDispatchable?: boolean;
  targetManual?: boolean;
  targetHasAutomaticNonterminalExit?: boolean;
  transitionManualAllowed?: boolean;
  transitionExternalAllowed?: boolean;
  transitionAutomatic?: boolean;
  transitionMarkStarted?: boolean;
  transitionMarkCompleted?: boolean;
  transitionClearCompleted?: boolean;
  transitionClearFailure?: boolean;
  transitionResetRetry?: boolean;
}

export interface LifecycleExecutionStatusContract {
  initial: string;
  active: string;
  succeeded: string;
  failed: string;
  cancelled: string;
}

export type LifecycleStateSelector = Partial<
  Pick<
    LifecycleStateDefinition,
    "initial" | "terminal" | "retryable" | "administrative" | "dispatchable" | "manual"
  >
>;

export function serializeLifecycleTransitionSelector(
  selector: LifecycleTransitionSelector,
): string {
  return JSON.stringify(selector);
}

export function lifecycleTransitionSelectorPredicate(
  transitionAlias: string,
  targetAlias: string,
  parameter: string,
): string {
  const checks: Array<[keyof LifecycleTransitionSelector, string]> = [
    ["targetInitial", `${targetAlias}.initial`],
    ["targetTerminal", `${targetAlias}.terminal`],
    ["targetRetryable", `${targetAlias}.retryable`],
    ["targetAdministrative", `${targetAlias}.administrative`],
    ["targetDispatchable", `${targetAlias}.dispatchable`],
    ["targetManual", `${targetAlias}.manual`],
    ["transitionManualAllowed", `${transitionAlias}.manual_allowed`],
    ["transitionExternalAllowed", `${transitionAlias}.external_allowed`],
    ["transitionAutomatic", `${transitionAlias}.automatic`],
    ["transitionMarkStarted", `${transitionAlias}.mark_started`],
    ["transitionMarkCompleted", `${transitionAlias}.mark_completed`],
    ["transitionClearCompleted", `${transitionAlias}.clear_completed`],
    ["transitionClearFailure", `${transitionAlias}.clear_failure`],
    ["transitionResetRetry", `${transitionAlias}.reset_retry`],
  ];
  const predicates = checks
    .map(([key, column]) =>
      `(NOT (${parameter}::jsonb ? '${key}') OR ${column} = (${parameter}::jsonb->>'${key}')::boolean)`,
    );
  predicates.push(
    `(NOT (${parameter}::jsonb ? 'targetHasAutomaticNonterminalExit') OR EXISTS (
      SELECT 1
        FROM lifecycle_transitions outgoing
        JOIN lifecycle_state_definitions outgoing_target
          ON outgoing_target.lifecycle_key = outgoing.lifecycle_key
         AND outgoing_target.status = outgoing.to_status
       WHERE outgoing.lifecycle_key = ${targetAlias}.lifecycle_key
         AND outgoing.from_status = ${targetAlias}.status
         AND outgoing.automatic
         AND NOT outgoing_target.terminal
    ) = (${parameter}::jsonb->>'targetHasAutomaticNonterminalExit')::boolean)`,
  );
  return predicates.join("\n          AND ");
}

export async function getResourceLifecycleKey(
  resourceTable: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<string | null> {
  const result = await db.query(
    `SELECT lifecycle_key
       FROM lifecycle_resource_bindings
      WHERE resource_table = to_regclass($1)
        AND state_column = $2::name`,
    [resourceTable, stateColumn],
  );
  const value = result.rows[0]?.lifecycle_key;
  return typeof value === "string" ? value : null;
}

export async function getResourceLifecyclePolicy(
  resourceTable: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT policy
       FROM lifecycle_resource_policies
      WHERE resource_table = to_regclass($1)
        AND state_column = $2::name`,
    [resourceTable, stateColumn],
  );
  const policy = result.rows[0]?.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("resource lifecycle operational policy is not configured");
  }
  return policy as Record<string, unknown>;
}

export async function listResourceLifecycleStates(
  resourceTable: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition[]> {
  const result = await db.query(
    `SELECT state.lifecycle_key, state.status, state.initial, state.terminal,
            state.retryable, state.administrative, state.dispatchable, state.manual,
            state.stale_after_ms, state.stale_action_key, state.description, state.metadata
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key = binding.lifecycle_key
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $2::name
      ORDER BY state.sort_order, state.status`,
    [resourceTable, stateColumn],
  );
  return result.rows.map(rowToState);
}

export async function getResourceLifecycleState(
  resourceTable: string,
  status: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition | null> {
  const result = await db.query(
    `SELECT state.lifecycle_key, state.status, state.initial, state.terminal,
            state.retryable, state.administrative, state.dispatchable, state.manual,
            state.stale_after_ms, state.stale_action_key, state.description, state.metadata
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_state_definitions state
         ON state.lifecycle_key = binding.lifecycle_key
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $3::name
        AND state.status = $2`,
    [resourceTable, status, stateColumn],
  );
  return result.rows[0] ? rowToState(result.rows[0]) : null;
}

export async function resourceLifecycleStateMatches(
  resourceTable: string,
  status: string,
  selector: LifecycleStateSelector,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<boolean> {
  const state = await getResourceLifecycleState(resourceTable, status, stateColumn, db);
  if (!state) return false;
  return Object.entries(selector).every(
    ([property, expected]) =>
      state[property as keyof LifecycleStateSelector] === expected,
  );
}

export async function selectResourceLifecycleTransition(
  resourceTable: string,
  fromStatus: string,
  selector: LifecycleTransitionSelector,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleTransition | null> {
  const predicate = lifecycleTransitionSelectorPredicate("transition", "target", "$3");
  const result = await db.query(
    `SELECT transition.lifecycle_key, transition.action_key, transition.from_status,
            transition.to_status, transition.manual_allowed, transition.external_allowed,
            transition.automatic, transition.mark_started, transition.mark_completed,
            transition.clear_completed, transition.clear_failure, transition.reset_retry,
            transition.metadata
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_transitions transition
         ON transition.lifecycle_key = binding.lifecycle_key
        AND transition.from_status = $2
       JOIN lifecycle_state_definitions target
         ON target.lifecycle_key = transition.lifecycle_key
        AND target.status = transition.to_status
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $4::name
        AND ${predicate}
      ORDER BY target.sort_order, transition.action_key`,
    [
      resourceTable,
      fromStatus,
      serializeLifecycleTransitionSelector(selector),
      stateColumn,
    ],
  );
  if (result.rows.length > 1) {
    throw new Error("lifecycle transition selector is ambiguous for configured resource");
  }
  return result.rows[0] ? rowToTransition(result.rows[0]) : null;
}

export async function getResourceLifecycleExecutionStatusContract(
  resourceTable: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleExecutionStatusContract> {
  const result = await db.query(
    `WITH binding AS (
       SELECT lifecycle_key
         FROM lifecycle_resource_bindings
        WHERE resource_table = to_regclass($1)
          AND state_column = $2::name
     ),
     ranked AS (
       SELECT state.status,
              CASE
                WHEN state.initial THEN 'initial'
                WHEN state.terminal AND state.administrative THEN 'cancelled'
                WHEN state.terminal AND state.retryable THEN 'failed'
                WHEN state.terminal AND NOT state.retryable AND NOT state.administrative THEN 'succeeded'
                WHEN EXISTS (
                  SELECT 1
                    FROM lifecycle_transitions transition
                   WHERE transition.lifecycle_key = state.lifecycle_key
                     AND transition.to_status = state.status
                     AND transition.mark_started
                ) THEN 'active'
                ELSE NULL
              END AS role,
              state.sort_order
         FROM lifecycle_state_definitions state
         JOIN binding ON binding.lifecycle_key = state.lifecycle_key
     )
     SELECT role, status
       FROM ranked
      WHERE role IS NOT NULL
      ORDER BY role, sort_order, status`,
    [resourceTable, stateColumn],
  );
  const grouped = new Map<string, string[]>();
  for (const row of result.rows) {
    const role = String(row.role);
    grouped.set(role, [...(grouped.get(role) ?? []), String(row.status)]);
  }
  const required = ["initial", "active", "succeeded", "failed", "cancelled"] as const;
  const contract = {} as LifecycleExecutionStatusContract;
  for (const role of required) {
    const matches = grouped.get(role) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `resource lifecycle execution role ${role} must resolve to exactly one configured state`,
      );
    }
    contract[role] = matches[0];
  }
  return contract;
}

export async function getResourceLifecycleTransitionToState(
  resourceTable: string,
  fromStatus: string,
  toStatus: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleTransition | null> {
  const result = await db.query(
    `SELECT transition.lifecycle_key, transition.action_key, transition.from_status,
            transition.to_status, transition.manual_allowed, transition.external_allowed,
            transition.automatic, transition.mark_started, transition.mark_completed,
            transition.clear_completed, transition.clear_failure, transition.reset_retry,
            transition.metadata
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_transitions transition
         ON transition.lifecycle_key = binding.lifecycle_key
        AND transition.from_status = $2
        AND transition.to_status = $3
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $4::name`,
    [resourceTable, fromStatus, toStatus, stateColumn],
  );
  if (result.rows.length > 1) {
    throw new Error("configured resource has duplicate transitions between states");
  }
  return result.rows[0] ? rowToTransition(result.rows[0]) : null;
}

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

export async function updateLifecycleStalePolicy(
  lifecycleKey: string,
  status: string,
  policy: LifecycleStalePolicyUpdate,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition | null> {
  const staleAfterMs = policy.staleAfterMs;
  const staleActionKey = policy.staleActionKey?.trim() || null;

  if (
    (staleAfterMs === null) !== (staleActionKey === null)
    || (staleAfterMs !== null && (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0))
  ) {
    throw new Error(
      "staleAfterMs and staleActionKey must both be null, or a positive integer and non-empty action key",
    );
  }

  const result = await db.query(
    `UPDATE lifecycle_state_definitions state
        SET stale_after_ms = $3,
            stale_action_key = $4,
            updated_at = NOW()
      WHERE state.lifecycle_key = $1
        AND state.status = $2
        AND (
          ($3::bigint IS NULL AND $4::text IS NULL)
          OR EXISTS (
            SELECT 1
              FROM lifecycle_transitions transition
             WHERE transition.lifecycle_key = state.lifecycle_key
               AND transition.from_status = state.status
               AND transition.action_key = $4
               AND transition.automatic
          )
        )
      RETURNING lifecycle_key, status, initial, terminal, retryable, administrative,
                dispatchable, manual, stale_after_ms, stale_action_key, description, metadata`,
    [lifecycleKey, status, staleAfterMs, staleActionKey],
  );

  return result.rows[0] ? rowToState(result.rows[0]) : null;
}

export async function configureResourceLifecycleBinding(
  resourceTable: string,
  lifecycleKey: string,
  stateColumn = "status",
  db: LifecycleQueryable = getDb(),
): Promise<void> {
  await db.query(
    "SELECT configure_lifecycle_resource_binding(to_regclass($1), $2, $3::name)",
    [resourceTable, lifecycleKey, stateColumn],
  );
}

export async function upsertLifecycleState(
  lifecycleKey: string,
  status: string,
  input: LifecycleStateUpsert,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleStateDefinition> {
  const result = await db.query(
    `INSERT INTO lifecycle_state_definitions
       (lifecycle_key, status, initial, terminal, retryable, administrative,
        dispatchable, manual, stale_after_ms, stale_action_key, sort_order,
        description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (lifecycle_key, status) DO UPDATE
       SET initial = EXCLUDED.initial,
           terminal = EXCLUDED.terminal,
           retryable = EXCLUDED.retryable,
           administrative = EXCLUDED.administrative,
           dispatchable = EXCLUDED.dispatchable,
           manual = EXCLUDED.manual,
           stale_after_ms = EXCLUDED.stale_after_ms,
           stale_action_key = EXCLUDED.stale_action_key,
           sort_order = EXCLUDED.sort_order,
           description = EXCLUDED.description,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
     RETURNING lifecycle_key, status, initial, terminal, retryable, administrative,
               dispatchable, manual, stale_after_ms, stale_action_key,
               description, metadata`,
    [
      lifecycleKey,
      status,
      input.initial,
      input.terminal,
      input.retryable,
      input.administrative,
      input.dispatchable,
      input.manual,
      input.staleAfterMs,
      input.staleActionKey,
      input.sortOrder,
      input.description,
      JSON.stringify(input.metadata),
    ],
  );
  return rowToState(result.rows[0]);
}

export async function upsertLifecycleTransition(
  lifecycleKey: string,
  actionKey: string,
  fromStatus: string,
  input: LifecycleTransitionUpsert,
  db: LifecycleQueryable = getDb(),
): Promise<LifecycleTransition> {
  const result = await db.query(
    `INSERT INTO lifecycle_transitions
       (lifecycle_key, action_key, from_status, to_status, manual_allowed,
        external_allowed, automatic, mark_started, mark_completed,
        clear_completed, clear_failure, reset_retry, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (lifecycle_key, action_key, from_status) DO UPDATE
       SET to_status = EXCLUDED.to_status,
           manual_allowed = EXCLUDED.manual_allowed,
           external_allowed = EXCLUDED.external_allowed,
           automatic = EXCLUDED.automatic,
           mark_started = EXCLUDED.mark_started,
           mark_completed = EXCLUDED.mark_completed,
           clear_completed = EXCLUDED.clear_completed,
           clear_failure = EXCLUDED.clear_failure,
           reset_retry = EXCLUDED.reset_retry,
           metadata = EXCLUDED.metadata
     RETURNING lifecycle_key, action_key, from_status, to_status, manual_allowed,
               external_allowed, automatic, mark_started, mark_completed,
               clear_completed, clear_failure, reset_retry, metadata`,
    [
      lifecycleKey,
      actionKey,
      fromStatus,
      input.toStatus,
      input.manualAllowed,
      input.externalAllowed,
      input.automatic,
      input.markStarted,
      input.markCompleted,
      input.clearCompleted,
      input.clearFailure,
      input.resetRetry,
      JSON.stringify(input.metadata),
    ],
  );
  return rowToTransition(result.rows[0]);
}
