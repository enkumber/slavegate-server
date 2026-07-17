import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const migrationPath = path.join(repoRoot, "src/db/migrations/082_pnq_queue_v2_contract.sql");
const rollbackPath = path.join(repoRoot, "src/db/rollbacks/082_pnq_queue_v2_contract.rollback.sql");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let schema = "";

const NODE_A = "10000000-0000-4000-8000-0000000000a1";
const NODE_B = "10000000-0000-4000-8000-0000000000b2";

describe("PNQ-003 Queue v2 PostgreSQL contract", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `pnq003_queue_v2_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 8,
      options: `-c search_path=${schema}`,
    });
    await pool.query(fs.readFileSync(migrationPath, "utf8"));
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE pnq_resolution_audit, pnq_jobs, pnq_nodes RESTART IDENTITY CASCADE");
    await registerNode(NODE_A, "node-a");
    await registerNode(NODE_B, "node-b");
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("allocates node_seq monotonically and preserves FIFO per node", async () => {
    const jobs = await Promise.all(
      Array.from({ length: 25 }, (_, index) => enqueue(NODE_A, `fifo-${index}`, { index })),
    );

    expect(new Set(jobs.map((job) => Number(job.node_seq))).size).toBe(25);

    const rows = await pool.query<{ request_key: string; node_seq: string }>(
      `SELECT request_key, node_seq
       FROM pnq_jobs
       WHERE node_id = $1
       ORDER BY node_seq ASC`,
      [NODE_A],
    );
    expect(rows.rows.map((row) => Number(row.node_seq))).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(rows.rows.map((row) => row.request_key)).toEqual(
      rows.rows
        .slice()
        .sort((a, b) => Number(a.node_seq) - Number(b.node_seq))
        .map((row) => row.request_key),
    );

    const node = await pool.query<{ next_node_seq: string }>(
      "SELECT next_node_seq FROM pnq_nodes WHERE id = $1",
      [NODE_A],
    );
    expect(Number(node.rows[0]!.next_node_seq)).toBe(26);
  });

  it("permits enqueue progress for different nodes while one node row is locked", async () => {
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT * FROM pnq_nodes WHERE id = $1 FOR UPDATE", [NODE_A]);

      const started = Date.now();
      const jobB = await enqueue(NODE_B, "parallel-b", { node: "b" });
      expect(jobB.node_id).toBe(NODE_B);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("allows only one active claim per node and preserves the FIFO head under concurrency", async () => {
    const first = await enqueue(NODE_A, "claim-first", { order: 1 });
    await enqueue(NODE_A, "claim-second", { order: 2 });

    const [left, right] = await Promise.all([
      claimNextJob(NODE_A, "21000000-0000-4000-8000-000000000001"),
      claimNextJob(NODE_A, "21000000-0000-4000-8000-000000000002"),
    ]);

    const claimed = [left, right].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: first.id, node_seq: "1", status: "DISPATCHING" });

    const active = await pool.query(
      "SELECT id FROM pnq_jobs WHERE node_id = $1 AND status IN ('DISPATCHING', 'RUNNING')",
      [NODE_A],
    );
    expect(active.rows).toHaveLength(1);
  });

  it("permits independent claims on different nodes", async () => {
    const firstA = await enqueue(NODE_A, "claim-a", { node: "a" });
    const firstB = await enqueue(NODE_B, "claim-b", { node: "b" });

    const [claimedA, claimedB] = await Promise.all([
      claimNextJob(NODE_A, "22000000-0000-4000-8000-000000000001"),
      claimNextJob(NODE_B, "22000000-0000-4000-8000-000000000002"),
    ]);

    expect(claimedA).toMatchObject({ id: firstA.id, status: "DISPATCHING" });
    expect(claimedB).toMatchObject({ id: firstB.id, status: "DISPATCHING" });
  });

  it("enforces request_key idempotency per node and rejects payload conflicts", async () => {
    const first = await enqueue(NODE_A, "idem", { value: 1 });
    const replay = await enqueue(NODE_A, "idem", { value: 1 });
    const sameKeyOtherNode = await enqueue(NODE_B, "idem", { value: 1 });

    expect(replay.id).toBe(first.id);
    expect(sameKeyOtherNode.id).not.toBe(first.id);

    const conflict = await enqueue(NODE_A, "idem", { value: 2 });
    expect(conflict.id).toBe(first.id);
    expect(await auditCount("payload_conflict")).toBe(1);
    expect(await auditCount("enqueue_idempotent_replay")).toBe(1);
  });

  it("requires a unique non-null execution_id when a job enters execution", async () => {
    const first = await enqueue(NODE_A, "exec-a", { value: "a" });
    const second = await enqueue(NODE_A, "exec-b", { value: "b" });
    const executionId = "20000000-0000-4000-8000-000000000001";

    const claimed = await claimNextJob(NODE_A, executionId);
    expect(claimed).toMatchObject({ id: first.id, status: "DISPATCHING", execution_id: executionId });
    const executing = await startExecution(
      first.id,
      executionId,
      0,
      Number(claimed.job_version),
      Number(claimed.dispatch_generation),
    );
    expect(executing).toMatchObject({
      status: "RUNNING",
      execution_id: executionId,
      job_version: "3",
      dispatch_generation: "1",
    });

    await expect(
      pool.query(
        `UPDATE pnq_jobs
         SET status = 'DISPATCHING',
             execution_id = $1
         WHERE id = $2`,
        [executionId, second.id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE pnq_jobs
         SET status = 'RUNNING'
         WHERE id = $1`,
        [second.id],
      ),
    ).rejects.toThrow(/pnq_jobs_execution_id_required_check/);
  });

  it("rejects stale connection_epoch before execution ownership changes", async () => {
    const job = await enqueue(NODE_A, "stale-epoch", { value: "epoch" });
    await pool.query("SELECT pnq_bump_connection_epoch($1, $2)", [NODE_A, 0]);

    const stale = await claimNextJob(NODE_A, "20000000-0000-4000-8000-000000000002", 0);
    expect(stale).toBeUndefined();

    const current = await jobById(job.id);
    expect(current.status).toBe("PENDING");
    expect(await auditCount("epoch_rejected")).toBe(1);
  });

  it("keeps a stale epoch bump non-mutating and persists rejection evidence", async () => {
    await pool.query("SELECT pnq_bump_connection_epoch($1, $2)", [NODE_A, 0]);
    const stale = await pool.query("SELECT * FROM pnq_bump_connection_epoch($1, $2)", [NODE_A, 0]);

    expect(stale.rows[0]?.connection_epoch).toBe("1");
    expect(await auditCount("epoch_rejected")).toBe(1);
  });

  it("uses job_version plus dispatch_generation CAS so only one dispatcher wins", async () => {
    const job = await enqueue(NODE_A, "cas", { value: "cas" });
    const executionId = "20000000-0000-4000-8000-000000000003";
    const claimed = await claimNextJob(NODE_A, executionId);
    const attempts = await Promise.allSettled([
      startExecution(job.id, executionId, 0, Number(claimed.job_version), Number(claimed.dispatch_generation)),
      startExecution(job.id, executionId, 0, Number(claimed.job_version), Number(claimed.dispatch_generation)),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(2);
    const current = await jobById(job.id);
    expect(current.status).toBe("RUNNING");
    expect(Number(current.dispatch_generation)).toBe(1);
    expect(await auditCount("cas_lost")).toBe(1);
  });

  it("keeps queue, dispatch, execution, and result deadlines distinct and coherent", async () => {
    await expect(
      enqueueWithDeadlines(NODE_A, "bad-deadline", { value: "bad" }, {
        queue: "2026-07-17T10:00:00.000Z",
        dispatch: "2026-07-17T10:00:00.000Z",
        execution: "2026-07-17T10:02:00.000Z",
        result: "2026-07-17T10:03:00.000Z",
      }),
    ).rejects.toThrow(/pnq_jobs_deadline_order_check/);

    const job = await enqueue(NODE_A, "good-deadline", { value: "good" });
    expect(job.queue_deadline_at).not.toEqual(job.dispatch_deadline_at);
    expect(job.dispatch_deadline_at).not.toEqual(job.execution_deadline_at);
    expect(job.execution_deadline_at).not.toEqual(job.result_deadline_at);
  });

  it("exposes crash/restart recovery rows and terminalizes ambiguous state as STUCK", async () => {
    const job = await enqueue(NODE_A, "recovery", { value: "recover" });
    const executing = await claimAndStart(job, "20000000-0000-4000-8000-000000000005");

    const recoveryRows = await pool.query<{ id: string }>(
      `SELECT id
       FROM pnq_jobs
       WHERE status IN ('DISPATCHING', 'RUNNING')
         AND result_deadline_at <= $1
       ORDER BY updated_at`,
      ["2026-07-17T10:05:00.000Z"],
    );
    expect(recoveryRows.rows.map((row) => row.id)).toContain(executing.id);

    const stuck = await markStuck(job.id, "restart ambiguity");
    expect(stuck.status).toBe("STUCK");
    expect(stuck.terminal_at).not.toBeNull();
    expect(await auditCount("marked_stuck")).toBe(1);
  });

  it("does not let stale or late results terminalize the current job and writes audit", async () => {
    const job = await enqueue(NODE_A, "stale-result", { value: "result" });
    const executing = await claimAndStart(job, "20000000-0000-4000-8000-000000000006");

    const stale = await recordResult(job.id, "20000000-0000-4000-8000-000000000099", 1, true);
    expect(stale.status).toBe("RUNNING");
    expect((await jobById(job.id)).status).toBe("RUNNING");
    expect(await auditCount("stale_result")).toBe(1);

    const terminal = await recordResult(job.id, executing.execution_id, Number(executing.dispatch_generation), true);
    expect(terminal.status).toBe("DONE");

    const late = await recordResult(job.id, executing.execution_id, Number(executing.dispatch_generation), false);
    expect(late.status).toBe("DONE");
    expect(await auditCount("late_result")).toBe(1);
  });

  it("is fail-closed for inconsistent resolution and keeps audit append-only", async () => {
    const job = await enqueue(NODE_A, "stuck", { value: "ambiguous" });
    const stuck = await markStuck(job.id, "conflicting terminal evidence");
    expect(stuck.status).toBe("STUCK");

    await pool.query(
      `INSERT INTO pnq_resolution_audit (job_id, node_id, event_type, decision, evidence)
       VALUES ($1, $2, 'explicit_resolution', 'resolved', '{}'::jsonb)`,
      [job.id, NODE_A],
    );
    await expect(
      pool.query("UPDATE pnq_resolution_audit SET decision = 'ignored' WHERE job_id = $1", [job.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM pnq_resolution_audit WHERE job_id = $1", [job.id]),
    ).rejects.toThrow(/append-only/);
  });

  it("has a verifiable rollback SQL boundary", async () => {
    const rollbackSchema = `${schema}_rollback`;
    await adminPool.query(`CREATE SCHEMA "${rollbackSchema}"`);
    const rollbackPool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      options: `-c search_path=${rollbackSchema}`,
    });
    try {
      await rollbackPool.query(fs.readFileSync(migrationPath, "utf8"));
      await rollbackPool.query(fs.readFileSync(rollbackPath, "utf8"));
      const remaining = await rollbackPool.query<{ relname: string }>(
        `SELECT relname
         FROM pg_class
         WHERE relnamespace = $1::regnamespace
           AND relname IN ('pnq_nodes', 'pnq_jobs', 'pnq_resolution_audit')`,
        [rollbackSchema],
      );
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await rollbackPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${rollbackSchema}" CASCADE`);
    }
  });
});

