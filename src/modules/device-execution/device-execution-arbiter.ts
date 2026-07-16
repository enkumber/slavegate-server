import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { getDb } from "../../db/client";

export const DEVICE_EXECUTION_ACTIVE_STATES = ["claimed", "dispatching", "dispatched", "reconciling", "blocked"] as const;
export const DEVICE_EXECUTION_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;
export const DEVICE_EXECUTION_OPERATION_STATES = [
  "registered",
  "dispatching",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
  "reconciling",
  "blocked",
  "rejected",
] as const;

export type DeviceExecutionRootKind =
  | "job"
  | "batch"
  | "edge_workflow"
  | "server_workflow"
  | "control"
  | "unknown";

export type DeviceExecutionState =
  | "queued"
  | "claimed"
  | "dispatching"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciling"
  | "blocked";

export type DeviceExecutionOperationKind = "job" | "batch" | "workflow" | "control" | "admin";
export type DeviceExecutionOperationState = typeof DEVICE_EXECUTION_OPERATION_STATES[number];
export type DeviceExecutionEgressLane = "device_execution" | "control" | "admin";

export interface DeviceExecutionOperation {
  id: number;
  rootId: string;
  deviceId: string;
  rootKind: DeviceExecutionRootKind;
  operationKind: DeviceExecutionOperationKind;
  operationId: string;
  ownerGeneration: number;
  state: DeviceExecutionOperationState;
  egressLane: DeviceExecutionEgressLane;
  wireType: string | null;
  wireHandle: DeviceExecutionWireHandle;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceExecutionHandle {
  rootId: string;
  deviceId: string;
  rootKind: DeviceExecutionRootKind;
  ownerGeneration: number;
  operationKind: DeviceExecutionOperationKind;
  operationId: string;
}

export interface DeviceExecutionWireHandle {
  pnqRootId: string;
  pnqDeviceId: string;
  pnqRootKind: DeviceExecutionRootKind;
  pnqOwnerGeneration: number;
  pnqOperationKind: DeviceExecutionOperationKind;
  pnqOperationId: string;
}

export type DeviceExecutionBoundaryKind =
  | "standalone_job"
  | "edge_batch"
  | "edge_workflow"
  | "server_workflow_root"
  | "server_workflow_batch_child"
  | "generated_child"
  | "self_healing_child"
  | "prestep_child"
  | "recovery_child"
  | "control_egress";

export interface DeviceExecutionBoundaryPolicy {
  rootKind: DeviceExecutionRootKind;
  operationKind: DeviceExecutionOperationKind;
  retainsRootUntilTerminal: boolean;
  requiresExistingRootHandle: boolean;
  egressLane: DeviceExecutionEgressLane;
  mayBypassDeviceQueue: boolean;
}

export const DEVICE_EXECUTION_BOUNDARY_MATRIX: Record<DeviceExecutionBoundaryKind, DeviceExecutionBoundaryPolicy> = {
  standalone_job: {
    rootKind: "job",
    operationKind: "job",
    retainsRootUntilTerminal: true,
    requiresExistingRootHandle: false,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  edge_batch: {
    rootKind: "batch",
    operationKind: "batch",
    retainsRootUntilTerminal: true,
    requiresExistingRootHandle: false,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  edge_workflow: {
    rootKind: "edge_workflow",
    operationKind: "workflow",
    retainsRootUntilTerminal: true,
    requiresExistingRootHandle: false,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  server_workflow_root: {
    rootKind: "server_workflow",
    operationKind: "workflow",
    retainsRootUntilTerminal: true,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  server_workflow_batch_child: {
    rootKind: "server_workflow",
    operationKind: "batch",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  generated_child: {
    rootKind: "server_workflow",
    operationKind: "job",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  self_healing_child: {
    rootKind: "server_workflow",
    operationKind: "job",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  prestep_child: {
    rootKind: "server_workflow",
    operationKind: "job",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  recovery_child: {
    rootKind: "server_workflow",
    operationKind: "job",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: true,
    egressLane: "device_execution",
    mayBypassDeviceQueue: false,
  },
  control_egress: {
    rootKind: "control",
    operationKind: "control",
    retainsRootUntilTerminal: false,
    requiresExistingRootHandle: false,
    egressLane: "control",
    mayBypassDeviceQueue: true,
  },
};

export interface DeviceExecutionControlPolicy {
  lane: "control";
  audited: true;
  mayBypassDeviceQueue: true;
  mayCarryUiWork: false;
  allowedKinds: readonly ["kill_switch", "auth_revoke", "workflow_cancel", "model_config_update", "ota_update"];
}

export interface DeviceExecutionAdminResolutionPolicy {
  lane: "admin";
  audited: true;
  requiresAuthenticatedActor: true;
  requiresReason: true;
  terminalStates: readonly ["completed", "failed", "cancelled", "blocked"];
}

export interface DeviceExecutionMultiWorkerPolicy {
  authority: "postgres";
  ownershipToken: "root_id_device_id_owner_generation";
  terminalCas: "device_root_generation";
  websocketOwnership: "single_active_connection_observed";
}

export const DEVICE_EXECUTION_CONTROL_POLICY: DeviceExecutionControlPolicy = {
  lane: "control",
  audited: true,
  mayBypassDeviceQueue: true,
  mayCarryUiWork: false,
  allowedKinds: ["kill_switch", "auth_revoke", "workflow_cancel", "model_config_update", "ota_update"],
};

export const DEVICE_EXECUTION_ADMIN_RESOLUTION_POLICY: DeviceExecutionAdminResolutionPolicy = {
  lane: "admin",
  audited: true,
  requiresAuthenticatedActor: true,
  requiresReason: true,
  terminalStates: ["completed", "failed", "cancelled", "blocked"],
};

export const DEVICE_EXECUTION_MULTI_WORKER_POLICY: DeviceExecutionMultiWorkerPolicy = {
  authority: "postgres",
  ownershipToken: "root_id_device_id_owner_generation",
  terminalCas: "device_root_generation",
  websocketOwnership: "single_active_connection_observed",
};

export interface DeviceExecutionRoot {
  id: string;
  deviceId: string;
  rootKind: DeviceExecutionRootKind;
  externalId: string | null;
  requestKey: string | null;
  state: DeviceExecutionState;
  fifoSequence: number;
  ownerGeneration: number;
  observeMode: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceExecutionPermit {
  rootId: string;
  deviceId: string;
  ownerGeneration: number;
  state: Extract<DeviceExecutionState, "claimed" | "dispatching" | "dispatched">;
}

export interface DeviceExecutionJobDispatchPermit {
  kind: "device_execution_job_dispatch_permit";
  handle: DeviceExecutionHandle;
  wireHandle: DeviceExecutionWireHandle;
}

export type DeviceExecutionDecision =
  | "admitted"
  | "duplicate"
  | "claimed"
  | "dispatched"
  | "would_wait"
  | "offline"
  | "terminal"
  | "ambiguous"
  | "rejected"
  | "ignored"
  | "missing";

export interface DeviceExecutionTransitionResult {
  decision: DeviceExecutionDecision;
  root: DeviceExecutionRoot | null;
  handle?: DeviceExecutionHandle;
  operation?: DeviceExecutionOperation;
  activeRootId?: string;
  reason?: string;
}

export interface DeviceExecutionObservedEgressInput {
  deviceId: string;
  /** Required by child boundaries: canonical root id or external workflow id. */
  rootId?: string;
  rootExternalId?: string;
  rootKind?: DeviceExecutionRootKind;
  operationKind?: DeviceExecutionOperationKind;
  operationId: string;
  requestKey?: string;
  wireType: string;
  actor?: string;
  boundary?: DeviceExecutionBoundaryKind;
  metadata?: Record<string, unknown>;
  registerWaiter?: (handle: DeviceExecutionHandle) => Promise<void> | void;
  wireDispatch: (handle: DeviceExecutionHandle) => Promise<boolean> | boolean;
}

export interface DeviceExecutionObservedEgressResult extends DeviceExecutionTransitionResult {
  sent: boolean;
}

export interface DeviceExecutionStandaloneJobEgressInput {
  deviceId: string;
  jobId: string;
  /** Required by child boundaries: canonical root id or external workflow id. */
  rootId?: string;
  rootExternalId?: string;
  rootKind?: DeviceExecutionRootKind;
  operationKind?: DeviceExecutionOperationKind;
  boundary?: DeviceExecutionBoundaryKind;
  wireType?: string;
  requestKey?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
  registerWaiter?: (permit: DeviceExecutionJobDispatchPermit) => Promise<void> | void;
  wireDispatch: (permit: DeviceExecutionJobDispatchPermit) => Promise<boolean> | boolean;
}

export interface DeviceExecutionStandaloneJobEgressResult extends DeviceExecutionTransitionResult {
  sent: boolean;
  permit?: DeviceExecutionJobDispatchPermit;
}

export interface DeviceExecutionAcceptedJobResult {
  accepted: boolean;
  decision: DeviceExecutionDecision;
  root: DeviceExecutionRoot | null;
  operation?: DeviceExecutionOperation;
  handle?: DeviceExecutionHandle;
  reason?: string;
}

type DbPool = Pick<Pool, "connect" | "query">;
type DbClient = Pick<PoolClient, "query" | "release">;
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

interface DeviceExecutionRootRow extends QueryResultRow {
  id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  external_id: string | null;
  request_key: string | null;
  state: DeviceExecutionState;
  fifo_sequence: string | number;
  owner_generation: string | number;
  observe_mode: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface DeviceExecutionOperationRow extends QueryResultRow {
  id: string | number;
  root_id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  operation_kind: DeviceExecutionOperationKind;
  operation_id: string;
  owner_generation: string | number;
  state: DeviceExecutionOperationState;
  egress_lane: DeviceExecutionEgressLane;
  wire_type: string | null;
  wire_handle: DeviceExecutionWireHandle | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface SchemaValidationRow extends QueryResultRow {
  roots_table: boolean;
  events_table: boolean;
  operations_table: boolean;
  missing_columns: unknown;
  wrong_column_types: unknown;
  missing_constraints: unknown;
  missing_foreign_keys: unknown;
  missing_indexes: unknown;
  invalid_index_predicates: unknown;
}

const ACTIVE_STATE_SQL = "'claimed', 'dispatching', 'dispatched', 'reconciling', 'blocked'";
const TERMINAL_STATE_SQL = "'completed', 'failed', 'cancelled'";

export class DeviceExecutionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceExecutionSchemaError";
  }
}

export class DeviceExecutionArbiter {
  constructor(private readonly dbProvider: () => DbPool = getDb) {}

  async validateSchema(): Promise<void> {
    const result = await this.dbProvider().query<SchemaValidationRow>(
      `
      WITH required_columns(table_name, column_name, udt_name, is_nullable) AS (
        VALUES
          ('device_execution_roots', 'id', 'uuid', 'NO'),
          ('device_execution_roots', 'device_id', 'uuid', 'NO'),
          ('device_execution_roots', 'root_kind', 'text', 'NO'),
          ('device_execution_roots', 'external_id', 'text', 'YES'),
          ('device_execution_roots', 'request_key', 'text', 'YES'),
          ('device_execution_roots', 'state', 'text', 'NO'),
          ('device_execution_roots', 'fifo_sequence', 'int8', 'NO'),
          ('device_execution_roots', 'owner_generation', 'int8', 'NO'),
          ('device_execution_roots', 'observe_mode', 'bool', 'NO'),
          ('device_execution_roots', 'claimed_at', 'timestamptz', 'YES'),
          ('device_execution_roots', 'dispatching_at', 'timestamptz', 'YES'),
          ('device_execution_roots', 'dispatched_at', 'timestamptz', 'YES'),
          ('device_execution_roots', 'terminal_at', 'timestamptz', 'YES'),
          ('device_execution_roots', 'reconciliation_reason', 'text', 'YES'),
          ('device_execution_roots', 'terminal_reason', 'text', 'YES'),
          ('device_execution_roots', 'metadata', 'jsonb', 'NO'),
          ('device_execution_operations', 'id', 'int8', 'NO'),
          ('device_execution_operations', 'root_id', 'uuid', 'NO'),
          ('device_execution_operations', 'device_id', 'uuid', 'NO'),
          ('device_execution_operations', 'root_kind', 'text', 'NO'),
          ('device_execution_operations', 'operation_kind', 'text', 'NO'),
          ('device_execution_operations', 'operation_id', 'text', 'NO'),
          ('device_execution_operations', 'owner_generation', 'int8', 'NO'),
          ('device_execution_operations', 'state', 'text', 'NO'),
          ('device_execution_operations', 'egress_lane', 'text', 'NO'),
          ('device_execution_operations', 'wire_type', 'text', 'YES'),
          ('device_execution_operations', 'wire_handle', 'jsonb', 'NO'),
          ('device_execution_operations', 'metadata', 'jsonb', 'NO'),
          ('device_execution_operations', 'dispatching_at', 'timestamptz', 'YES'),
          ('device_execution_operations', 'dispatched_at', 'timestamptz', 'YES'),
          ('device_execution_operations', 'terminal_at', 'timestamptz', 'YES'),
          ('device_execution_events', 'id', 'int8', 'NO'),
          ('device_execution_events', 'root_id', 'uuid', 'YES'),
          ('device_execution_events', 'device_id', 'uuid', 'YES'),
          ('device_execution_events', 'event_type', 'text', 'NO'),
          ('device_execution_events', 'previous_state', 'text', 'YES'),
          ('device_execution_events', 'new_state', 'text', 'YES'),
          ('device_execution_events', 'actor', 'text', 'NO'),
          ('device_execution_events', 'reason', 'text', 'YES'),
          ('device_execution_events', 'metadata', 'jsonb', 'NO')
      ),
      required_constraints(table_name, constraint_name, constraint_type) AS (
        VALUES
          ('device_execution_roots', 'device_execution_roots_pkey', 'PRIMARY KEY'),
          ('device_execution_roots', 'device_execution_roots_root_kind_check', 'CHECK'),
          ('device_execution_roots', 'device_execution_roots_state_check', 'CHECK'),
          ('device_execution_roots', 'device_execution_roots_owner_generation_check', 'CHECK'),
          ('device_execution_operations', 'device_execution_operations_pkey', 'PRIMARY KEY'),
          ('device_execution_operations', 'device_execution_operations_root_kind_check', 'CHECK'),
          ('device_execution_operations', 'device_execution_operations_operation_kind_check', 'CHECK'),
          ('device_execution_operations', 'device_execution_operations_state_check', 'CHECK'),
          ('device_execution_operations', 'device_execution_operations_egress_lane_check', 'CHECK'),
          ('device_execution_operations', 'device_execution_operations_owner_generation_check', 'CHECK'),
          ('device_execution_events', 'device_execution_events_pkey', 'PRIMARY KEY')
      ),
      required_foreign_keys(table_name, column_name, foreign_table, foreign_column) AS (
        VALUES
          ('device_execution_roots', 'device_id', 'devices', 'id'),
          ('device_execution_operations', 'root_id', 'device_execution_roots', 'id'),
          ('device_execution_operations', 'device_id', 'devices', 'id'),
          ('device_execution_events', 'root_id', 'device_execution_roots', 'id'),
          ('device_execution_events', 'device_id', 'devices', 'id')
      ),
      required_indexes(index_name) AS (
        VALUES
          ('idx_device_execution_roots_external'),
          ('idx_device_execution_active_slot'),
          ('idx_device_execution_roots_fifo'),
          ('idx_device_execution_operations_identity'),
          ('idx_device_execution_operations_root'),
          ('idx_device_execution_operations_device'),
          ('idx_device_execution_events_root'),
          ('idx_device_execution_events_device')
      ),
      required_predicate_states(index_name, state_value) AS (
        VALUES
          ('idx_device_execution_active_slot', 'claimed'),
          ('idx_device_execution_active_slot', 'dispatching'),
          ('idx_device_execution_active_slot', 'dispatched'),
          ('idx_device_execution_active_slot', 'reconciling'),
          ('idx_device_execution_active_slot', 'blocked'),
          ('idx_device_execution_roots_fifo', 'queued')
      )
      SELECT
        to_regclass('public.device_execution_roots') IS NOT NULL AS roots_table,
        to_regclass('public.device_execution_events') IS NOT NULL AS events_table,
        to_regclass('public.device_execution_operations') IS NOT NULL AS operations_table,
        COALESCE(
          jsonb_agg(required_columns.table_name || '.' || required_columns.column_name)
            FILTER (WHERE columns.column_name IS NULL),
          '[]'::jsonb
        ) AS missing_columns,
        COALESCE(
          jsonb_agg(
            required_columns.table_name || '.' || required_columns.column_name ||
            ':expected=' || required_columns.udt_name || '/' || required_columns.is_nullable ||
            ':actual=' || COALESCE(columns.udt_name, 'missing') || '/' || COALESCE(columns.is_nullable, 'missing')
          ) FILTER (
            WHERE columns.column_name IS NOT NULL
              AND (columns.udt_name <> required_columns.udt_name OR columns.is_nullable <> required_columns.is_nullable)
          ),
          '[]'::jsonb
        ) AS wrong_column_types,
        COALESCE(
          (
            SELECT jsonb_agg(required_constraints.table_name || '.' || required_constraints.constraint_name)
            FROM required_constraints
            WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints constraints
              WHERE constraints.table_schema = 'public'
                AND constraints.table_name = required_constraints.table_name
                AND constraints.constraint_name = required_constraints.constraint_name
                AND constraints.constraint_type = required_constraints.constraint_type
            )
          ),
          '[]'::jsonb
        ) AS missing_constraints,
        COALESCE(
          (
            SELECT jsonb_agg(required_foreign_keys.table_name || '.' || required_foreign_keys.column_name || '->' || required_foreign_keys.foreign_table || '.' || required_foreign_keys.foreign_column)
            FROM required_foreign_keys
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_rows
              JOIN pg_class source_table ON source_table.oid = constraint_rows.conrelid
              JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
              JOIN pg_class target_table ON target_table.oid = constraint_rows.confrelid
              JOIN pg_attribute source_column ON source_column.attrelid = source_table.oid AND source_column.attnum = ANY(constraint_rows.conkey)
              JOIN pg_attribute target_column ON target_column.attrelid = target_table.oid AND target_column.attnum = ANY(constraint_rows.confkey)
              WHERE constraint_rows.contype = 'f'
                AND source_schema.nspname = 'public'
                AND source_table.relname = required_foreign_keys.table_name
                AND source_column.attname = required_foreign_keys.column_name
                AND target_table.relname = required_foreign_keys.foreign_table
                AND target_column.attname = required_foreign_keys.foreign_column
            )
          ),
          '[]'::jsonb
        ) AS missing_foreign_keys,
        COALESCE(
          (
            SELECT jsonb_agg(required_indexes.index_name)
            FROM required_indexes
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = required_indexes.index_name
            )
          ),
          '[]'::jsonb
        ) AS missing_indexes,
        COALESCE(
          (
            SELECT jsonb_agg(DISTINCT required_predicate_states.index_name)
            FROM required_predicate_states
            JOIN pg_class index_class ON index_class.relname = required_predicate_states.index_name
            JOIN pg_index index_rows ON index_rows.indexrelid = index_class.oid
            WHERE pg_get_expr(index_rows.indpred, index_rows.indrelid) IS NULL
               OR pg_get_expr(index_rows.indpred, index_rows.indrelid) NOT LIKE '%' || required_predicate_states.state_value || '%'
          ),
          '[]'::jsonb
        ) AS invalid_index_predicates
      FROM required_columns
      LEFT JOIN information_schema.columns columns
        ON columns.table_schema = 'public'
       AND columns.table_name = required_columns.table_name
       AND columns.column_name = required_columns.column_name
      `
    );
    const row = result.rows[0];
    const missingColumns = parseStringArray(row?.missing_columns);
    const wrongColumnTypes = parseStringArray(row?.wrong_column_types);
    const missingConstraints = parseStringArray(row?.missing_constraints);
    const missingForeignKeys = parseStringArray(row?.missing_foreign_keys);
    const missingIndexes = parseStringArray(row?.missing_indexes);
    const invalidIndexPredicates = parseStringArray(row?.invalid_index_predicates);
    if (
      !row?.roots_table ||
      !row.events_table ||
      !row.operations_table ||
      missingColumns.length > 0 ||
      wrongColumnTypes.length > 0 ||
      missingConstraints.length > 0 ||
      missingForeignKeys.length > 0 ||
      missingIndexes.length > 0 ||
      invalidIndexPredicates.length > 0
    ) {
      throw new DeviceExecutionSchemaError(
        [
          "PNQ-001 device execution queue schema unavailable",
          `roots_table=${Boolean(row?.roots_table)}`,
          `events_table=${Boolean(row?.events_table)}`,
          `operations_table=${Boolean(row?.operations_table)}`,
          `missing_columns=${missingColumns.join(",") || "none"}`,
          `wrong_column_types=${wrongColumnTypes.join(",") || "none"}`,
          `missing_constraints=${missingConstraints.join(",") || "none"}`,
          `missing_foreign_keys=${missingForeignKeys.join(",") || "none"}`,
          `missing_indexes=${missingIndexes.join(",") || "none"}`,
          `invalid_index_predicates=${invalidIndexPredicates.join(",") || "none"}`,
        ].join(" ")
      );
    }
  }

  async recordRejectedEgress(input: {
    deviceId: string;
    operationId: string;
    wireType: string;
    actor: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      await insertEvent(client, {
        deviceId: input.deviceId,
        eventType: "egress_rejected_before_wire",
        actor: input.actor,
        reason: input.reason,
        metadata: {
          operationId: input.operationId,
          wireType: input.wireType,
          ...(input.metadata ?? {}),
        },
      });
    });
  }

  async recordControlEgress(input: {
    deviceId: string;
    operationId: string;
    controlKind: DeviceExecutionControlPolicy["allowedKinds"][number];
    actor: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      await insertEvent(client, {
        deviceId: input.deviceId,
        eventType: "control_egress_authorized",
        actor: input.actor,
        reason: input.controlKind,
        metadata: {
          operationId: input.operationId,
          controlKind: input.controlKind,
          queueBypass: true,
          mayCarryUiWork: false,
          ...(input.metadata ?? {}),
        },
      });
    });
  }

  async markCorruptQueueHead(input: {
    deviceId: string;
    rootId: string;
    rootKind: DeviceExecutionRootKind;
    ownerGeneration: number;
    operationId: string;
    actor: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const root = await selectRoot(client, { rootId: input.rootId, rootKind: input.rootKind, forUpdate: true });
      if (!root || root.device_id !== input.deviceId || toNumber(root.owner_generation) !== input.ownerGeneration) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "queue_replay_corruption_mark_rejected",
          actor: input.actor,
          reason: "queue_head_identity_changed",
          metadata: { rootId: input.rootId, operationId: input.operationId, ...(input.metadata ?? {}) },
        });
        return;
      }
      const previousState = root.state;
      const blocked = await updateRootAmbiguous(client, {
        rootId: root.id,
        deviceId: input.deviceId,
        ownerGeneration: input.ownerGeneration,
        toState: "blocked",
        reason: input.reason,
        metadata: input.metadata,
      });
      await updateOperationState(client, {
        operationKind: "job",
        operationId: input.operationId,
        fromStates: ["registered", "dispatching", "dispatched", "rejected"],
        toState: "blocked",
        ownerGeneration: input.ownerGeneration,
        metadata: input.metadata,
      });
      await insertEvent(client, {
        rootId: root.id,
        deviceId: input.deviceId,
        eventType: "queue_replay_corrupt_head_blocked",
        previousState,
        newState: blocked?.state ?? root.state,
        actor: input.actor,
        reason: input.reason,
        metadata: { operationId: input.operationId, ...(input.metadata ?? {}) },
      });
    });
  }

  async runStandaloneJobEgress(
    input: DeviceExecutionStandaloneJobEgressInput,
  ): Promise<DeviceExecutionStandaloneJobEgressResult> {
    const boundary = input.boundary ? DEVICE_EXECUTION_BOUNDARY_MATRIX[input.boundary] : undefined;
    const rootKind: DeviceExecutionRootKind = input.rootKind ?? boundary?.rootKind ?? "job";
    const operationKind: DeviceExecutionOperationKind = input.operationKind ?? boundary?.operationKind ?? "job";
    const actor = input.actor ?? "transport.g2";
    const wireType = input.wireType ?? "JOB";
    const boundaryKind = input.boundary ?? "standalone_job";
    const requiresExistingRoot = boundary?.requiresExistingRootHandle === true;
    const metadata = {
      ...(input.metadata ?? {}),
      boundary: boundaryKind,
      enforcement: boundaryKind === "standalone_job" ? "g2" : "g3",
      wireType,
    };

    const prepared = await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);

      let root = input.rootId
        ? await selectRoot(client, { rootId: input.rootId, rootKind, forUpdate: true })
        : await selectRootByExternalId(
            client,
            rootKind,
            requiresExistingRoot ? (input.rootExternalId ?? "") : input.jobId,
            true,
          );
      if (!root) {
        if (requiresExistingRoot) {
          await insertEvent(client, {
            deviceId: input.deviceId,
            eventType: "child_egress_rejected_missing_root",
            actor,
            reason: input.rootId || input.rootExternalId ? "existing_root_not_found" : "existing_root_identity_required",
            metadata: {
              ...metadata,
              jobId: input.jobId,
              rootId: input.rootId ?? null,
              rootExternalId: input.rootExternalId ?? null,
            },
          });
          return {
            decision: "rejected" as const,
            root: null,
            sent: false,
            reason: input.rootId || input.rootExternalId ? "existing_root_not_found" : "existing_root_identity_required",
          };
        }
        root = await insertRoot(client, {
          deviceId: input.deviceId,
          rootKind,
          externalId: input.jobId,
          requestKey: input.requestKey ?? input.jobId,
          metadata: {
            ...metadata,
            implicitAdmission: true,
          },
        });
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "implicit_admission",
          newState: root.state,
          actor,
          reason: "standalone_job_egress_without_root",
          metadata,
        });
      }

      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "egress_rejected_wrong_device",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "root_owned_by_different_device",
          metadata: { ...metadata, rootDeviceId: root.device_id },
        });
        return {
          decision: "rejected" as const,
          root: rowToRoot(root),
          sent: false,
          reason: "root_owned_by_different_device",
        };
      }

      const operation = await upsertOperation(client, {
        root,
        operationKind,
        operationId: input.jobId,
        state: "registered",
        egressLane: boundary?.egressLane ?? "device_execution",
        wireType,
        metadata,
      });

      const active = await selectActiveRoot(client, input.deviceId);
      if (active && active.id !== root.id) {
        const handle = operationRowToHandle(operation);
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "egress_waiting_active_root",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "device_slot_already_active",
          metadata: {
            ...metadata,
            activeRootId: active.id,
            activeState: active.state,
            handle: encodeDeviceExecutionHandle(handle),
          },
        });
        return {
          decision: "would_wait" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          activeRootId: active.id,
          sent: false,
          reason: "device_slot_already_active",
        };
      }

      if (isTerminalState(root.state)) {
        const handle = operationRowToHandle(operation);
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "egress_after_terminal",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "root_already_terminal",
          metadata: { ...metadata, handle: encodeDeviceExecutionHandle(handle) },
        });
        return {
          decision: "terminal" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          sent: false,
          reason: "root_already_terminal",
        };
      }

      if (root.state === "reconciling" || root.state === "blocked") {
        const handle = operationRowToHandle(operation);
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "egress_blocked_by_ambiguous_root",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: root.state,
          metadata: { ...metadata, handle: encodeDeviceExecutionHandle(handle) },
        });
        return {
          decision: "ambiguous" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          sent: false,
          reason: root.state,
        };
      }

      if (root.state === "dispatched" && !requiresExistingRoot) {
        const handle = operationRowToHandle(operation);
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "duplicate_dispatch",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "root_already_dispatched",
          metadata: { ...metadata, handle: encodeDeviceExecutionHandle(handle) },
        });
        return {
          decision: "dispatched" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          sent: false,
          reason: "root_already_dispatched",
        };
      }

      let current = root;
      if (root.state === "queued") {
        const oldest = await selectOldestQueuedRoot(client, input.deviceId);
        if (!oldest || oldest.id !== root.id) {
          const handle = operationRowToHandle(operation);
          await insertEvent(client, {
            rootId: root.id,
            deviceId: root.device_id,
            eventType: "egress_waiting_fifo_predecessor",
            previousState: root.state,
            newState: root.state,
            actor,
            reason: "older_queued_root_exists",
            metadata: {
              ...metadata,
              predecessorRootId: oldest?.id ?? null,
              handle: encodeDeviceExecutionHandle(handle),
            },
          });
          return {
            decision: "would_wait" as const,
            root: rowToRoot(root),
            operation: rowToOperation(operation),
            handle,
            activeRootId: oldest?.id,
            sent: false,
            reason: "older_queued_root_exists",
          };
        }

        const dispatching = await updateRootState(client, {
          rootId: root.id,
          fromStates: ["queued"],
          toState: "dispatching",
          ownerGenerationIncrement: true,
          metadata,
        });
        if (!dispatching) {
          await insertEvent(client, {
            rootId: root.id,
            deviceId: root.device_id,
            eventType: "dispatching_cas_missed",
            previousState: root.state,
            newState: root.state,
            actor,
            reason: "state_changed_before_dispatching",
            metadata,
          });
          return {
            decision: "ignored" as const,
            root: rowToRoot(root),
            operation: rowToOperation(operation),
            handle: operationRowToHandle(operation),
            sent: false,
            reason: "state_changed_before_dispatching",
          };
        }
        current = dispatching;
      } else if (root.state === "claimed") {
        const dispatching = await updateRootState(client, {
          rootId: root.id,
          fromStates: ["claimed"],
          toState: "dispatching",
          ownerGenerationIncrement: false,
          metadata,
        });
        if (dispatching) current = dispatching;
      } else if (root.state !== "dispatching" && !(requiresExistingRoot && root.state === "dispatched")) {
        return {
          decision: "ignored" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle: operationRowToHandle(operation),
          sent: false,
          reason: "state_not_dispatchable",
        };
      }

      const dispatchingOperation = await updateOperationState(client, {
        operationKind,
        operationId: input.jobId,
        fromStates: ["registered"],
        toState: "dispatching",
        ownerGeneration: toNumber(current.owner_generation),
        wireHandle: encodeDeviceExecutionHandle(rootToHandle(current, operationKind, input.jobId)),
        metadata: {
          ...metadata,
          handle: encodeDeviceExecutionHandle(rootToHandle(current, operationKind, input.jobId)),
        },
      });
      if (!dispatchingOperation) {
        await insertEvent(client, {
          rootId: current.id,
          deviceId: current.device_id,
          eventType: "operation_dispatching_cas_missed",
          previousState: current.state,
          newState: current.state,
          actor,
          reason: "operation_not_registered",
          metadata,
        });
        return {
          decision: "rejected" as const,
          root: rowToRoot(current),
          operation: rowToOperation(operation),
          handle: operationRowToHandle(operation),
          sent: false,
          reason: "operation_not_registered",
        };
      }
      const handle = operationRowToHandle(dispatchingOperation);
      const permit: DeviceExecutionJobDispatchPermit = {
        kind: "device_execution_job_dispatch_permit",
        handle,
        wireHandle: encodeDeviceExecutionHandle(handle),
      };

      await insertEvent(client, {
        rootId: current.id,
        deviceId: current.device_id,
        eventType: "root_dispatching",
        previousState: root.state,
        newState: current.state,
        actor,
        metadata: { ...metadata, handle: permit.wireHandle },
      });

      return {
        decision: "claimed" as const,
        root: rowToRoot(current),
        operation: rowToOperation(dispatchingOperation),
        handle,
        permit,
        sent: false,
      };
    });

    if (!prepared.permit) return prepared;

    let sent = false;
    let wireError: string | undefined;
    try {
      await input.registerWaiter?.(prepared.permit);
    } catch (err) {
      wireError = `waiter_registration_failed: ${(err as Error).message}`;
    }
    try {
      if (!wireError) sent = await input.wireDispatch(prepared.permit);
    } catch (err) {
      wireError = (err as Error).message;
      sent = false;
    }

    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const root = await selectRoot(client, {
        rootId: prepared.permit?.handle.rootId,
        rootKind,
        forUpdate: true,
      });
      const operation = await selectOperationByIdentity(client, operationKind, input.jobId, true);
      if (!root || !operation) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "egress_completion_missing_handle",
          actor,
          reason: "missing_root_or_operation",
          metadata: { ...metadata, sent, wireError: wireError ?? null },
        });
        return { ...prepared, sent, reason: "missing_root_or_operation" };
      }

      const expectedGeneration = prepared.permit.handle.ownerGeneration;
      const sameOwner =
        root.device_id === input.deviceId &&
        operation.root_id === root.id &&
        operation.device_id === input.deviceId &&
        operation.operation_kind === prepared.permit.handle.operationKind &&
        operation.operation_id === prepared.permit.handle.operationId &&
        toNumber(root.owner_generation) === expectedGeneration &&
        toNumber(operation.owner_generation) === expectedGeneration;

      const childAlreadyTerminal = requiresExistingRoot &&
        root.state === "dispatched" &&
        isTerminalOperationState(operation.state);
      if (sameOwner && ((isTerminalState(root.state) && isTerminalOperationState(operation.state)) || childAlreadyTerminal)) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_completion_after_terminal",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: sent ? "result_arrived_before_wire_dispatch_returned" : "terminal_result_precedes_transport_failure",
          metadata: {
            ...metadata,
            handle: prepared.permit.wireHandle,
            sent,
            wireError: wireError ?? null,
          },
        });
        return {
          decision: "terminal" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle: prepared.permit.handle,
          permit: prepared.permit,
          sent,
          reason: "result_already_terminal",
        };
      }

      if (
        !sameOwner ||
        (root.state !== "dispatching" && !(requiresExistingRoot && root.state === "dispatched"))
      ) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "dispatch_completion_cas_missed",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "root_device_generation_or_state_mismatch",
          metadata: {
            ...metadata,
            expectedGeneration,
            actualGeneration: toNumber(root.owner_generation),
            rootDeviceId: root.device_id,
            handle: prepared.permit.wireHandle,
            sent,
            wireError: wireError ?? null,
          },
        });
        return {
          decision: "rejected" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle: prepared.permit.handle,
          permit: prepared.permit,
          sent,
          reason: "root_device_generation_or_state_mismatch",
        };
      }

      if (!sent) {
        const blocked = await updateRootAmbiguous(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          ownerGeneration: expectedGeneration,
          toState: "blocked",
          reason: wireError ?? "device_offline_or_transport_rejected_after_dispatching",
          metadata: {
            ...metadata,
            handle: prepared.permit.wireHandle,
            wireError: wireError ?? null,
          },
        }) ?? root;
        const blockedOperation = await updateOperationState(client, {
          operationKind,
          operationId: input.jobId,
          fromStates: ["registered", "dispatching", "dispatched", "rejected"],
          toState: "blocked",
          ownerGeneration: expectedGeneration,
          wireHandle: prepared.permit.wireHandle,
          metadata: {
            ...metadata,
            handle: prepared.permit.wireHandle,
            wireError: wireError ?? null,
          },
        }) ?? operation;
        await insertEvent(client, {
          rootId: blocked.id,
          deviceId: blocked.device_id,
          eventType: "egress_not_sent_fail_closed",
          previousState: root.state,
          newState: blocked.state,
          actor,
          reason: wireError ?? "device_offline_or_transport_rejected_after_dispatching",
          metadata: { ...metadata, handle: prepared.permit.wireHandle },
        });
        return {
          decision: "offline" as const,
          root: rowToRoot(blocked),
          operation: rowToOperation(blockedOperation),
          handle: prepared.permit.handle,
          permit: prepared.permit,
          sent,
          reason: wireError ?? "device_offline_or_transport_rejected_after_dispatching",
        };
      }

      const dispatched = root.state === "dispatched"
        ? root
        : await updateRootState(client, {
            rootId: root.id,
            fromStates: ["dispatching"],
            toState: "dispatched",
            ownerGenerationIncrement: false,
            metadata: {
              ...metadata,
              handle: prepared.permit.wireHandle,
            },
          });
      if (!dispatched) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_cas_missed",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "state_changed_before_dispatched",
          metadata: { ...metadata, handle: prepared.permit.wireHandle },
        });
        return {
          decision: "rejected" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle: prepared.permit.handle,
          permit: prepared.permit,
          sent,
          reason: "state_changed_before_dispatched",
        };
      }

      const dispatchedOperation = await updateOperationState(client, {
        operationKind,
        operationId: input.jobId,
        fromStates: ["dispatching"],
        toState: "dispatched",
        ownerGeneration: expectedGeneration,
        wireHandle: prepared.permit.wireHandle,
        metadata: {
          ...metadata,
          handle: prepared.permit.wireHandle,
        },
      }) ?? operation;

      await insertEvent(client, {
        rootId: dispatched.id,
        deviceId: dispatched.device_id,
        eventType: requiresExistingRoot ? "child_dispatched_under_root" : "root_dispatched",
        previousState: root.state,
        newState: dispatched.state,
        actor,
        metadata: { ...metadata, handle: prepared.permit.wireHandle },
      });

      return {
        decision: "dispatched" as const,
        root: rowToRoot(dispatched),
        operation: rowToOperation(dispatchedOperation),
        handle: prepared.permit.handle,
        permit: prepared.permit,
        sent,
      };
    });
  }

  async runObservedEgress(input: DeviceExecutionObservedEgressInput): Promise<DeviceExecutionObservedEgressResult> {
    const boundary = input.boundary ? DEVICE_EXECUTION_BOUNDARY_MATRIX[input.boundary] : undefined;
    const rootKind = input.rootKind ?? boundary?.rootKind ?? "job";
    const operationKind = input.operationKind ?? boundary?.operationKind ?? rootKindToOperationKind(rootKind);
    const requiresExistingRoot = boundary?.requiresExistingRootHandle === true;
    const actor = input.actor ?? "transport";
    const metadata = {
      ...(input.metadata ?? {}),
      boundary: input.boundary ?? null,
      observeMode: true,
      wireType: input.wireType,
    };

    const prepared = await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      let root = input.rootId
        ? await selectRoot(client, { rootId: input.rootId, rootKind, forUpdate: true })
        : await selectRootByExternalId(
            client,
            rootKind,
            requiresExistingRoot ? (input.rootExternalId ?? "") : input.operationId,
            true,
          );
      if (!root) {
        if (requiresExistingRoot) {
          await insertEvent(client, {
            deviceId: input.deviceId,
            eventType: "child_egress_rejected_missing_root",
            actor,
            reason: input.rootId || input.rootExternalId ? "existing_root_not_found" : "existing_root_identity_required",
            metadata: {
              ...metadata,
              operationId: input.operationId,
              rootId: input.rootId ?? null,
              rootExternalId: input.rootExternalId ?? null,
            },
          });
          return {
            decision: "rejected" as const,
            root: null,
            sent: false,
            reason: input.rootId || input.rootExternalId ? "existing_root_not_found" : "existing_root_identity_required",
          };
        }
        root = await insertRoot(client, {
          deviceId: input.deviceId,
          rootKind,
          externalId: input.operationId,
          requestKey: input.requestKey ?? input.operationId,
          metadata: {
            ...metadata,
            implicitAdmission: true,
          },
        });
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "implicit_admission",
          newState: root.state,
          actor,
          reason: "egress_observed_without_root",
          metadata,
        });
      }

      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "egress_rejected_wrong_device",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "root_owned_by_different_device",
          metadata: { ...metadata, rootDeviceId: root.device_id },
        });
        return {
          decision: "rejected" as const,
          root: rowToRoot(root),
          reason: "root_owned_by_different_device",
          sent: false,
        };
      }

      if (isTerminalState(root.state)) {
        return {
          decision: "terminal" as const,
          root: rowToRoot(root),
          sent: false,
          reason: "root_already_terminal",
        };
      }
      if (root.state === "reconciling" || root.state === "blocked") {
        return {
          decision: "ambiguous" as const,
          root: rowToRoot(root),
          sent: false,
          reason: root.state,
        };
      }

      const operation = await upsertOperation(client, {
        root,
        operationKind,
        operationId: input.operationId,
        state: "registered",
        egressLane: boundary?.egressLane ?? "device_execution",
        wireType: input.wireType,
        metadata,
      });
      const handle = operationRowToHandle(operation);

      const active = await selectActiveRoot(client, input.deviceId);
      if (active && active.id !== root.id && root.state === "queued") {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "observe_would_block_egress",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "device_slot_already_active",
          metadata: { ...metadata, activeRootId: active.id, activeState: active.state, handle: encodeDeviceExecutionHandle(handle) },
        });
        return {
          decision: "would_wait" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          activeRootId: active.id,
          sent: false,
        };
      }

      if (root.state === "queued") {
        const oldest = await selectOldestQueuedRoot(client, input.deviceId);
        if (!oldest || oldest.id !== root.id) {
          await insertEvent(client, {
            rootId: root.id,
            deviceId: root.device_id,
            eventType: "egress_waiting_fifo_predecessor",
            previousState: root.state,
            newState: root.state,
            actor,
            reason: "older_queued_root_exists",
            metadata: { ...metadata, predecessorRootId: oldest?.id ?? null },
          });
          return {
            decision: "would_wait" as const,
            root: rowToRoot(root),
            operation: rowToOperation(operation),
            handle,
            activeRootId: oldest?.id,
            sent: false,
            reason: "older_queued_root_exists",
          };
        }
      }

      let current = root;
      if (root.state === "queued" || root.state === "claimed") {
        const dispatching = await updateRootState(client, {
          rootId: root.id,
          fromStates: ["queued", "claimed"],
          toState: "dispatching",
          ownerGenerationIncrement: root.state === "queued",
          metadata,
        });
        if (dispatching) current = dispatching;
      }

      const operationDispatching = await updateOperationState(client, {
        operationKind,
        operationId: input.operationId,
        fromStates: ["registered", "rejected"],
        toState: "dispatching",
        ownerGeneration: toNumber(current.owner_generation),
        wireHandle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: current.owner_generation })),
        metadata: { ...metadata, handle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: current.owner_generation })) },
      }) ?? operation;

      await insertEvent(client, {
        rootId: current.id,
        deviceId: current.device_id,
        eventType: "root_dispatching",
        previousState: root.state,
        newState: current.state,
        actor,
        metadata: { ...metadata, handle: encodeDeviceExecutionHandle(operationRowToHandle(operationDispatching)) },
      });

      return {
        decision: "claimed" as const,
        root: rowToRoot(current),
        operation: rowToOperation(operationDispatching),
        handle: operationRowToHandle(operationDispatching),
        sent: false,
      };
    });

    if (!prepared.handle || prepared.decision !== "claimed") return prepared;

    let sent = false;
    let wireError: string | undefined;
    try {
      await input.registerWaiter?.(prepared.handle);
    } catch (err) {
      wireError = `waiter_registration_failed: ${(err as Error).message}`;
    }
    try {
      if (!wireError) sent = await input.wireDispatch(prepared.handle);
    } catch (err) {
      wireError = (err as Error).message;
      sent = false;
    }

    const completed = await this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const root = await selectRoot(client, {
        rootId: prepared.handle?.rootId,
        rootKind,
        forUpdate: true,
      });
      const operation = await selectOperationByIdentity(client, operationKind, input.operationId, true);
      if (!root || !operation) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "egress_completion_missing_handle",
          actor,
          reason: "missing_root_or_operation",
          metadata: { ...metadata, operationKind, operationId: input.operationId, sent, wireError },
        });
        return { ...prepared, sent, reason: "missing_root_or_operation" };
      }


      const expectedGeneration = prepared.handle!.ownerGeneration;
      const sameOwner = root.device_id === input.deviceId &&
        operation.root_id === root.id &&
        operation.device_id === input.deviceId &&
        operation.operation_kind === prepared.handle!.operationKind &&
        operation.operation_id === prepared.handle!.operationId &&
        toNumber(root.owner_generation) === expectedGeneration &&
        toNumber(operation.owner_generation) === expectedGeneration;
      const childAlreadyTerminal = requiresExistingRoot &&
        root.state === "dispatched" &&
        isTerminalOperationState(operation.state);
      if (sameOwner && ((isTerminalState(root.state) && isTerminalOperationState(operation.state)) || childAlreadyTerminal)) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_completion_after_terminal",
          previousState: root.state,
          newState: root.state,
          actor,
          reason: "result_arrived_before_wire_dispatch_returned",
          metadata: { ...metadata, handle: encodeDeviceExecutionHandle(prepared.handle!), sent, wireError: wireError ?? null },
        });
        return {
          decision: "terminal" as const,
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle: prepared.handle!,
          sent,
          reason: "result_already_terminal",
        };
      }

      if (!sent) {
        const blocked = await updateRootAmbiguous(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          ownerGeneration: expectedGeneration,
          toState: "blocked",
          reason: wireError ?? "device_offline_or_transport_rejected_after_dispatching",
          metadata,
        }) ?? root;
        const rejected = await updateOperationState(client, {
          operationKind,
          operationId: input.operationId,
          fromStates: ["registered", "dispatching"],
          toState: "blocked",
          ownerGeneration: expectedGeneration,
          metadata: { ...metadata, wireError: wireError ?? null },
        });
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "egress_not_sent_fail_closed",
          previousState: root.state,
          newState: blocked.state,
          actor,
          reason: wireError ?? "device_offline_or_transport_rejected",
          metadata: { ...metadata, handle: encodeDeviceExecutionHandle(operationRowToHandle(operation)) },
        });
        return {
          decision: "offline" as const,
          root: rowToRoot(blocked),
          operation: rowToOperation(rejected ?? operation),
          handle: operationRowToHandle(rejected ?? operation),
          sent,
          reason: wireError ?? "device_offline_or_transport_rejected",
        };
      }

      const completionPreviousState = root.state;
      const dispatched = completionPreviousState === "dispatching"
        ? await updateRootState(client, {
            rootId: root.id,
            fromStates: ["dispatching"],
            toState: "dispatched",
            ownerGenerationIncrement: false,
            metadata,
          })
        : root;
      const dispatchedOperation = await updateOperationState(client, {
        operationKind,
        operationId: input.operationId,
        fromStates: ["registered", "dispatching", "rejected"],
        toState: "dispatched",
        ownerGeneration: toNumber((dispatched ?? root).owner_generation),
        wireHandle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: (dispatched ?? root).owner_generation })),
        metadata: {
          ...metadata,
          handle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: (dispatched ?? root).owner_generation })),
        },
      }) ?? operation;

      await insertEvent(client, {
        rootId: (dispatched ?? root).id,
        deviceId: (dispatched ?? root).device_id,
        eventType: completionPreviousState === "dispatching" ? "root_dispatched" : "observe_dispatched_without_root_transition",
        previousState: completionPreviousState,
        newState: (dispatched ?? root).state,
        actor,
        metadata: { ...metadata, handle: encodeDeviceExecutionHandle(operationRowToHandle(dispatchedOperation)) },
      });

      return {
        decision: "dispatched" as const,
        root: rowToRoot(dispatched ?? root),
        operation: rowToOperation(dispatchedOperation),
        handle: operationRowToHandle(dispatchedOperation),
        activeRootId: prepared.activeRootId,
        sent,
      };
    });

    return completed;
  }

  async observeAdmission(input: {
    deviceId: string;
    rootKind?: DeviceExecutionRootKind;
    externalId?: string;
    requestKey?: string;
    actor?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const rootKind = input.rootKind ?? "job";
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);

      const existing = input.externalId
        ? await selectRootByExternalId(client, rootKind, input.externalId, true)
        : null;
      if (existing) {
        const existingOperation = input.externalId
          ? await upsertOperation(client, {
              root: existing,
              operationKind: rootKindToOperationKind(rootKind),
              operationId: input.externalId,
              state: "registered",
              egressLane: "device_execution",
              wireType: null,
              metadata: { externalId: input.externalId, requestKey: input.requestKey, duplicate: true },
            })
          : null;
        await insertEvent(client, {
          rootId: existing.id,
          deviceId: existing.device_id,
          eventType: "duplicate_admission",
          previousState: existing.state,
          newState: existing.state,
          actor: input.actor ?? "server",
          reason: "external_id_already_recorded",
          metadata: { externalId: input.externalId, requestKey: input.requestKey },
        });
        return {
          decision: "duplicate",
          root: rowToRoot(existing),
          operation: existingOperation ? rowToOperation(existingOperation) : undefined,
          handle: existingOperation ? operationRowToHandle(existingOperation) : undefined,
          reason: "external_id_already_recorded",
        };
      }

      const active = await selectActiveRoot(client, input.deviceId);
      const root = await insertRoot(client, {
        deviceId: input.deviceId,
        rootKind,
        externalId: input.externalId ?? null,
        requestKey: input.requestKey ?? input.externalId ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          observeMode: true,
          wouldWaitForRootId: active?.id ?? null,
        },
      });

      await insertEvent(client, {
        rootId: root.id,
        deviceId: root.device_id,
        eventType: "root_admitted",
        newState: root.state,
        actor: input.actor ?? "server",
        metadata: { rootKind, externalId: input.externalId, requestKey: input.requestKey },
      });

      const operation = input.externalId
        ? await upsertOperation(client, {
            root,
            operationKind: rootKindToOperationKind(rootKind),
            operationId: input.externalId,
            state: "registered",
            egressLane: "device_execution",
            wireType: null,
            metadata: { rootKind, externalId: input.externalId, requestKey: input.requestKey },
          })
        : null;

      if (active) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "observe_would_wait",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "server",
          reason: "device_slot_already_active",
          metadata: { activeRootId: active.id, activeState: active.state },
        });
      }

      return {
        decision: active ? "would_wait" : "admitted",
        root: rowToRoot(root),
        operation: operation ? rowToOperation(operation) : undefined,
        handle: operation ? operationRowToHandle(operation) : undefined,
        activeRootId: active?.id,
      };
    });
  }

  async observeDispatch(input: {
    deviceId: string;
    rootKind?: DeviceExecutionRootKind;
    externalId: string;
    requestKey?: string;
    sent: boolean;
    actor?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const rootKind = input.rootKind ?? "job";
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      let root = await selectRootByExternalId(client, rootKind, input.externalId, true);
      if (!root) {
        root = await insertRoot(client, {
          deviceId: input.deviceId,
          rootKind,
          externalId: input.externalId,
          requestKey: input.requestKey ?? input.externalId,
          metadata: {
            ...(input.metadata ?? {}),
            observeMode: true,
            implicitAdmission: true,
          },
        });
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "implicit_admission",
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "dispatch_observed_without_root",
          metadata: { rootKind, externalId: input.externalId },
        });
      }

      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "dispatch_rejected_wrong_device",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "root_owned_by_different_device",
          metadata: { rootDeviceId: root.device_id, externalId: input.externalId },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_owned_by_different_device" };
      }

      const operation = await upsertOperation(client, {
        root,
        operationKind: rootKindToOperationKind(rootKind),
        operationId: input.externalId,
        state: "registered",
        egressLane: "device_execution",
        wireType: rootKindToWireType(rootKind),
        metadata: {
          ...(input.metadata ?? {}),
          rootKind,
          externalId: input.externalId,
          requestKey: input.requestKey,
        },
      });
      const handle = operationRowToHandle(operation);

      if (!input.sent) {
        const rejectedOperation = await updateOperationState(client, {
          operationKind: operation.operation_kind,
          operationId: operation.operation_id,
          fromStates: ["registered", "dispatching"],
          toState: "rejected",
          metadata: input.metadata,
        }) ?? operation;
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_not_sent",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "device_offline_or_transport_rejected",
          metadata: input.metadata ?? {},
        });
        return {
          decision: "offline",
          root: rowToRoot(root),
          operation: rowToOperation(rejectedOperation),
          handle: operationRowToHandle(rejectedOperation),
          reason: "device_offline_or_transport_rejected",
        };
      }

      if (isTerminalState(root.state)) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_after_terminal",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "root_already_terminal",
          metadata: input.metadata ?? {},
        });
        return {
          decision: "terminal",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          reason: "root_already_terminal",
        };
      }

      if (root.state === "dispatched") {
        const dispatchedOperation = await updateOperationState(client, {
          operationKind: operation.operation_kind,
          operationId: operation.operation_id,
          fromStates: ["registered", "dispatching", "rejected"],
          toState: "dispatched",
          ownerGeneration: toNumber(root.owner_generation),
          wireHandle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: root.owner_generation })),
          metadata: input.metadata,
        }) ?? operation;
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "duplicate_dispatch",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "root_already_dispatched",
          metadata: input.metadata ?? {},
        });
        return {
          decision: "dispatched",
          root: rowToRoot(root),
          operation: rowToOperation(dispatchedOperation),
          handle: operationRowToHandle(dispatchedOperation),
          reason: "root_already_dispatched",
        };
      }

      const active = await selectActiveRoot(client, input.deviceId);
      if (active && active.id !== root.id && root.state === "queued") {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "observe_would_block_dispatch",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "device_slot_already_active",
          metadata: { ...(input.metadata ?? {}), activeRootId: active.id, activeState: active.state, handle: encodeDeviceExecutionHandle(handle) },
        });
        return {
          decision: "would_wait",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          activeRootId: active.id,
        };
      }

      const dispatched = await updateRootState(client, {
        rootId: root.id,
        fromStates: ["queued", "claimed"],
        toState: "dispatched",
        ownerGenerationIncrement: root.state === "queued",
        metadata: input.metadata,
      });
      if (!dispatched) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "dispatch_cas_missed",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "state_changed_before_dispatch",
          metadata: input.metadata ?? {},
        });
        return {
          decision: "ignored",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          reason: "state_changed_before_dispatch",
        };
      }
      const dispatchedOperation = await updateOperationState(client, {
        operationKind: operation.operation_kind,
        operationId: operation.operation_id,
        fromStates: ["registered", "dispatching", "rejected"],
        toState: "dispatched",
        ownerGeneration: toNumber(dispatched.owner_generation),
        wireHandle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: dispatched.owner_generation })),
        metadata: {
          ...(input.metadata ?? {}),
          handle: encodeDeviceExecutionHandle(operationRowToHandle({ ...operation, owner_generation: dispatched.owner_generation })),
        },
      }) ?? operation;
      await insertEvent(client, {
        rootId: dispatched.id,
        deviceId: dispatched.device_id,
        eventType: "root_dispatched",
        previousState: root.state,
        newState: dispatched.state,
        actor: input.actor ?? "transport",
        metadata: { ...(input.metadata ?? {}), handle: encodeDeviceExecutionHandle(operationRowToHandle(dispatchedOperation)) },
      });
      return {
        decision: "dispatched",
        root: rowToRoot(dispatched),
        operation: rowToOperation(dispatchedOperation),
        handle: operationRowToHandle(dispatchedOperation),
      };
    });
  }

  async claimNextRoot(input: {
    deviceId: string;
    actor?: string;
  }): Promise<DeviceExecutionPermit | null> {
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const active = await selectActiveRoot(client, input.deviceId);
      if (active) return null;

      const next = await selectOldestQueuedRoot(client, input.deviceId);
      if (!next) return null;

      const claimed = await updateRootState(client, {
        rootId: next.id,
        fromStates: ["queued"],
        toState: "claimed",
        ownerGenerationIncrement: true,
      });
      if (!claimed) return null;
      await insertEvent(client, {
        rootId: claimed.id,
        deviceId: claimed.device_id,
        eventType: "root_claimed",
        previousState: next.state,
        newState: claimed.state,
        actor: input.actor ?? "server",
      });
      return {
        rootId: claimed.id,
        deviceId: claimed.device_id,
        ownerGeneration: toNumber(claimed.owner_generation),
        state: "claimed",
      };
    });
  }

  async observeTerminal(input: {
    deviceId: string;
    rootKind?: DeviceExecutionRootKind;
    externalId?: string;
    rootId?: string;
    handle?: DeviceExecutionHandle;
    ownerGeneration?: number;
    status: "completed" | "failed" | "cancelled" | string;
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const terminalState = normalizeTerminalState(input.status);
    const rootKind = input.rootKind ?? input.handle?.rootKind ?? "job";
    const operationKind = input.handle?.operationKind ?? rootKindToOperationKind(rootKind);
    const operationId = input.handle?.operationId ?? input.externalId;
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const operation = operationId
        ? await selectOperationByIdentity(client, operationKind, operationId, true)
        : null;
      const root = await selectRoot(client, {
        rootId: input.handle?.rootId ?? input.rootId ?? operation?.root_id,
        rootKind,
        externalId: input.externalId,
        forUpdate: true,
      });
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "result_without_root",
          actor: input.actor ?? "transport",
          reason: "no_matching_root",
          metadata: { externalId: input.externalId, operationKind, operationId, status: input.status, ...(input.metadata ?? {}) },
        });
        return { decision: "missing", root: null, reason: "no_matching_root" };
      }

      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "result_rejected_wrong_device",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "root_owned_by_different_device",
          metadata: { rootDeviceId: root.device_id, externalId: input.externalId, operationKind, operationId, ...(input.metadata ?? {}) },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_owned_by_different_device" };
      }

      const expectedGeneration = input.handle?.ownerGeneration
        ?? input.ownerGeneration
        ?? (operation ? toNumber(operation.owner_generation) : toNumber(root.owner_generation));
      const handle = operation
        ? operationRowToHandle(operation)
        : rootToHandle(root, operationKind, operationId ?? input.externalId ?? root.id, expectedGeneration);

      if (toNumber(root.owner_generation) !== expectedGeneration) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "result_rejected_stale_generation",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "owner_generation_mismatch",
          metadata: {
            externalId: input.externalId,
            operationKind,
            operationId,
            expectedGeneration,
            actualGeneration: toNumber(root.owner_generation),
            handle: encodeDeviceExecutionHandle(handle),
            ...(input.metadata ?? {}),
          },
        });
        return {
          decision: "rejected",
          root: rowToRoot(root),
          operation: operation ? rowToOperation(operation) : undefined,
          handle,
          reason: "owner_generation_mismatch",
        };
      }

      if (isTerminalState(root.state)) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "duplicate_or_late_result",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "root_already_terminal",
          metadata: { externalId: input.externalId, operationKind, operationId, status: input.status, handle: encodeDeviceExecutionHandle(handle), ...(input.metadata ?? {}) },
        });
        return {
          decision: "rejected",
          root: rowToRoot(root),
          operation: operation ? rowToOperation(operation) : undefined,
          handle,
          reason: "root_already_terminal",
        };
      }

      const operationBoundary = typeof operation?.metadata?.boundary === "string"
        ? operation.metadata.boundary as DeviceExecutionBoundaryKind
        : null;
      const operationPolicy = operationBoundary && operationBoundary in DEVICE_EXECUTION_BOUNDARY_MATRIX
        ? DEVICE_EXECUTION_BOUNDARY_MATRIX[operationBoundary]
        : null;
      const isServerWorkflowChild = root.root_kind === "server_workflow" &&
        operation !== null &&
        operationPolicy?.requiresExistingRootHandle === true &&
        operationPolicy.retainsRootUntilTerminal === false;
      const terminal = isServerWorkflowChild
        ? root.state === "dispatching"
          ? await updateRootState(client, {
              rootId: root.id,
              fromStates: ["dispatching"],
              toState: "dispatched",
              ownerGenerationIncrement: false,
              metadata: input.metadata,
            })
          : root
        : await updateRootTerminal(client, {
            rootId: root.id,
            deviceId: input.deviceId,
            ownerGeneration: expectedGeneration,
            toState: terminalState,
            reason: input.reason ?? input.status,
            metadata: input.metadata,
          });
      if (!terminal) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "result_rejected_terminal_cas_missed",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "terminal_cas_missed",
          metadata: { externalId: input.externalId, operationKind, operationId, expectedGeneration, handle: encodeDeviceExecutionHandle(handle), ...(input.metadata ?? {}) },
        });
        return {
          decision: "rejected",
          root: rowToRoot(root),
          operation: operation ? rowToOperation(operation) : undefined,
          handle,
          reason: "terminal_cas_missed",
        };
      }
      const terminalOperation = operation
        ? await updateOperationState(client, {
            operationKind: operation.operation_kind,
            operationId: operation.operation_id,
            fromStates: ["registered", "dispatching", "dispatched", "reconciling", "blocked", "rejected"],
            toState: terminalState,
            ownerGeneration: expectedGeneration,
            metadata: input.metadata,
          }) ?? operation
        : operationId
          ? await upsertOperation(client, {
              root: terminal,
              operationKind,
              operationId,
              state: terminalState,
              egressLane: "device_execution",
              wireType: rootKindToWireType(rootKind),
              metadata: input.metadata ?? {},
            })
          : null;
      await insertEvent(client, {
        rootId: terminal.id,
        deviceId: terminal.device_id,
        eventType: isServerWorkflowChild ? "child_result_accepted" : "root_terminal",
        previousState: root.state,
        newState: terminal.state,
        actor: input.actor ?? "transport",
        reason: input.reason ?? input.status,
        metadata: { externalId: input.externalId, operationKind, operationId, handle: encodeDeviceExecutionHandle(terminalOperation ? operationRowToHandle(terminalOperation) : handle), ...(input.metadata ?? {}) },
      });
      return {
        decision: "terminal",
        root: rowToRoot(terminal),
        operation: terminalOperation ? rowToOperation(terminalOperation) : undefined,
        handle: terminalOperation ? operationRowToHandle(terminalOperation) : handle,
      };
    });
  }

  async acceptJobResult(input: {
    deviceId: string;
    jobId: string;
    /** Server-side expected permit handle, when a typed waiter exists. */
    handle?: DeviceExecutionHandle | null;
    /** Handle echoed by the device on the wire. Never substitute `handle` for this. */
    reportedHandle?: DeviceExecutionHandle | null;
    /** Explicit compatibility lane for jobs dispatched before typed PNQ handles existed. */
    allowLegacyMissingHandle?: boolean;
    status: "completed" | "failed" | "cancelled" | string;
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionAcceptedJobResult> {
    const terminalState = normalizeTerminalState(input.status);
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const operationKind: DeviceExecutionOperationKind = "job";
      const operationId = input.jobId;
      const operation = await selectOperationByIdentity(client, operationKind, operationId, true);
      if (!operation) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "job_result_rejected_missing_operation",
          actor: input.actor ?? "transport",
          reason: "no_matching_operation",
          metadata: { jobId: input.jobId, ...(input.metadata ?? {}) },
        });
        return { accepted: false, decision: "missing", root: null, reason: "no_matching_operation" };
      }

      const root = await selectRoot(client, {
        rootId: input.handle?.rootId ?? operation.root_id,
        rootKind: input.handle?.rootKind ?? operation.root_kind,
        forUpdate: true,
      });
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "job_result_rejected_missing_root",
          actor: input.actor ?? "transport",
          reason: "no_matching_root",
          metadata: { jobId: input.jobId, operationRootId: operation.root_id, ...(input.metadata ?? {}) },
        });
        return { accepted: false, decision: "missing", root: null, reason: "no_matching_root" };
      }

      const handle = operationRowToHandle(operation);
      const expectedGeneration = toNumber(operation.owner_generation);

      const expectedHandleMismatch = input.handle && !deviceExecutionHandlesEqual(input.handle, handle);
      const reportedHandleMissing = !input.reportedHandle && !input.allowLegacyMissingHandle;
      const reportedHandleMismatch = input.reportedHandle && !deviceExecutionHandlesEqual(input.reportedHandle, handle);
      if (expectedHandleMismatch || reportedHandleMissing || reportedHandleMismatch) {
        const reason = expectedHandleMismatch
          ? "job_result_expected_handle_mismatch"
          : reportedHandleMissing
            ? "job_result_handle_required"
            : "job_result_reported_handle_mismatch";
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "job_result_rejected_handle",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason,
          metadata: {
            jobId: input.jobId,
            expectedHandle: encodeDeviceExecutionHandle(handle),
            serverHandle: input.handle ? encodeDeviceExecutionHandle(input.handle) : null,
            reportedHandle: input.reportedHandle ? encodeDeviceExecutionHandle(input.reportedHandle) : null,
            legacyMissingHandleAllowed: input.allowLegacyMissingHandle === true,
            ...(input.metadata ?? {}),
          },
        });
        return {
          accepted: false,
          decision: "rejected",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          reason,
        };
      }

      const isCurrentDispatchOwner =
        operation.operation_id === input.jobId &&
        operation.operation_kind === "job" &&
        operation.root_id === root.id &&
        root.device_id === input.deviceId &&
        operation.device_id === input.deviceId &&
        toNumber(root.owner_generation) === expectedGeneration &&
        ((operation.state === "dispatching" && (root.state === "dispatching" || root.state === "dispatched")) ||
          (operation.state === "dispatched" && root.state === "dispatched"));
      if (
        !isCurrentDispatchOwner ||
        toNumber(operation.owner_generation) !== expectedGeneration
      ) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "job_result_rejected_not_current_owner",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "job_result_not_current_dispatch_owner",
          metadata: {
            jobId: input.jobId,
            expectedHandle: encodeDeviceExecutionHandle(handle),
            rootDeviceId: root.device_id,
            operationDeviceId: operation.device_id,
            rootGeneration: toNumber(root.owner_generation),
            operationGeneration: toNumber(operation.owner_generation),
            rootState: root.state,
            operationState: operation.state,
            ...(input.metadata ?? {}),
          },
        });
        return {
          accepted: false,
          decision: "rejected",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          reason: "job_result_not_current_dispatch_owner",
        };
      }

      const operationBoundary = typeof operation.metadata?.boundary === "string" ? operation.metadata.boundary : null;
      const isServerWorkflowChild = root.root_kind === "server_workflow" &&
        operation.operation_kind === "job" &&
        operationBoundary !== null &&
        (["generated_child", "self_healing_child", "prestep_child", "recovery_child"] as readonly string[]).includes(operationBoundary);
      const terminal = isServerWorkflowChild
        ? root.state === "dispatching"
          ? await updateRootState(client, {
              rootId: root.id,
              fromStates: ["dispatching"],
              toState: "dispatched",
              ownerGenerationIncrement: false,
              metadata: input.metadata,
            })
          : root
        : await updateRootTerminal(client, {
            rootId: root.id,
            deviceId: input.deviceId,
            ownerGeneration: expectedGeneration,
            toState: terminalState,
            reason: input.reason ?? input.status,
            metadata: input.metadata,
          });
      if (!terminal) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "job_result_rejected_terminal_cas_missed",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "transport",
          reason: "terminal_cas_missed",
          metadata: { jobId: input.jobId, handle: encodeDeviceExecutionHandle(handle), ...(input.metadata ?? {}) },
        });
        return {
          accepted: false,
          decision: "rejected",
          root: rowToRoot(root),
          operation: rowToOperation(operation),
          handle,
          reason: "terminal_cas_missed",
        };
      }

      const terminalOperation = await updateOperationState(client, {
        operationKind: operation.operation_kind,
        operationId: operation.operation_id,
        fromStates: ["dispatching", "dispatched"],
        toState: terminalState,
        ownerGeneration: expectedGeneration,
        metadata: input.metadata,
      }) ?? operation;
      await insertEvent(client, {
        rootId: terminal.id,
        deviceId: terminal.device_id,
        eventType: isServerWorkflowChild ? "child_job_result_accepted" : "job_result_accepted",
        previousState: root.state,
        newState: terminal.state,
        actor: input.actor ?? "transport",
        reason: input.reason ?? input.status,
        metadata: {
          jobId: input.jobId,
          handle: encodeDeviceExecutionHandle(operationRowToHandle(terminalOperation)),
          ...(input.metadata ?? {}),
        },
      });
      return {
        accepted: true,
          decision: "terminal",
        root: rowToRoot(terminal),
        operation: rowToOperation(terminalOperation),
        handle: operationRowToHandle(terminalOperation),
      };
    });
  }

  async finishServerWorkflowRoot(input: {
    deviceId: string;
    workflowId: string;
    status: "completed" | "failed" | "cancelled";
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const root = await selectRootByExternalId(client, "server_workflow", input.workflowId, true);
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "server_workflow_finish_rejected",
          actor: input.actor ?? "workflow_executor",
          reason: "canonical_root_not_found",
          metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
        });
        return { decision: "missing", root: null, reason: "canonical_root_not_found" };
      }
      if (root.device_id !== input.deviceId || isTerminalState(root.state) || root.state === "blocked" || root.state === "reconciling") {
        const reason = root.device_id !== input.deviceId
          ? "root_owned_by_different_device"
          : isTerminalState(root.state)
            ? "root_already_terminal"
            : "root_ambiguous_not_finishable";
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "server_workflow_finish_rejected",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "workflow_executor",
          reason,
          metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
        });
        return { decision: "rejected", root: rowToRoot(root), reason };
      }

      const generation = toNumber(root.owner_generation);
      const terminal = await updateRootTerminal(client, {
        rootId: root.id,
        deviceId: input.deviceId,
        ownerGeneration: generation,
        toState: input.status,
        reason: input.reason ?? input.status,
        metadata: input.metadata,
      });
      if (!terminal) return { decision: "rejected", root: rowToRoot(root), reason: "terminal_cas_missed" };

      const rootOperation = await selectOperationByIdentity(client, "workflow", input.workflowId, true);
      const terminalOperation = rootOperation
        ? await updateOperationState(client, {
            operationKind: "workflow",
            operationId: input.workflowId,
            fromStates: ["registered", "dispatching", "dispatched", "reconciling", "blocked", "rejected"],
            toState: input.status,
            ownerGeneration: generation,
            metadata: input.metadata,
          }) ?? rootOperation
        : null;
      await insertEvent(client, {
        rootId: terminal.id,
        deviceId: terminal.device_id,
        eventType: "server_workflow_root_terminal",
        previousState: root.state,
        newState: terminal.state,
        actor: input.actor ?? "workflow_executor",
        reason: input.reason ?? input.status,
        metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
      });
      return {
        decision: "terminal",
        root: rowToRoot(terminal),
        operation: terminalOperation ? rowToOperation(terminalOperation) : undefined,
      };
    });
  }

  /**
   * Cancel a server workflow only while it is still queued and therefore has
   * never owned the device slot. The queued-state CAS is the authority: an
   * in-memory caller may be stale because the queue pump can dispatch between
   * the original response and a later cancellation request.
   */
  async cancelQueuedServerWorkflowRoot(input: {
    deviceId: string;
    workflowId: string;
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const root = await selectRootByExternalId(client, "server_workflow", input.workflowId, true);
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "queued_server_workflow_cancel_rejected",
          actor: input.actor ?? "workflow_dispatch.cancel",
          reason: "canonical_root_not_found",
          metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
        });
        return { decision: "missing", root: null, reason: "canonical_root_not_found" };
      }
      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "queued_server_workflow_cancel_rejected",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "workflow_dispatch.cancel",
          reason: "root_owned_by_different_device",
          metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_owned_by_different_device" };
      }
      if (root.state !== "queued") {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "queued_server_workflow_cancel_rejected",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "workflow_dispatch.cancel",
          reason: "root_not_queued",
          metadata: { workflowId: input.workflowId, ...(input.metadata ?? {}) },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_not_queued" };
      }

      const generation = toNumber(root.owner_generation);
      const terminal = await updateQueuedRootTerminal(client, {
        rootId: root.id,
        deviceId: input.deviceId,
        ownerGeneration: generation,
        reason: input.reason ?? "queued_workflow_cancelled_before_dispatch",
        metadata: input.metadata,
      });
      if (!terminal) {
        const current = await selectRoot(client, { rootId: root.id, rootKind: "server_workflow", forUpdate: true });
        return {
          decision: "rejected",
          root: current ? rowToRoot(current) : rowToRoot(root),
          reason: "root_not_queued",
        };
      }

      const cancelledOperations = await cancelRegisteredOperationsForRoot(client, {
        rootId: root.id,
        ownerGeneration: generation,
        metadata: input.metadata,
      });
      const terminalOperation = cancelledOperations.find((operation) =>
        operation.operation_kind === "workflow" && operation.operation_id === input.workflowId
      ) ?? null;
      await insertEvent(client, {
        rootId: terminal.id,
        deviceId: terminal.device_id,
        eventType: "queued_server_workflow_cancelled",
        previousState: root.state,
        newState: terminal.state,
        actor: input.actor ?? "workflow_dispatch.cancel",
        reason: input.reason ?? "queued_workflow_cancelled_before_dispatch",
        metadata: {
          workflowId: input.workflowId,
          cancelledOperationCount: cancelledOperations.length,
          ...(input.metadata ?? {}),
        },
      });
      return {
        decision: "terminal",
        root: rowToRoot(terminal),
        operation: terminalOperation ? rowToOperation(terminalOperation) : undefined,
      };
    });
  }

  async markAmbiguous(input: {
    deviceId: string;
    rootKind?: DeviceExecutionRootKind;
    externalId?: string;
    rootId?: string;
    handle?: DeviceExecutionHandle;
    ownerGeneration?: number;
    reason: string;
    actor?: string;
    state?: Extract<DeviceExecutionState, "reconciling" | "blocked">;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const toState = input.state ?? "blocked";
    const rootKind = input.rootKind ?? input.handle?.rootKind ?? "job";
    const operationKind = input.handle?.operationKind ?? rootKindToOperationKind(rootKind);
    const operationId = input.handle?.operationId ?? input.externalId;
    return this.withTransaction(async (client) => {
      await lockDevice(client, input.deviceId);
      const operation = operationId
        ? await selectOperationByIdentity(client, operationKind, operationId, true)
        : null;
      const root = await selectRoot(client, {
        rootId: input.handle?.rootId ?? input.rootId ?? operation?.root_id,
        rootKind,
        externalId: input.externalId,
        forUpdate: true,
      });
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "ambiguity_without_root",
          actor: input.actor ?? "server",
          reason: input.reason,
          metadata: { externalId: input.externalId, ...(input.metadata ?? {}) },
        });
        return { decision: "missing", root: null, reason: "no_matching_root" };
      }

      if (root.device_id !== input.deviceId) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: input.deviceId,
          eventType: "ambiguity_rejected_wrong_device",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "server",
          reason: "root_owned_by_different_device",
          metadata: { rootDeviceId: root.device_id, externalId: input.externalId },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_owned_by_different_device" };
      }

      if (isTerminalState(root.state)) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "ambiguity_after_terminal_ignored",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "server",
          reason: input.reason,
          metadata: input.metadata ?? {},
        });
        return { decision: "ignored", root: rowToRoot(root), reason: "root_already_terminal" };
      }

      const expectedGeneration = input.handle?.ownerGeneration
        ?? input.ownerGeneration
        ?? (operation ? toNumber(operation.owner_generation) : toNumber(root.owner_generation));
      const handle = operation
        ? operationRowToHandle(operation)
        : rootToHandle(root, operationKind, operationId ?? input.externalId ?? root.id, expectedGeneration);
      if (toNumber(root.owner_generation) !== expectedGeneration) {
        await insertEvent(client, {
          rootId: root.id,
          deviceId: root.device_id,
          eventType: "ambiguity_rejected_stale_generation",
          previousState: root.state,
          newState: root.state,
          actor: input.actor ?? "server",
          reason: "owner_generation_mismatch",
          metadata: {
            externalId: input.externalId,
            operationKind,
            operationId,
            expectedGeneration,
            actualGeneration: toNumber(root.owner_generation),
            handle: encodeDeviceExecutionHandle(handle),
            ...(input.metadata ?? {}),
          },
        });
        return {
          decision: "rejected",
          root: rowToRoot(root),
          operation: operation ? rowToOperation(operation) : undefined,
          handle,
          reason: "owner_generation_mismatch",
        };
      }

      const ambiguous = await updateRootAmbiguous(client, {
        rootId: root.id,
        deviceId: input.deviceId,
        ownerGeneration: expectedGeneration,
        toState,
        reason: input.reason,
        metadata: input.metadata,
      });
      if (!ambiguous) {
        return { decision: "ignored", root: rowToRoot(root), reason: "ambiguity_cas_missed" };
      }

      const ambiguousOperation = operation
        ? await updateOperationState(client, {
            operationKind: operation.operation_kind,
            operationId: operation.operation_id,
            fromStates: ["registered", "dispatching", "dispatched", "reconciling", "blocked", "rejected"],
            toState,
            ownerGeneration: expectedGeneration,
            metadata: input.metadata,
          }) ?? operation
        : null;

      await insertEvent(client, {
        rootId: ambiguous.id,
        deviceId: ambiguous.device_id,
        eventType: "root_ambiguous",
        previousState: root.state,
        newState: ambiguous.state,
        actor: input.actor ?? "server",
        reason: input.reason,
        metadata: { externalId: input.externalId, operationKind, operationId, handle: encodeDeviceExecutionHandle(ambiguousOperation ? operationRowToHandle(ambiguousOperation) : handle), ...(input.metadata ?? {}) },
      });
      return {
        decision: "ambiguous",
        root: rowToRoot(ambiguous),
        operation: ambiguousOperation ? rowToOperation(ambiguousOperation) : undefined,
        handle: ambiguousOperation ? operationRowToHandle(ambiguousOperation) : handle,
        reason: input.reason,
      };
    });
  }

  async reconcileInFlightAtStartup(input: {
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<{ reconciledRoots: number; activeAmbiguousRoots: number }> {
    const actor = input.actor ?? "startup";
    const reason = input.reason ?? "server_startup_reconciliation";
    const metadata = {
      ...(input.metadata ?? {}),
      failClosed: true,
      observeMode: true,
    };

    return this.withTransaction(async (client) => {
      const reconciled = await client.query<{ id: string }>(
        `
        WITH candidates AS (
          SELECT id, device_id, state AS previous_state
          FROM device_execution_roots
          WHERE state IN ('claimed', 'dispatching', 'dispatched')
          FOR UPDATE
        ),
        updated_roots AS (
          UPDATE device_execution_roots roots
          SET state = 'reconciling',
              reconciliation_reason = $1,
              updated_at = NOW(),
              metadata = roots.metadata || $3::jsonb
          FROM candidates
          WHERE roots.id = candidates.id
          RETURNING roots.id, roots.device_id, candidates.previous_state, roots.state
        ),
        updated_operations AS (
          UPDATE device_execution_operations operations
          SET state = 'reconciling',
              updated_at = NOW(),
              metadata = operations.metadata || $3::jsonb
          FROM updated_roots
          WHERE operations.root_id = updated_roots.id
            AND operations.state IN ('registered', 'dispatching', 'dispatched')
          RETURNING operations.id
        )
        INSERT INTO device_execution_events
          (root_id, device_id, event_type, previous_state, new_state, actor, reason, metadata)
        SELECT id, device_id, 'startup_reconciled_root', previous_state, state, $2, $1, $3::jsonb
        FROM updated_roots
        RETURNING root_id AS id
        `,
        [reason, actor, JSON.stringify(metadata)]
      );

      const ambiguous = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM device_execution_roots WHERE state IN ('reconciling', 'blocked')"
      );

      return {
        reconciledRoots: reconciled.rowCount ?? reconciled.rows.length,
        activeAmbiguousRoots: Number(ambiguous.rows[0]?.count ?? 0),
      };
    });
  }

  async getDeviceSnapshot(deviceId: string): Promise<{
    deviceId: string;
    activeRoot: DeviceExecutionRoot | null;
    queuedCount: number;
    recentRoots: DeviceExecutionRoot[];
  }> {
    const [active, queued, recent] = await Promise.all([
      this.dbProvider().query<DeviceExecutionRootRow>(
        `SELECT * FROM device_execution_roots
         WHERE device_id = $1 AND state IN (${ACTIVE_STATE_SQL})
         ORDER BY updated_at DESC
         LIMIT 1`,
        [deviceId]
      ),
      this.dbProvider().query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM device_execution_roots WHERE device_id = $1 AND state = 'queued'",
        [deviceId]
      ),
      this.dbProvider().query<DeviceExecutionRootRow>(
        `SELECT * FROM device_execution_roots
         WHERE device_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [deviceId]
      ),
    ]);

    return {
      deviceId,
      activeRoot: active.rows[0] ? rowToRoot(active.rows[0]) : null,
      queuedCount: Number(queued.rows[0]?.count ?? 0),
      recentRoots: recent.rows.map(rowToRoot),
    };
  }

  private async withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await this.dbProvider().connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("[device-execution] rollback failed:", (rollbackErr as Error).message);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

async function lockDevice(client: Queryable, deviceId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [deviceId]);
}

async function selectRootByExternalId(
  client: Queryable,
  rootKind: DeviceExecutionRootKind,
  externalId: string,
  forUpdate: boolean,
): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `SELECT * FROM device_execution_roots
     WHERE root_kind = $1 AND external_id = $2
     LIMIT 1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [rootKind, externalId]
  );
  return result.rows[0] ?? null;
}

async function selectRoot(
  client: Queryable,
  input: {
    rootId?: string;
    rootKind: DeviceExecutionRootKind;
    externalId?: string;
    forUpdate: boolean;
  },
): Promise<DeviceExecutionRootRow | null> {
  if (input.rootId) {
    const result = await client.query<DeviceExecutionRootRow>(
      `SELECT * FROM device_execution_roots WHERE id = $1 LIMIT 1 ${input.forUpdate ? "FOR UPDATE" : ""}`,
      [input.rootId]
    );
    return result.rows[0] ?? null;
  }
  if (!input.externalId) return null;
  return selectRootByExternalId(client, input.rootKind, input.externalId, input.forUpdate);
}

async function selectOperationByIdentity(
  client: Queryable,
  operationKind: DeviceExecutionOperationKind,
  operationId: string,
  forUpdate: boolean,
): Promise<DeviceExecutionOperationRow | null> {
  const result = await client.query<DeviceExecutionOperationRow>(
    `SELECT * FROM device_execution_operations
     WHERE operation_kind = $1 AND operation_id = $2
     LIMIT 1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [operationKind, operationId]
  );
  return result.rows[0] ?? null;
}

async function selectActiveRoot(client: Queryable, deviceId: string): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `SELECT * FROM device_execution_roots
     WHERE device_id = $1 AND state IN (${ACTIVE_STATE_SQL})
     ORDER BY updated_at DESC
     LIMIT 1
     FOR UPDATE`,
    [deviceId]
  );
  return result.rows[0] ?? null;
}

async function selectOldestQueuedRoot(client: Queryable, deviceId: string): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `SELECT * FROM device_execution_roots
     WHERE device_id = $1 AND state = 'queued'
     ORDER BY fifo_sequence ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [deviceId]
  );
  return result.rows[0] ?? null;
}

async function insertRoot(
  client: Queryable,
  input: {
    deviceId: string;
    rootKind: DeviceExecutionRootKind;
    externalId: string | null;
    requestKey: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow> {
  const result = await client.query<DeviceExecutionRootRow>(
    `INSERT INTO device_execution_roots
       (device_id, root_kind, external_id, request_key, state, metadata)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb)
     RETURNING *`,
    [
      input.deviceId,
      input.rootKind,
      input.externalId,
      input.requestKey,
      JSON.stringify(input.metadata),
    ]
  );
  return result.rows[0];
}

async function upsertOperation(
  client: Queryable,
  input: {
    root: DeviceExecutionRootRow;
    operationKind: DeviceExecutionOperationKind;
    operationId: string;
    state: DeviceExecutionOperationState;
    egressLane: DeviceExecutionEgressLane;
    wireType: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<DeviceExecutionOperationRow> {
  const handle = rootToHandle(input.root, input.operationKind, input.operationId, toNumber(input.root.owner_generation));
  const result = await client.query<DeviceExecutionOperationRow>(
    `INSERT INTO device_execution_operations
       (root_id, device_id, root_kind, operation_kind, operation_id, owner_generation, state, egress_lane, wire_type, wire_handle, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10::jsonb, $11::jsonb)
     ON CONFLICT (operation_kind, operation_id) DO UPDATE
       SET owner_generation = CASE
             WHEN device_execution_operations.state = 'registered' THEN EXCLUDED.owner_generation
             ELSE device_execution_operations.owner_generation
           END,
           state = CASE
             WHEN device_execution_operations.state = 'registered' THEN EXCLUDED.state
             ELSE device_execution_operations.state
           END,
           egress_lane = EXCLUDED.egress_lane,
           wire_type = COALESCE(EXCLUDED.wire_type, device_execution_operations.wire_type),
           wire_handle = CASE
             WHEN device_execution_operations.state = 'registered' THEN EXCLUDED.wire_handle
             ELSE device_execution_operations.wire_handle
           END,
           metadata = CASE
             WHEN device_execution_operations.metadata ? 'dispatchEnvelope'
               THEN device_execution_operations.metadata || (EXCLUDED.metadata - 'dispatchEnvelope')
             ELSE device_execution_operations.metadata || EXCLUDED.metadata
           END,
           updated_at = NOW()
       WHERE device_execution_operations.root_id = EXCLUDED.root_id
     RETURNING *`,
    [
      input.root.id,
      input.root.device_id,
      input.root.root_kind,
      input.operationKind,
      input.operationId,
      toNumber(input.root.owner_generation),
      input.state,
      input.egressLane,
      input.wireType,
      JSON.stringify(encodeDeviceExecutionHandle(handle)),
      JSON.stringify(input.metadata),
    ]
  );
  if (result.rows[0]) return result.rows[0];

  const existing = await selectOperationByIdentity(client, input.operationKind, input.operationId, true);
  if (existing) return existing;
  throw new Error(`Device execution operation ${input.operationKind}:${input.operationId} was not written`);
}

async function updateRootState(
  client: Queryable,
  input: {
    rootId: string;
    fromStates: DeviceExecutionState[];
    toState: Extract<DeviceExecutionState, "claimed" | "dispatching" | "dispatched">;
    ownerGenerationIncrement: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow | null> {
  const timestampColumn =
    input.toState === "claimed"
      ? "claimed_at"
      : input.toState === "dispatching"
        ? "dispatching_at"
        : "dispatched_at";
  const result = await client.query<DeviceExecutionRootRow>(
    `UPDATE device_execution_roots
     SET state = $1,
         owner_generation = owner_generation + $2::bigint,
         ${timestampColumn} = NOW(),
         updated_at = NOW(),
         metadata = metadata || $3::jsonb
     WHERE id = $4
       AND state = ANY($5::text[])
     RETURNING *`,
    [
      input.toState,
      input.ownerGenerationIncrement ? 1 : 0,
      JSON.stringify(input.metadata ?? {}),
      input.rootId,
      input.fromStates,
    ]
  );
  return result.rows[0] ?? null;
}

async function updateOperationState(
  client: Queryable,
  input: {
    operationKind: DeviceExecutionOperationKind;
    operationId: string;
    fromStates: DeviceExecutionOperationState[];
    toState: DeviceExecutionOperationState;
    ownerGeneration?: number;
    wireHandle?: DeviceExecutionWireHandle;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionOperationRow | null> {
  const timestampColumn =
    input.toState === "dispatching"
      ? "dispatching_at"
      : input.toState === "dispatched"
        ? "dispatched_at"
        : isTerminalOperationState(input.toState)
          ? "terminal_at"
          : null;
  const timestampAssignment = timestampColumn ? `, ${timestampColumn} = NOW()` : "";
  const result = await client.query<DeviceExecutionOperationRow>(
    `UPDATE device_execution_operations
     SET state = $1,
         owner_generation = COALESCE($2::bigint, owner_generation),
         updated_at = NOW(),
         metadata = metadata || $3::jsonb,
         wire_handle = COALESCE($4::jsonb, wire_handle)
         ${timestampAssignment}
     WHERE operation_kind = $5
       AND operation_id = $6
       AND state = ANY($7::text[])
     RETURNING *`,
    [
      input.toState,
      input.ownerGeneration ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.wireHandle ? JSON.stringify(input.wireHandle) : null,
      input.operationKind,
      input.operationId,
      input.fromStates,
    ]
  );
  return result.rows[0] ?? null;
}

async function cancelRegisteredOperationsForRoot(
  client: Queryable,
  input: {
    rootId: string;
    ownerGeneration: number;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionOperationRow[]> {
  const result = await client.query<DeviceExecutionOperationRow>(
    `UPDATE device_execution_operations
     SET state = 'cancelled',
         owner_generation = $2::bigint,
         terminal_at = NOW(),
         updated_at = NOW(),
         metadata = metadata || $3::jsonb
     WHERE root_id = $1
       AND state = 'registered'
     RETURNING *`,
    [input.rootId, input.ownerGeneration, JSON.stringify(input.metadata ?? {})],
  );
  return result.rows;
}

async function updateRootTerminal(
  client: Queryable,
  input: {
    rootId: string;
    deviceId: string;
    ownerGeneration: number;
    toState: Extract<DeviceExecutionState, "completed" | "failed" | "cancelled">;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `UPDATE device_execution_roots
     SET state = $1,
         terminal_reason = $2,
         terminal_at = NOW(),
         updated_at = NOW(),
         metadata = metadata || $3::jsonb
     WHERE id = $4
       AND device_id = $5
       AND owner_generation = $6::bigint
       AND state NOT IN (${TERMINAL_STATE_SQL})
     RETURNING *`,
    [
      input.toState,
      input.reason,
      JSON.stringify(input.metadata ?? {}),
      input.rootId,
      input.deviceId,
      input.ownerGeneration,
    ]
  );
  return result.rows[0] ?? null;
}

async function updateQueuedRootTerminal(
  client: Queryable,
  input: {
    rootId: string;
    deviceId: string;
    ownerGeneration: number;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `UPDATE device_execution_roots
     SET state = 'cancelled',
         terminal_reason = $1,
         terminal_at = NOW(),
         updated_at = NOW(),
         metadata = metadata || $2::jsonb
     WHERE id = $3
       AND device_id = $4
       AND owner_generation = $5::bigint
       AND state = 'queued'
     RETURNING *`,
    [
      input.reason,
      JSON.stringify(input.metadata ?? {}),
      input.rootId,
      input.deviceId,
      input.ownerGeneration,
    ]
  );
  return result.rows[0] ?? null;
}

async function updateRootAmbiguous(
  client: Queryable,
  input: {
    rootId: string;
    deviceId: string;
    ownerGeneration: number;
    toState: Extract<DeviceExecutionState, "reconciling" | "blocked">;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow | null> {
  const result = await client.query<DeviceExecutionRootRow>(
    `UPDATE device_execution_roots
     SET state = $1,
         reconciliation_reason = $2,
         updated_at = NOW(),
         metadata = metadata || $3::jsonb
     WHERE id = $4
       AND device_id = $5
       AND owner_generation = $6::bigint
       AND state NOT IN (${TERMINAL_STATE_SQL})
     RETURNING *`,
    [
      input.toState,
      input.reason,
      JSON.stringify(input.metadata ?? {}),
      input.rootId,
      input.deviceId,
      input.ownerGeneration,
    ]
  );
  return result.rows[0] ?? null;
}

async function insertEvent(
  client: Queryable,
  input: {
    rootId?: string;
    deviceId?: string;
    eventType: string;
    previousState?: DeviceExecutionState;
    newState?: DeviceExecutionState;
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO device_execution_events
       (root_id, device_id, event_type, previous_state, new_state, actor, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.rootId ?? null,
      input.deviceId ?? null,
      input.eventType,
      input.previousState ?? null,
      input.newState ?? null,
      input.actor ?? "server",
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

function rowToRoot(row: DeviceExecutionRootRow): DeviceExecutionRoot {
  return {
    id: row.id,
    deviceId: row.device_id,
    rootKind: row.root_kind,
    externalId: row.external_id,
    requestKey: row.request_key,
    state: row.state,
    fifoSequence: toNumber(row.fifo_sequence),
    ownerGeneration: toNumber(row.owner_generation),
    observeMode: row.observe_mode,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOperation(row: DeviceExecutionOperationRow): DeviceExecutionOperation {
  return {
    id: toNumber(row.id),
    rootId: row.root_id,
    deviceId: row.device_id,
    rootKind: row.root_kind,
    operationKind: row.operation_kind,
    operationId: row.operation_id,
    ownerGeneration: toNumber(row.owner_generation),
    state: row.state,
    egressLane: row.egress_lane,
    wireType: row.wire_type,
    wireHandle: row.wire_handle ?? operationRowToWireHandle(row),
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rootToHandle(
  root: DeviceExecutionRootRow,
  operationKind: DeviceExecutionOperationKind,
  operationId: string,
  ownerGeneration = toNumber(root.owner_generation),
): DeviceExecutionHandle {
  return {
    rootId: root.id,
    deviceId: root.device_id,
    rootKind: root.root_kind,
    ownerGeneration,
    operationKind,
    operationId,
  };
}

function operationRowToHandle(row: DeviceExecutionOperationRow): DeviceExecutionHandle {
  return {
    rootId: row.root_id,
    deviceId: row.device_id,
    rootKind: row.root_kind,
    ownerGeneration: toNumber(row.owner_generation),
    operationKind: row.operation_kind,
    operationId: row.operation_id,
  };
}

function operationRowToWireHandle(row: DeviceExecutionOperationRow): DeviceExecutionWireHandle {
  return encodeDeviceExecutionHandle(operationRowToHandle(row));
}

export function encodeDeviceExecutionHandle(handle: DeviceExecutionHandle): DeviceExecutionWireHandle {
  return {
    pnqRootId: handle.rootId,
    pnqDeviceId: handle.deviceId,
    pnqRootKind: handle.rootKind,
    pnqOwnerGeneration: handle.ownerGeneration,
    pnqOperationKind: handle.operationKind,
    pnqOperationId: handle.operationId,
  };
}

export function decodeDeviceExecutionHandle(value: unknown): DeviceExecutionHandle | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.pnqRootId !== "string" ||
    typeof record.pnqDeviceId !== "string" ||
    typeof record.pnqRootKind !== "string" ||
    typeof record.pnqOwnerGeneration !== "number" ||
    typeof record.pnqOperationKind !== "string" ||
    typeof record.pnqOperationId !== "string"
  ) {
    return null;
  }

  if (!isRootKind(record.pnqRootKind) || !isOperationKind(record.pnqOperationKind)) return null;
  return {
    rootId: record.pnqRootId,
    deviceId: record.pnqDeviceId,
    rootKind: record.pnqRootKind,
    ownerGeneration: record.pnqOwnerGeneration,
    operationKind: record.pnqOperationKind,
    operationId: record.pnqOperationId,
  };
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function isTerminalState(state: DeviceExecutionState): boolean {
  return (DEVICE_EXECUTION_TERMINAL_STATES as readonly string[]).includes(state);
}

function isTerminalOperationState(state: DeviceExecutionOperationState): boolean {
  return (["completed", "failed", "cancelled"] as readonly string[]).includes(state);
}

function deviceExecutionHandlesEqual(left: DeviceExecutionHandle, right: DeviceExecutionHandle): boolean {
  return left.rootId === right.rootId &&
    left.deviceId === right.deviceId &&
    left.rootKind === right.rootKind &&
    left.ownerGeneration === right.ownerGeneration &&
    left.operationKind === right.operationKind &&
    left.operationId === right.operationId;
}

function rootKindToOperationKind(rootKind: DeviceExecutionRootKind): DeviceExecutionOperationKind {
  if (rootKind === "batch") return "batch";
  if (rootKind === "edge_workflow" || rootKind === "server_workflow") return "workflow";
  if (rootKind === "control") return "control";
  return "job";
}

function rootKindToWireType(rootKind: DeviceExecutionRootKind): string | null {
  if (rootKind === "job") return "JOB";
  if (rootKind === "batch") return "BATCH_START";
  if (rootKind === "edge_workflow" || rootKind === "server_workflow") return "WORKFLOW_START";
  if (rootKind === "control") return "CONTROL";
  return null;
}

function isRootKind(value: string): value is DeviceExecutionRootKind {
  return ["job", "batch", "edge_workflow", "server_workflow", "control", "unknown"].includes(value);
}

function isOperationKind(value: string): value is DeviceExecutionOperationKind {
  return ["job", "batch", "workflow", "control", "admin"].includes(value);
}

function normalizeTerminalState(status: string): Extract<DeviceExecutionState, "completed" | "failed" | "cancelled"> {
  if (status === "completed" || status === "cancelled") return status;
  return "failed";
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

export const deviceExecutionArbiter = new DeviceExecutionArbiter();
