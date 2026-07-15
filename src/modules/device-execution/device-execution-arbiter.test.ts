import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  DeviceExecutionArbiter,
  DeviceExecutionSchemaError,
  decodeDeviceExecutionHandle,
  encodeDeviceExecutionHandle,
  DEVICE_EXECUTION_BOUNDARY_MATRIX,
  type DeviceExecutionRootKind,
  type DeviceExecutionOperationKind,
  type DeviceExecutionOperationState,
  type DeviceExecutionState,
} from "./device-execution-arbiter";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

interface RootRow {
  id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  external_id: string | null;
  request_key: string | null;
  state: DeviceExecutionState;
  fifo_sequence: number;
  owner_generation: number;
  observe_mode: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  root_id: string | null;
  device_id: string | null;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  actor: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}

interface OperationRow {
  id: number;
  root_id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  operation_kind: DeviceExecutionOperationKind;
  operation_id: string;
  owner_generation: number;
  state: DeviceExecutionOperationState;
  egress_lane: "device_execution" | "control" | "admin";
  wire_type: string | null;
  wire_handle: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function root(overrides: Partial<RootRow> = {}): RootRow {
  return {
    id: overrides.id ?? `root-${Math.random().toString(16).slice(2)}`,
    device_id: overrides.device_id ?? DEVICE_A,
    root_kind: overrides.root_kind ?? "job",
    external_id: overrides.external_id ?? null,
    request_key: overrides.request_key ?? null,
    state: overrides.state ?? "queued",
    fifo_sequence: overrides.fifo_sequence ?? 1,
    owner_generation: overrides.owner_generation ?? 0,
    observe_mode: overrides.observe_mode ?? true,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? new Date("2026-07-15T19:30:00.000Z"),
    updated_at: overrides.updated_at ?? new Date("2026-07-15T19:30:00.000Z"),
  };
}

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: overrides.id ?? 1,
    root_id: overrides.root_id ?? "root-1",
    device_id: overrides.device_id ?? DEVICE_A,
    root_kind: overrides.root_kind ?? "job",
    operation_kind: overrides.operation_kind ?? "job",
    operation_id: overrides.operation_id ?? "job-1",
    owner_generation: overrides.owner_generation ?? 0,
    state: overrides.state ?? "registered",
    egress_lane: overrides.egress_lane ?? "device_execution",
    wire_type: overrides.wire_type ?? null,
    wire_handle: overrides.wire_handle ?? {},
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? new Date("2026-07-15T19:30:00.000Z"),
    updated_at: overrides.updated_at ?? new Date("2026-07-15T19:30:00.000Z"),
  };
}

class FakeClient {
  roots: RootRow[] = [];
  operations: OperationRow[] = [];
  events: EventRow[] = [];
  committed = false;
  rolledBack = false;
  private nextRoot = 1;
  private nextOperation = 1;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
    if (normalized === "COMMIT") {
      this.committed = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.rolledBack = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };

    if (normalized.startsWith("SELECT * FROM device_execution_roots WHERE root_kind = $1 AND external_id = $2")) {
      const [rootKind, externalId] = params as [DeviceExecutionRootKind, string];
      const found = this.roots.find((item) => item.root_kind === rootKind && item.external_id === externalId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT * FROM device_execution_roots WHERE id = $1 LIMIT 1")) {
      const [rootId] = params as [string];
      const found = this.roots.find((item) => item.id === rootId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT * FROM device_execution_operations WHERE operation_kind = $1 AND operation_id = $2")) {
      const [operationKind, operationId] = params as [DeviceExecutionOperationKind, string];
      const found = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.includes("WHERE device_id = $1 AND state IN ('claimed', 'dispatching', 'dispatched', 'reconciling', 'blocked')")) {
      const [deviceId] = params as [string];
      const found = this.roots.find((item) => item.device_id === deviceId && ["claimed", "dispatching", "dispatched", "reconciling", "blocked"].includes(item.state));
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.includes("WHERE device_id = $1 AND state = 'queued'")) {
      const [deviceId] = params as [string];
      const found = this.roots
        .filter((item) => item.device_id === deviceId && item.state === "queued")
        .sort((a, b) => a.fifo_sequence - b.fifo_sequence)[0];
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_roots")) {
      const [deviceId, rootKind, externalId, requestKey, metadata] = params as [string, DeviceExecutionRootKind, string | null, string | null, string];
      const inserted = root({
        id: `root-${this.nextRoot++}`,
        device_id: deviceId,
        root_kind: rootKind,
        external_id: externalId,
        request_key: requestKey,
        fifo_sequence: this.nextRoot,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      this.roots.push(inserted);
      return { rows: [inserted], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_operations")) {
      const [
        rootId,
        deviceId,
        rootKind,
        operationKind,
        operationId,
        ownerGeneration,
        state,
        egressLane,
        wireType,
        wireHandle,
        metadata,
      ] = params as [string, string, DeviceExecutionRootKind, DeviceExecutionOperationKind, string, number, DeviceExecutionOperationState, "device_execution", string | null, string, string];
      const existing = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId);
      if (existing) {
        if (existing.root_id === rootId) {
          existing.owner_generation = Number(ownerGeneration);
          if (!["completed", "failed", "cancelled"].includes(existing.state)) existing.state = state;
          existing.egress_lane = egressLane;
          existing.wire_type = wireType ?? existing.wire_type;
          existing.wire_handle = JSON.parse(wireHandle) as Record<string, unknown>;
          existing.metadata = { ...existing.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
          existing.updated_at = new Date("2026-07-15T19:31:00.000Z");
          return { rows: [existing], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      const inserted = operation({
        id: this.nextOperation++,
        root_id: rootId,
        device_id: deviceId,
        root_kind: rootKind,
        operation_kind: operationKind,
        operation_id: operationId,
        owner_generation: Number(ownerGeneration),
        state,
        egress_lane: egressLane,
        wire_type: wireType,
        wire_handle: JSON.parse(wireHandle) as Record<string, unknown>,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      this.operations.push(inserted);
      return { rows: [inserted], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("terminal_reason = $2")) {
      const [toState, reason, metadata, rootId, deviceId, ownerGeneration] = params as [DeviceExecutionState, string, string, string, string, number];
      const found = this.roots.find((item) => item.id === rootId && item.device_id === deviceId && item.owner_generation === ownerGeneration && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.terminalReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("reconciliation_reason = $2")) {
      const [toState, reason, metadata, rootId, deviceId, ownerGeneration] = params as [DeviceExecutionState, string, string, string, string, number];
      const found = this.roots.find((item) => item.id === rootId && item.device_id === deviceId && item.owner_generation === ownerGeneration && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.reconciliationReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_operations")) {
      const [toState, ownerGeneration, metadata, operationKind, operationId, fromStates] = params as [
        DeviceExecutionOperationState,
        number | null,
        string,
        DeviceExecutionOperationKind,
        string,
        DeviceExecutionOperationState[],
      ];
      const found = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId && fromStates.includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      if (ownerGeneration !== null) found.owner_generation = ownerGeneration;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots")) {
      const [toState, increment, metadata, rootId, fromStates] = params as [DeviceExecutionState, number, string, string, DeviceExecutionState[]];
      const found = this.roots.find((item) => item.id === rootId && fromStates.includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.owner_generation += increment;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_events")) {
      const [rootId, deviceId, eventType, previousState, newState, actor, reason, metadata] = params as [
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
      ];
      this.events.push({
        root_id: rootId,
        device_id: deviceId,
        event_type: eventType,
        previous_state: previousState,
        new_state: newState,
        actor,
        reason,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("WITH candidates AS ( SELECT id, device_id, state AS previous_state FROM device_execution_roots WHERE state IN ('claimed', 'dispatching', 'dispatched')")) {
      const [reason, actor, metadata] = params as [string, string, string];
      const patch = JSON.parse(metadata) as Record<string, unknown>;
      const candidates = this.roots.filter((item) => ["claimed", "dispatching", "dispatched"].includes(item.state));
      for (const item of candidates) {
        const previous = item.state;
        item.state = "reconciling";
        item.metadata = { ...item.metadata, ...patch };
        item.metadata.reconciliationReason = reason;
        for (const op of this.operations.filter((entry) => entry.root_id === item.id && ["registered", "dispatching", "dispatched"].includes(entry.state))) {
          op.state = "reconciling";
          op.metadata = { ...op.metadata, ...patch };
        }
        this.events.push({
          root_id: item.id,
          device_id: item.device_id,
          event_type: "startup_reconciled_root",
          previous_state: previous,
          new_state: "reconciling",
          actor,
          reason,
          metadata: patch,
        });
      }
      return { rows: candidates.map((item) => ({ id: item.id })), rowCount: candidates.length };
    }

    if (normalized.startsWith("SELECT COUNT(*)::text AS count FROM device_execution_roots WHERE state IN ('reconciling', 'blocked')")) {
      const count = this.roots.filter((item) => ["reconciling", "blocked"].includes(item.state)).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in fake client: ${normalized}`);
  }

  release(): void {
    return undefined;
  }
}

function arbiterFor(client: FakeClient): DeviceExecutionArbiter {
  return new DeviceExecutionArbiter(() => ({
    connect: async () => client as any,
    query: client.query.bind(client) as any,
  }) as any);
}

describe("DeviceExecutionArbiter observe mode", () => {
  it("admits a root but reports that it would wait when the device already has an active root", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "active-root", external_id: "job-active", state: "dispatched" }));

    const result = await arbiterFor(client).observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-next",
      metadata: { jobType: "open_app" },
    });

    expect(result.decision).toBe("would_wait");
    expect(result.activeRootId).toBe("active-root");
    expect(client.roots.find((item) => item.external_id === "job-next")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["root_admitted", "observe_would_wait"]);
    expect(client.committed).toBe(true);
  });

  it("claims only the oldest queued root and leaves later roots queued", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "later", external_id: "job-later", fifo_sequence: 20 }),
      root({ id: "oldest", external_id: "job-oldest", fifo_sequence: 10 }),
    );

    const permit = await arbiterFor(client).claimNextRoot({ deviceId: DEVICE_A });

    expect(permit).toMatchObject({ rootId: "oldest", deviceId: DEVICE_A, ownerGeneration: 1, state: "claimed" });
    expect(client.roots.find((item) => item.id === "oldest")?.state).toBe("claimed");
    expect(client.roots.find((item) => item.id === "later")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["root_claimed"]);

    await expect(arbiterFor(client).claimNextRoot({ deviceId: DEVICE_A })).resolves.toBeNull();
  });

  it("records a would-block dispatch without advancing a second active root in observe mode", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "active-root", external_id: "job-active", state: "dispatched" }),
      root({ id: "queued-root", external_id: "job-next", state: "queued", fifo_sequence: 2 }),
    );

    const result = await arbiterFor(client).observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-next",
      sent: true,
      metadata: { jobType: "screenshot" },
    });

    expect(result.decision).toBe("would_wait");
    expect(client.roots.find((item) => item.id === "queued-root")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["observe_would_block_dispatch"]);
  });

  it("rejects wrong-device results and ignores duplicate terminal results", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-1", external_id: "job-1", state: "dispatched", device_id: DEVICE_A }));

    const wrongDevice = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_B,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(wrongDevice.decision).toBe("rejected");
    expect(client.roots[0].state).toBe("dispatched");

    const completed = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(completed.decision).toBe("terminal");
    expect(client.roots[0].state).toBe("completed");

    const duplicate = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "failed",
    });
    expect(duplicate.decision).toBe("rejected");
    expect(client.roots[0].state).toBe("completed");
    expect(client.events.map((event) => event.event_type)).toEqual([
      "result_rejected_wrong_device",
      "root_terminal",
      "duplicate_or_late_result",
    ]);
  });

  it("moves ambiguous non-terminal roots to blocked but leaves terminal roots untouched", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "root-1", external_id: "job-1", state: "dispatched", device_id: DEVICE_A }),
      root({ id: "root-2", external_id: "job-2", state: "completed", device_id: DEVICE_A }),
    );

    const blocked = await arbiterFor(client).markAmbiguous({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      reason: "job_timeout",
    });
    expect(blocked.decision).toBe("ambiguous");
    expect(client.roots.find((item) => item.id === "root-1")?.state).toBe("blocked");

    const ignored = await arbiterFor(client).markAmbiguous({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-2",
      reason: "late_timeout",
    });
    expect(ignored.decision).toBe("ignored");
    expect(client.roots.find((item) => item.id === "root-2")?.state).toBe("completed");
  });

  it("uses the operation ledger handle for terminal generation CAS", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-1", external_id: "job-1", state: "dispatched", owner_generation: 2 }));
    client.operations.push(operation({
      id: 10,
      root_id: "root-1",
      operation_id: "job-1",
      owner_generation: 2,
      state: "dispatched",
      wire_handle: encodeDeviceExecutionHandle({
        rootId: "root-1",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 2,
        operationKind: "job",
        operationId: "job-1",
      }) as unknown as Record<string, unknown>,
    }));

    const stale = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      ownerGeneration: 1,
      status: "completed",
    });
    expect(stale.decision).toBe("rejected");
    expect(stale.reason).toBe("owner_generation_mismatch");
    expect(client.roots[0].state).toBe("dispatched");

    const completed = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(completed.decision).toBe("terminal");
    expect(client.roots[0].state).toBe("completed");
    expect(client.operations[0].state).toBe("completed");
    expect(decodeDeviceExecutionHandle(completed.operation?.wireHandle)).toMatchObject({
      rootId: "root-1",
      ownerGeneration: 2,
      operationId: "job-1",
    });
  });

  it("runs the observed async egress path with dispatching before waiter and wire completion", async () => {
    const client = new FakeClient();
    const order: string[] = [];

    const result = await arbiterFor(client).runObservedEgress({
      deviceId: DEVICE_A,
      rootKind: "job",
      operationId: "job-egress",
      wireType: "JOB",
      registerWaiter: (handle) => {
        order.push(`waiter:${handle.ownerGeneration}`);
      },
      wireDispatch: (handle) => {
        order.push(`wire:${handle.ownerGeneration}`);
        return true;
      },
      metadata: { jobType: "screenshot" },
    });

    expect(result.decision).toBe("dispatched");
    expect(result.sent).toBe(true);
    expect(order).toEqual(["waiter:1", "wire:1"]);
    expect(client.roots[0]).toMatchObject({ external_id: "job-egress", state: "dispatched", owner_generation: 1 });
    expect(client.operations[0]).toMatchObject({ operation_id: "job-egress", state: "dispatched", owner_generation: 1 });
    expect(client.events.map((event) => event.event_type)).toEqual([
      "implicit_admission",
      "root_dispatching",
      "root_dispatched",
    ]);
  });

  it("fails closed by reconciling in-flight roots at startup", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "claimed-root", external_id: "job-claimed", state: "claimed", owner_generation: 1 }),
      root({ id: "dispatched-root", external_id: "job-dispatched", state: "dispatched", owner_generation: 2 }),
      root({ id: "queued-root", external_id: "job-queued", state: "queued" }),
    );
    client.operations.push(
      operation({ root_id: "claimed-root", operation_id: "job-claimed", owner_generation: 1, state: "dispatching" }),
      operation({ root_id: "dispatched-root", operation_id: "job-dispatched", owner_generation: 2, state: "dispatched" }),
    );

    const result = await arbiterFor(client).reconcileInFlightAtStartup();

    expect(result).toEqual({ reconciledRoots: 2, activeAmbiguousRoots: 2 });
    expect(client.roots.map((item) => [item.id, item.state])).toEqual([
      ["claimed-root", "reconciling"],
      ["dispatched-root", "reconciling"],
      ["queued-root", "queued"],
    ]);
    expect(client.operations.map((item) => item.state)).toEqual(["reconciling", "reconciling"]);
    expect(client.events.filter((event) => event.event_type === "startup_reconciled_root")).toHaveLength(2);
  });

  it("documents root boundary, control, and child policies without enabling enforcement", () => {
    expect(DEVICE_EXECUTION_BOUNDARY_MATRIX.standalone_job).toMatchObject({
      rootKind: "job",
      retainsRootUntilTerminal: true,
      mayBypassDeviceQueue: false,
    });
    expect(DEVICE_EXECUTION_BOUNDARY_MATRIX.generated_child).toMatchObject({
      requiresExistingRootHandle: true,
      egressLane: "device_execution",
    });
    expect(DEVICE_EXECUTION_BOUNDARY_MATRIX.control_egress).toMatchObject({
      rootKind: "control",
      egressLane: "control",
      mayBypassDeviceQueue: true,
    });
  });
});

describe("DeviceExecutionArbiter schema gate and migration", () => {
  it("fails closed when required schema pieces are missing", async () => {
    const goodPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          roots_table: true,
          events_table: true,
          operations_table: true,
          missing_columns: [],
          wrong_column_types: [],
          missing_constraints: [],
          missing_foreign_keys: [],
          missing_indexes: [],
          invalid_index_predicates: [],
        }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => goodPool as any).validateSchema()).resolves.toBeUndefined();

    const badPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          roots_table: true,
          events_table: false,
          operations_table: false,
          missing_columns: ["device_execution_events.event_type"],
          wrong_column_types: [],
          missing_constraints: ["device_execution_roots.device_execution_roots_state_check"],
          missing_foreign_keys: [],
          missing_indexes: ["idx_device_execution_active_slot"],
          invalid_index_predicates: [],
        }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => badPool as any).validateSchema()).rejects.toBeInstanceOf(DeviceExecutionSchemaError);
  });

  it("keeps the production migration idempotent and backed by an active-slot unique index plus event ledger", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "src/db/migrations/081_device_execution_queue.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_roots");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_events");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_operations");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("idx_device_execution_active_slot");
    expect(sql).toContain("WHERE state IN ('claimed', 'dispatching', 'dispatched', 'reconciling', 'blocked')");
    expect(sql).toContain("idx_device_execution_roots_fifo");
    expect(sql).toContain("idx_device_execution_operations_identity");
  });
});