async function registerNode(nodeId: string, nodeKey: string) {
  const result = await pool.query("SELECT * FROM pnq_register_node($1, $2)", [nodeId, nodeKey]);
  return result.rows[0];
}

async function enqueue(nodeId: string, requestKey: string, payload: Record<string, unknown>) {
  return enqueueWithDeadlines(nodeId, requestKey, payload, {
    queue: "2026-07-17T10:00:00.000Z",
    dispatch: "2026-07-17T10:01:00.000Z",
    execution: "2026-07-17T10:02:00.000Z",
    result: "2026-07-17T10:03:00.000Z",
  });
}

async function enqueueWithDeadlines(
  nodeId: string,
  requestKey: string,
  payload: Record<string, unknown>,
  deadlines: { queue: string; dispatch: string; execution: string; result: string },
) {
  const result = await pool.query(
    `SELECT * FROM pnq_enqueue_job($1, $2, $3::jsonb, $4, $5, $6, $7)`,
    [
      nodeId,
      requestKey,
      JSON.stringify(payload),
      deadlines.queue,
      deadlines.dispatch,
      deadlines.execution,
      deadlines.result,
    ],
  );
  return result.rows[0];
}

async function startExecution(
  jobId: string,
  executionId: string,
  epoch = 0,
  jobVersion = 1,
  dispatchGeneration = 0,
) {
  const result = await pool.query(
    `SELECT * FROM pnq_start_execution($1, $2, $3, $4, $5)`,
    [jobId, epoch, jobVersion, dispatchGeneration, executionId],
  );
  return result.rows[0];
}

