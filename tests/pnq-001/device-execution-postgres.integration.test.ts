import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DeviceExecutionArbiter,
  DeviceExecutionSchemaError,
  type DeviceExecutionState,
} from "../../src/modules/device-execution/device-execution-arbiter";

const repoRoot = path.resolve(__dirname, "../..");
const migrationPath = path.join(repoRoot, "src/db/migrations/081_device_execution_queue.sql");
const postgresUrl = process.env.PNQ001_PG_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

const DEVICE_A = "00000000-0000-4000-8000-0000000000a1";
const DEVICE_B = "00000000-0000-4000-8000-0000000000b2";
const ACTIVE_STATES = ["claimed", "dispatching", "dispatched", "reconciling", "blocked"] as const;

let pool: Pool;
let arbiter: DeviceExecutionArbiter;

describePostgres("PNQ-001 device execution arbiter with real PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl!);
    pool = new Pool({ connectionString: postgresUrl, max: 8 });
    await assertRealPostgres(pool);
    arbiter = new DeviceExecutionArbiter(() => pool);
  });

  beforeEach(async () => {
    await resetPnqSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("admits and drains 100 roots in stable FIFO order with at most one active root", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-fifo-a");
    const externalIds = Array.from({ length: 100 }, (_, index) => `fifo-job-${String(index + 1).padStart(3, "0")}`);

    for (const externalId of externalIds) {
      const admitted = await arbiter.observeAdmission({
        deviceId: DEVICE_A,
        rootKind: "job",
        externalId,
        requestKey: externalId,
        actor: "pnq-test",
      });
      expect(admitted.decision).toBe("admitted");
    }

    expect(await rootExternalIdsByFifo(pool, DEVICE_A)).toEqual(externalIds);

    for (const externalId of externalIds) {
      const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" });
      expect(permit).not.toBeNull();
      expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
      expect(await externalIdForRoot(pool, permit!.rootId)).toBe(externalId);

      const dispatch = await arbiter.observeDispatch({
        deviceId: DEVICE_A,
        rootKind: "job",
        externalId,
        sent: true,
        actor: "transport-test",
      });
      expect(dispatch.decision).toBe("dispatched");
      expect(await activeRootCount(pool, DEVICE_A)).toBe(1);

      const terminal = await arbiter.observeTerminal({
        deviceId: DEVICE_A,
        rootId: permit!.rootId,
        status: "completed",
        actor: "device-test",
      });
      expect(terminal.decision).toBe("terminal");
      expect(await activeRootCount(pool, DEVICE_A)).toBe(0);
    }

    expect(await stateCount(pool, "completed")).toBe(100);
  });

  it("allows separate devices to hold active roots concurrently", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-parallel-a");
    await insertDevice(pool, DEVICE_B, "pnq-parallel-b");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "parallel-a" });
    await arbiter.observeAdmission({ deviceId: DEVICE_B, rootKind: "job", externalId: "parallel-b" });

    const [permitA, permitB] = await Promise.all([
      arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" }),
      arbiter.claimNextRoot({ deviceId: DEVICE_B, actor: "worker-b" }),
    ]);

    expect(permitA).toMatchObject({ deviceId: DEVICE_A, state: "claimed" });
    expect(permitB).toMatchObject({ deviceId: DEVICE_B, state: "claimed" });
    expect(await activeRootCount(pool)).toBe(2);
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
    expect(await activeRootCount(pool, DEVICE_B)).toBe(1);
  });

  it("serializes two workers racing to claim one device root", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-race-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "race-job" });

    const workerOne = new DeviceExecutionArbiter(() => pool);
    const workerTwo = new DeviceExecutionArbiter(() => pool);
    const results = await Promise.all([
      workerOne.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-one" }),
      workerTwo.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-two" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
    expect(await eventCount(pool, "root_claimed")).toBe(1);
  });

  it("keeps a queued successor blocked across a crash/restart ambiguity", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-restart-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "ambiguous-root" });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "successor-root" });

    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-before-restart" });
    expect(permit).not.toBeNull();
    await arbiter.observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "ambiguous-root",
      sent: true,
      actor: "transport-before-restart",
    });

    const ambiguous = await arbiter.markAmbiguous({
      deviceId: DEVICE_A,
      rootId: permit!.rootId,
      reason: "restart_after_possible_wire_send",
      state: "reconciling",
      actor: "startup-reconciler-test",
    });
    expect(ambiguous.decision).toBe("ambiguous");

    const restartedArbiter = new DeviceExecutionArbiter(() => pool);
    await expect(restartedArbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-after-restart" })).resolves.toBeNull();
    expect(await stateForExternalId(pool, "ambiguous-root")).toBe("reconciling");
    expect(await stateForExternalId(pool, "successor-root")).toBe("queued");
    expect(await eventCount(pool, "root_ambiguous")).toBe(1);
  });

  it("audits wrong-device and duplicate terminal CAS rejections", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-terminal-a");
    await insertDevice(pool, DEVICE_B, "pnq-terminal-b");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "terminal-job" });
    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" });
    expect(permit).not.toBeNull();
    await arbiter.observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      sent: true,
      actor: "transport-test",
    });

    const wrongDevice = await arbiter.observeTerminal({
      deviceId: DEVICE_B,
      rootKind: "job",
      externalId: "terminal-job",
      status: "completed",
      actor: "device-b",
    });
    expect(wrongDevice).toMatchObject({ decision: "rejected", reason: "root_owned_by_different_device" });
    expect(await stateForExternalId(pool, "terminal-job")).toBe("dispatched");

    const completed = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      status: "completed",
      actor: "device-a",
    });
    expect(completed.decision).toBe("terminal");

    const duplicate = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      status: "failed",
      actor: "device-a-late",
    });
    expect(["ignored", "rejected"]).toContain(duplicate.decision);
    expect(duplicate.reason).toBe("root_already_terminal");
    expect(await stateForExternalId(pool, "terminal-job")).toBe("completed");
    expect(await eventCount(pool, "result_rejected_wrong_device")).toBe(1);
    expect(await eventCount(pool, "duplicate_or_late_result")).toBe(1);
  });

  it("materializes the schema contract needed by PNQ queue authority", async () => {
    await expect(arbiter.validateSchema()).resolves.toBeUndefined();

    const rootColumns = await columnsFor(pool, "device_execution_roots");
    expect(rootColumns.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(rootColumns.get("device_id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(rootColumns.get("root_kind")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(rootColumns.get("state")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(rootColumns.get("fifo_sequence")).toMatchObject({ data_type: "bigint", is_nullable: "NO", is_identity: "YES" });
    expect(rootColumns.get("owner_generation")).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
    expect(rootColumns.get("metadata")).toMatchObject({ data_type: "jsonb", is_nullable: "NO" });

    const eventColumns = await columnsFor(pool, "device_execution_events");
    expect(eventColumns.get("id")).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
    expect(eventColumns.get("root_id")).toMatchObject({ data_type: "uuid" });
    expect(eventColumns.get("device_id")).toMatchObject({ data_type: "uuid" });
    expect(eventColumns.get("event_type")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(eventColumns.get("metadata")).toMatchObject({ data_type: "jsonb", is_nullable: "NO" });

    const rootConstraints = await constraintsFor(pool, "device_execution_roots");
    expect(rootConstraints.some((constraint) => constraint.contype === "p")).toBe(true);
    expect(rootConstraints.some((constraint) => constraint.contype === "f" && constraint.definition.includes("REFERENCES devices(id)"))).toBe(true);
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_root_kind_check")?.definition).toContain("server_workflow");
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_state_check")?.definition).toContain("reconciling");
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_owner_generation_check")?.definition).toContain("owner_generation >= 0");

    const eventConstraints = await constraintsFor(pool, "device_execution_events");
    expect(eventConstraints.filter((constraint) => constraint.contype === "f")).toHaveLength(2);
    expect(eventConstraints.some((constraint) => constraint.definition.includes("REFERENCES device_execution_roots(id)"))).toBe(true);
    expect(eventConstraints.some((constraint) => constraint.definition.includes("REFERENCES devices(id)"))).toBe(true);

    const indexes = await indexesFor(pool);
    const activeSlot = indexes.get("idx_device_execution_active_slot");
    expect(activeSlot).toMatchObject({ indisunique: true });
    expect(activeSlot?.predicate).toContain("claimed");
    expect(activeSlot?.predicate).toContain("dispatched");
    expect(activeSlot?.predicate).toContain("reconciling");
    expect(activeSlot?.predicate).toContain("blocked");
    expect(activeSlot?.predicate).not.toContain("queued");

    const fifoIndex = indexes.get("idx_device_execution_roots_fifo");
    expect(fifoIndex?.predicate).toContain("queued");
    expect(indexes.get("idx_device_execution_roots_external")).toMatchObject({ indisunique: true });
    expect(indexes.has("idx_device_execution_events_root")).toBe(true);
    expect(indexes.has("idx_device_execution_events_device")).toBe(true);
    expect(indexes.has("idx_device_execution_events_type")).toBe(true);
  });

  it("fails closed when a required schema index is missing", async () => {
    await pool.query("DROP INDEX idx_device_execution_roots_fifo");

    await expect(arbiter.validateSchema()).rejects.toBeInstanceOf(DeviceExecutionSchemaError);
  });
});

function assertSafeTestDatabase(rawUrl: string): void {
  if (rawUrl === process.env.DATABASE_URL) {
    throw new Error("PNQ001_PG_URL must not be the production DATABASE_URL");
  }

  const parsed = new URL(rawUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(pnq.*test|test.*pnq|pnq001|pnq_001|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to reset PostgreSQL database "${dbName}". Use a disposable PNQ/test database.`);
  }
}

async function assertRealPostgres(db: Pool): Promise<void> {
  const result = await db.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toContain("PostgreSQL");
}

async function resetPnqSchema(db: Pool): Promise<void> {
  await db.query(`
    DROP TABLE IF EXISTS device_execution_events CASCADE;
    DROP TABLE IF EXISTS device_execution_operations CASCADE;
    DROP TABLE IF EXISTS device_execution_roots CASCADE;
    DROP TABLE IF EXISTS devices CASCADE;
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      friendly_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'online'
    );
  `);
  await db.query(fs.readFileSync(migrationPath, "utf8"));
}

async function insertDevice(db: Pool, deviceId: string, friendlyName: string): Promise<void> {
  await db.query(
    "INSERT INTO devices (id, friendly_name, status) VALUES ($1, $2, 'online')",
    [deviceId, friendlyName],
  );
}

async function rootExternalIdsByFifo(db: Pool, deviceId: string): Promise<string[]> {
  const result = await db.query<{ external_id: string }>(
    `SELECT external_id
     FROM device_execution_roots
     WHERE device_id = $1
     ORDER BY fifo_sequence ASC`,
    [deviceId],
  );
  return result.rows.map((row) => row.external_id);
}

async function externalIdForRoot(db: Pool, rootId: string): Promise<string | null> {
  const result = await db.query<{ external_id: string | null }>(
    "SELECT external_id FROM device_execution_roots WHERE id = $1",
    [rootId],
  );
  return result.rows[0]?.external_id ?? null;
}

async function stateForExternalId(db: Pool, externalId: string): Promise<DeviceExecutionState | null> {
  const result = await db.query<{ state: DeviceExecutionState }>(
    "SELECT state FROM device_execution_roots WHERE external_id = $1",
    [externalId],
  );
  return result.rows[0]?.state ?? null;
}

async function activeRootCount(db: Pool, deviceId?: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM device_execution_roots
     WHERE state = ANY($1::text[])
       AND ($2::uuid IS NULL OR device_id = $2::uuid)`,
    [ACTIVE_STATES, deviceId ?? null],
  );
  return result.rows[0]?.count ?? 0;
}

async function stateCount(db: Pool, state: DeviceExecutionState): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM device_execution_roots WHERE state = $1",
    [state],
  );
  return result.rows[0]?.count ?? 0;
}

