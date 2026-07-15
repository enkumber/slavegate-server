import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { getDb } from "../../db/client";

export const DEVICE_EXECUTION_ACTIVE_STATES = ["claimed", "dispatched", "reconciling", "blocked"] as const;
export const DEVICE_EXECUTION_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

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
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciling"
  | "blocked";

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
  state: Extract<DeviceExecutionState, "claimed" | "dispatched">;
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
  activeRootId?: string;
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

interface SchemaValidationRow extends QueryResultRow {
  roots_table: boolean;
  events_table: boolean;
  active_index: boolean;
  fifo_index: boolean;
  missing_columns: unknown;
}

const ACTIVE_STATE_SQL = "'claimed', 'dispatched', 'reconciling', 'blocked'";
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
      WITH required_columns(table_name, column_name) AS (
        VALUES
          ('device_execution_roots', 'id'),
          ('device_execution_roots', 'device_id'),
          ('device_execution_roots', 'root_kind'),
          ('device_execution_roots', 'external_id'),
          ('device_execution_roots', 'request_key'),
          ('device_execution_roots', 'state'),
          ('device_execution_roots', 'fifo_sequence'),
          ('device_execution_roots', 'owner_generation'),
          ('device_execution_roots', 'observe_mode'),
          ('device_execution_roots', 'metadata'),
          ('device_execution_events', 'id'),
          ('device_execution_events', 'root_id'),
          ('device_execution_events', 'device_id'),
          ('device_execution_events', 'event_type'),
          ('device_execution_events', 'previous_state'),
          ('device_execution_events', 'new_state'),
          ('device_execution_events', 'actor'),
          ('device_execution_events', 'reason'),
          ('device_execution_events', 'metadata')
      )
      SELECT
        to_regclass('public.device_execution_roots') IS NOT NULL AS roots_table,
        to_regclass('public.device_execution_events') IS NOT NULL AS events_table,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'idx_device_execution_active_slot'
        ) AS active_index,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'idx_device_execution_roots_fifo'
        ) AS fifo_index,
        COALESCE(
          jsonb_agg(required_columns.table_name || '.' || required_columns.column_name)
            FILTER (WHERE columns.column_name IS NULL),
          '[]'::jsonb
        ) AS missing_columns
      FROM required_columns
      LEFT JOIN information_schema.columns columns
        ON columns.table_schema = 'public'
       AND columns.table_name = required_columns.table_name
       AND columns.column_name = required_columns.column_name
      `
    );
    const row = result.rows[0];
    const missingColumns = parseMissingColumns(row?.missing_columns);
    if (!row?.roots_table || !row.events_table || !row.active_index || !row.fifo_index || missingColumns.length > 0) {
      throw new DeviceExecutionSchemaError(
        [
          "PNQ-001 device execution queue schema unavailable",
          `roots_table=${Boolean(row?.roots_table)}`,
          `events_table=${Boolean(row?.events_table)}`,
          `active_index=${Boolean(row?.active_index)}`,
          `fifo_index=${Boolean(row?.fifo_index)}`,
          `missing_columns=${missingColumns.join(",") || "none"}`,
        ].join(" ")
      );
    }
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
        return { decision: "duplicate", root: rowToRoot(existing), reason: "external_id_already_recorded" };
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

      if (!input.sent) {
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
        return { decision: "offline", root: rowToRoot(root), reason: "device_offline_or_transport_rejected" };
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
        return { decision: "terminal", root: rowToRoot(root), reason: "root_already_terminal" };
      }

      if (root.state === "dispatched") {
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
        return { decision: "dispatched", root: rowToRoot(root), reason: "root_already_dispatched" };
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
          metadata: { ...(input.metadata ?? {}), activeRootId: active.id, activeState: active.state },
        });
        return { decision: "would_wait", root: rowToRoot(root), activeRootId: active.id };
      }

      const dispatched = await updateRootState(client, {
        rootId: root.id,
        fromStates: ["queued", "claimed"],
        toState: "dispatched",
        ownerGenerationIncrement: true,
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
        return { decision: "ignored", root: rowToRoot(root), reason: "state_changed_before_dispatch" };
      }
      await insertEvent(client, {
        rootId: dispatched.id,
        deviceId: dispatched.device_id,
        eventType: "root_dispatched",
        previousState: root.state,
        newState: dispatched.state,
        actor: input.actor ?? "transport",
        metadata: input.metadata ?? {},
      });
      return { decision: "dispatched", root: rowToRoot(dispatched) };
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
    status: "completed" | "failed" | "cancelled" | string;
    actor?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const terminalState = normalizeTerminalState(input.status);
    return this.withTransaction(async (client) => {
      const root = await selectRoot(client, {
        rootId: input.rootId,
        rootKind: input.rootKind ?? "job",
        externalId: input.externalId,
        forUpdate: true,
      });
      if (!root) {
        await insertEvent(client, {
          deviceId: input.deviceId,
          eventType: "result_without_root",
          actor: input.actor ?? "transport",
          reason: "no_matching_root",
          metadata: { externalId: input.externalId, status: input.status, ...(input.metadata ?? {}) },
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
          metadata: { rootDeviceId: root.device_id, externalId: input.externalId, ...(input.metadata ?? {}) },
        });
        return { decision: "rejected", root: rowToRoot(root), reason: "root_owned_by_different_device" };
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
          metadata: { externalId: input.externalId, status: input.status, ...(input.metadata ?? {}) },
        });
        return { decision: "ignored", root: rowToRoot(root), reason: "root_already_terminal" };
      }

      const terminal = await updateRootTerminal(client, {
        rootId: root.id,
        toState: terminalState,
        reason: input.reason ?? input.status,
        metadata: input.metadata,
      });
      if (!terminal) {
        return { decision: "ignored", root: rowToRoot(root), reason: "terminal_cas_missed" };
      }
      await insertEvent(client, {
        rootId: terminal.id,
        deviceId: terminal.device_id,
        eventType: "root_terminal",
        previousState: root.state,
        newState: terminal.state,
        actor: input.actor ?? "transport",
        reason: input.reason ?? input.status,
        metadata: { externalId: input.externalId, ...(input.metadata ?? {}) },
      });
      return { decision: "terminal", root: rowToRoot(terminal) };
    });
  }

  async markAmbiguous(input: {
    deviceId: string;
    rootKind?: DeviceExecutionRootKind;
    externalId?: string;
    rootId?: string;
    reason: string;
    actor?: string;
    state?: Extract<DeviceExecutionState, "reconciling" | "blocked">;
    metadata?: Record<string, unknown>;
  }): Promise<DeviceExecutionTransitionResult> {
    const toState = input.state ?? "blocked";
    return this.withTransaction(async (client) => {
      const root = await selectRoot(client, {
        rootId: input.rootId,
        rootKind: input.rootKind ?? "job",
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

      const ambiguous = await updateRootAmbiguous(client, {
        rootId: root.id,
        toState,
        reason: input.reason,
        metadata: input.metadata,
      });
      if (!ambiguous) {
        return { decision: "ignored", root: rowToRoot(root), reason: "ambiguity_cas_missed" };
      }

      await insertEvent(client, {
        rootId: ambiguous.id,
        deviceId: ambiguous.device_id,
        eventType: "root_ambiguous",
        previousState: root.state,
        newState: ambiguous.state,
        actor: input.actor ?? "server",
        reason: input.reason,
        metadata: { externalId: input.externalId, ...(input.metadata ?? {}) },
      });
      return { decision: "ambiguous", root: rowToRoot(ambiguous), reason: input.reason };
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

async function updateRootState(
  client: Queryable,
  input: {
    rootId: string;
    fromStates: DeviceExecutionState[];
    toState: Extract<DeviceExecutionState, "claimed" | "dispatched">;
    ownerGenerationIncrement: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<DeviceExecutionRootRow | null> {
  const timestampColumn = input.toState === "claimed" ? "claimed_at" : "dispatched_at";
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

async function updateRootTerminal(
  client: Queryable,
  input: {
    rootId: string;
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
       AND state NOT IN (${TERMINAL_STATE_SQL})
     RETURNING *`,
    [input.toState, input.reason, JSON.stringify(input.metadata ?? {}), input.rootId]
  );
  return result.rows[0] ?? null;
}

async function updateRootAmbiguous(
  client: Queryable,
  input: {
    rootId: string;
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
       AND state NOT IN (${TERMINAL_STATE_SQL})
     RETURNING *`,
    [input.toState, input.reason, JSON.stringify(input.metadata ?? {}), input.rootId]
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

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function isTerminalState(state: DeviceExecutionState): boolean {
  return (DEVICE_EXECUTION_TERMINAL_STATES as readonly string[]).includes(state);
}

function normalizeTerminalState(status: string): Extract<DeviceExecutionState, "completed" | "failed" | "cancelled"> {
  if (status === "completed" || status === "cancelled") return status;
  return "failed";
}

function parseMissingColumns(value: unknown): string[] {
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
