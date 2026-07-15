import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  DeviceExecutionArbiter,
  DeviceExecutionSchemaError,
  type DeviceExecutionRootKind,
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

class FakeClient {
  roots: RootRow[] = [];
  events: EventRow[] = [];
  committed = false;
  rolledBack = false;
  private nextRoot = 1;

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

    if (normalized.includes("WHERE device_id = $1 AND state IN ('claimed', 'dispatched', 'reconciling', 'blocked')")) {
      const [deviceId] = params as [string];
      const found = this.roots.find((item) => item.device_id === deviceId && ["claimed", "dispatched", "reconciling", "blocked"].includes(item.state));
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

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("terminal_reason = $2")) {
      const [toState, reason, metadata, rootId] = params as [DeviceExecutionState, string, string, string];
      const found = this.roots.find((item) => item.id === rootId && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.terminalReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("reconciliation_reason = $2")) {
      const [toState, reason, metadata, rootId] = params as [DeviceExecutionState, string, string, string];
      const found = this.roots.find((item) => item.id === rootId && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.reconciliationReason = reason;
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
    expect(duplicate.decision).toBe("ignored");
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
});

describe("DeviceExecutionArbiter schema gate and migration", () => {
  it("fails closed when required schema pieces are missing", async () => {
    const goodPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ roots_table: true, events_table: true, active_index: true, fifo_index: true, missing_columns: [] }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => goodPool as any).validateSchema()).resolves.toBeUndefined();

    const badPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ roots_table: true, events_table: false, active_index: false, fifo_index: true, missing_columns: ["device_execution_events.event_type"] }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => badPool as any).validateSchema()).rejects.toBeInstanceOf(DeviceExecutionSchemaError);
  });

  it("keeps the production migration idempotent and backed by an active-slot unique index plus event ledger", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "src/db/migrations/081_device_execution_queue.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_roots");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_events");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("idx_device_execution_active_slot");
    expect(sql).toContain("WHERE state IN ('claimed', 'dispatched', 'reconciling', 'blocked')");
    expect(sql).toContain("idx_device_execution_roots_fifo");
  });
});