async function eventCount(db: Pool, eventType: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM device_execution_events WHERE event_type = $1",
    [eventType],
  );
  return result.rows[0]?.count ?? 0;
}

async function columnsFor(db: Pool, tableName: string): Promise<Map<string, ColumnRow>> {
  const result = await db.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable, column_default, is_identity
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

async function constraintsFor(db: Pool, tableName: string): Promise<ConstraintRow[]> {
  const result = await db.query<ConstraintRow>(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = $1::regclass
     ORDER BY conname`,
    [tableName],
  );
  return result.rows;
}

async function indexesFor(db: Pool): Promise<Map<string, IndexRow>> {
  const result = await db.query<IndexRow>(
    `SELECT
       index_class.relname AS index_name,
       pg_index.indisunique,
       pg_get_expr(pg_index.indpred, pg_index.indrelid) AS predicate,
       pg_get_indexdef(pg_index.indexrelid) AS definition
     FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
     JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
     WHERE table_class.relname IN ('device_execution_roots', 'device_execution_events')
     ORDER BY index_class.relname`,
  );
  return new Map(result.rows.map((row) => [row.index_name, row]));
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
}

interface ConstraintRow {
  conname: string;
  contype: string;
  definition: string;
}

interface IndexRow {
  index_name: string;
  indisunique: boolean;
  predicate: string | null;
  definition: string;
}