async function claimNextJob(nodeId: string, executionId: string, epoch = 0) {
  const result = await pool.query(
    `SELECT * FROM pnq_claim_next_job($1, $2, $3)`,
    [nodeId, epoch, executionId],
  );
  return result.rows[0]?.id ? result.rows[0] : undefined;
}

async function claimAndStart(job: { id: string; node_id: string }, executionId: string, epoch = 0) {
  const claimed = await claimNextJob(job.node_id, executionId, epoch);
  expect(claimed?.id).toBe(job.id);
  return startExecution(
    job.id,
    executionId,
    epoch,
    Number(claimed.job_version),
    Number(claimed.dispatch_generation),
  );
}

async function recordResult(
  jobId: string,
  executionId: string,
  dispatchGeneration: number,
  success: boolean,
) {
  const result = await pool.query(
    `SELECT * FROM pnq_record_result($1, $2, $3, $4, '{"ok": true}'::jsonb)`,
    [jobId, executionId, dispatchGeneration, success],
  );
  return result.rows[0];
}

async function markStuck(jobId: string, reason: string) {
  const result = await pool.query(
    `SELECT * FROM pnq_mark_stuck($1, $2, '{"source": "test"}'::jsonb)`,
    [jobId, reason],
  );
  return result.rows[0];
}

async function jobById(jobId: string) {
  const result = await pool.query("SELECT * FROM pnq_jobs WHERE id = $1", [jobId]);
  return result.rows[0];
}

async function auditCount(eventType: string) {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::int AS count FROM pnq_resolution_audit WHERE event_type = $1",
    [eventType],
  );
  return Number(result.rows[0]!.count);
}

function assertSafeTestDatabase(url: string): void {
  if (!/127\.0\.0\.1|localhost/.test(url) || !/(test|pnq)/i.test(url)) {
    throw new Error(`Refusing to run PNQ-003 PostgreSQL tests against unsafe database URL: ${url}`);
  }
}

async function assertRealPostgres(pgPool: Pool): Promise<void> {
  const version = await pgPool.query<{ version: string }>("SELECT version()");
  expect(version.rows[0]?.version).toContain("PostgreSQL");
}
