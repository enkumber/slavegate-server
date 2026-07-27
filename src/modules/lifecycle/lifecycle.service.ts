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

export interface ResourceLifecyclePolicyRecord {
  resourceTable: string;
  stateColumn: string;
  policy: Record<string, unknown>;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface ResourceLifecyclePolicyUpsert {
  resourceTable: string;
  stateColumn: string;
  policy: Record<string, unknown>;
  updatedBy?: string | null;
}

export class ResourceLifecyclePolicyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLifecyclePolicyUnavailableError";
  }
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
    throw new ResourceLifecyclePolicyUnavailableError(
      "resource lifecycle operational policy is not configured",
    );
  }
  if ((policy as Record<string, unknown>).enabled === false || (policy as Record<string, unknown>).disabled === true) {
    throw new ResourceLifecyclePolicyUnavailableError(
      "resource lifecycle operational policy is disabled",
    );
  }
  return policy as Record<string, unknown>;
}

export async function listResourceLifecyclePolicies(filters: {
  resourceTable?: string;
  stateColumn?: string;
} = {}, db: LifecycleQueryable = getDb()): Promise<ResourceLifecyclePolicyRecord[]> {
  const resourceTable = filters.resourceTable === undefined
    ? null
    : normalizeResourceIdentity(filters.resourceTable, "resourceTable");
  const stateColumn = filters.stateColumn === undefined
    ? null
    : normalizeResourceIdentity(filters.stateColumn, "stateColumn");
  const result = await db.query(
    `SELECT policy.resource_table::text AS resource_table,
            policy.state_column::text AS state_column,
            policy.policy,
            policy.version,
            policy.updated_by,
            policy.updated_at
       FROM lifecycle_resource_policies policy
      WHERE ($1::text IS NULL OR policy.resource_table = to_regclass($1))
        AND ($2::text IS NULL OR policy.state_column = $2::name)
      ORDER BY policy.resource_table::text, policy.state_column::text`,
    [resourceTable, stateColumn],
  );
  return result.rows.map(rowToResourceLifecyclePolicy);
}

export async function getResourceLifecyclePolicyRecord(
  resourceTableValue: string,
  stateColumnValue: string,
  db: LifecycleQueryable = getDb(),
): Promise<ResourceLifecyclePolicyRecord | null> {
  const resourceTable = normalizeResourceIdentity(resourceTableValue, "resourceTable");
  const stateColumn = normalizeResourceIdentity(stateColumnValue, "stateColumn");
  const result = await db.query(
    `SELECT policy.resource_table::text AS resource_table,
            policy.state_column::text AS state_column,
            policy.policy,
            policy.version,
            policy.updated_by,
            policy.updated_at
       FROM lifecycle_resource_policies policy
      WHERE policy.resource_table = to_regclass($1)
        AND policy.state_column = $2::name`,
    [resourceTable, stateColumn],
  );
  return result.rows[0] ? rowToResourceLifecyclePolicy(result.rows[0]) : null;
}

export async function upsertResourceLifecyclePolicy(
  input: ResourceLifecyclePolicyUpsert,
  db: Pool = getDb(),
): Promise<ResourceLifecyclePolicyRecord> {
  const resourceTable = normalizeResourceIdentity(input.resourceTable, "resourceTable");
  const stateColumn = normalizeResourceIdentity(input.stateColumn, "stateColumn");
  const policy = normalizeResourceLifecyclePolicy(input.policy);
  const updatedBy = typeof input.updatedBy === "string" && input.updatedBy.trim()
    ? input.updatedBy.trim()
    : null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO lifecycle_resource_policies
         (resource_table, state_column, policy, updated_by)
       SELECT binding.resource_table, binding.state_column, $3::jsonb, $4
         FROM lifecycle_resource_bindings binding
        WHERE binding.resource_table = to_regclass($1)
          AND binding.state_column = $2::name
       ON CONFLICT (resource_table, state_column) DO UPDATE
         SET policy = EXCLUDED.policy,
             version = lifecycle_resource_policies.version + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING resource_table::text, state_column::text, policy, version, updated_by, updated_at`,
      [resourceTable, stateColumn, JSON.stringify(policy), updatedBy],
    );
    if (!result.rows[0]) {
      throw new Error("resource lifecycle binding does not exist in PostgreSQL");
    }
    const record = rowToResourceLifecyclePolicy(result.rows[0]);
    await client.query("COMMIT");
    return record;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function disableResourceLifecyclePolicy(
  resourceTableValue: string,
  stateColumnValue: string,
  updatedByValue?: string | null,
  db: Pool = getDb(),
): Promise<ResourceLifecyclePolicyRecord> {
  return upsertResourceLifecyclePolicy({
    resourceTable: resourceTableValue,
    stateColumn: stateColumnValue,
    policy: { enabled: false },
    updatedBy: updatedByValue,
  }, db);
}

export async function deleteResourceLifecyclePolicy(
  resourceTableValue: string,
  stateColumnValue: string,
  db: Pool = getDb(),
): Promise<boolean> {
  const resourceTable = normalizeResourceIdentity(resourceTableValue, "resourceTable");
  const stateColumn = normalizeResourceIdentity(stateColumnValue, "stateColumn");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `DELETE FROM lifecycle_resource_policies
        WHERE resource_table = to_regclass($1)
          AND state_column = $2::name
        RETURNING resource_table`,
      [resourceTable, stateColumn],
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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

export async function getResourceLifecycleTransition(
  resourceTable: string,
  fromStatus: string,
  actionKey: string,
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
        AND transition.action_key = $3
      WHERE binding.resource_table = to_regclass($1)
        AND binding.state_column = $4::name`,
    [resourceTable, fromStatus, actionKey, stateColumn],
  );
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

function rowToResourceLifecyclePolicy(row: Record<string, unknown>): ResourceLifecyclePolicyRecord {
  return {
    resourceTable: String(row.resource_table),
    stateColumn: String(row.state_column),
    policy: row.policy && typeof row.policy === "object" && !Array.isArray(row.policy)
      ? row.policy as Record<string, unknown>
      : {},
    version: Number(row.version),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

function normalizeResourceIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(normalized)) {
    throw new Error(`${field} must be a non-empty PostgreSQL identifier or schema-qualified identifier`);
  }
  return normalized;
}

function normalizeResourceLifecyclePolicy(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("policy must be an object");
  }
  assertJsonCompatiblePolicy(value, "policy");
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    throw new Error("policy.enabled must be a boolean when provided");
  }
  if ("disabled" in value && typeof value.disabled !== "boolean") {
    throw new Error("policy.disabled must be a boolean when provided");
  }
  return value;
}

function assertJsonCompatiblePolicy(value: unknown, path: string): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be JSON-compatible`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonCompatiblePolicy(item, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!key.trim()) throw new Error(`${path} contains an empty object key`);
      assertJsonCompatiblePolicy(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} must be JSON-compatible`);
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
