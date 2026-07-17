import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PnqV2RuntimeRepository } from "../../src/modules/device-execution/pnq-v2-runtime.repository";

const repoRoot = path.resolve(__dirname, "../..");
const migration082Path = path.join(repoRoot, "src/db/migrations/082_pnq_queue_v2_contract.sql");
const migration083Path = path.join(repoRoot, "src/db/migrations/083_pnq_v2_runtime_shadow.sql");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const NODE_A = "30000000-0000-4000-8000-0000000000a1";
const NODE_B = "30000000-0000-4000-8000-0000000000b2";

let adminPool: Pool;
let pool: Pool;
let schema = "";
let repo: PnqV2RuntimeRepository;

describe("PNQ-003 Queue v2 shadow runtime PostgreSQL integration", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `pnq003_queue_v2_runtime_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 8,
      options: `-c search_path=${schema}`,
    });
    await pool.query(fs.readFileSync(migration082Path, "utf8"));
    await pool.query(fs.readFileSync(migration083Path, "utf8"));
    repo = new PnqV2RuntimeRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE pnq_legacy_job_map, pnq_resolution_audit, pnq_jobs, pnq_nodes RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("persists an idempotent legacy-to-pnq mapping and same-node FIFO identity", async () => {
    const first = await repo.enqueueMappedJob({
      legacyJobId: "legacy-a",
      nodeId: NODE_A,
      payload: { type: "screenshot" },
      timeoutMs: 10_000,
    });
    const replay = await repo.enqueueMappedJob({
      legacyJobId: "legacy-a",
      nodeId: NODE_A,
      payload: { type: "screenshot" },
      timeoutMs: 10_000,
    });
    await repo.enqueueMappedJob({
      legacyJobId: "legacy-b",
      nodeId: NODE_A,
      payload: { type: "tap" },
      timeoutMs: 10_000,
    });

    expect(replay).toEqual(first);

    const rows = await pool.query<{ legacy_job_id: string; pnq_job_id: string; node_seq: string }>(
      `SELECT m.legacy_job_id, m.pnq_job_id, j.node_seq
       FROM pnq_legacy_job_map m
       JOIN pnq_jobs j ON j.id = m.pnq_job_id
       ORDER BY j.node_seq`,
    );
    expect(rows.rows).toMatchObject([
      { legacy_job_id: "legacy-a", node_seq: "1" },
      { legacy_job_id: "legacy-b", node_seq: "2" },
    ]);
    expect(new Set(rows.rows.map((row) => row.pnq_job_id)).size).toBe(2);
  });

  it("claims independent nodes concurrently while preserving one active job per node", async () => {
    await repo.enqueueMappedJob({ legacyJobId: "legacy-a", nodeId: NODE_A, payload: { n: "a" }, timeoutMs: 10_000 });
    await repo.enqueueMappedJob({ legacyJobId: "legacy-b", nodeId: NODE_B, payload: { n: "b" }, timeoutMs: 10_000 });

    const [a, b] = await Promise.all([
      repo.claimAndStart("legacy-a", 0, "31000000-0000-4000-8000-0000000000a1"),
      repo.claimAndStart("legacy-b", 0, "31000000-0000-4000-8000-0000000000b2"),
    ]);

    expect(a).toMatchObject({ legacyJobId: "legacy-a", attemptExecutionId: "31000000-0000-4000-8000-0000000000a1" });
    expect(b).toMatchObject({ legacyJobId: "legacy-b", attemptExecutionId: "31000000-0000-4000-8000-0000000000b2" });

    const active = await pool.query<{ node_id: string; count: string }>(
      `SELECT node_id, COUNT(*)::int AS count
       FROM pnq_jobs
       WHERE status = 'RUNNING'
       GROUP BY node_id
       ORDER BY node_id`,
    );
    expect(active.rows).toEqual([
      { node_id: NODE_A, count: 1 },
      { node_id: NODE_B, count: 1 },
    ]);
  });

  it("marks only expired active crash windows STUCK and never replays unexpired work", async () => {
    await repo.enqueueMappedJob({ legacyJobId: "expired", nodeId: NODE_A, payload: { n: "expired" }, timeoutMs: 10_000 });
    await repo.claimAndStart("expired", 0, "32000000-0000-4000-8000-0000000000a1");
    await repo.enqueueMappedJob({ legacyJobId: "fresh", nodeId: NODE_B, payload: { n: "fresh" }, timeoutMs: 10_000 });
    await repo.claimAndStart("fresh", 0, "32000000-0000-4000-8000-0000000000b2");

    const now = new Date("2026-07-17T12:00:00.000Z");
    await pool.query(
      `UPDATE pnq_jobs
       SET queue_deadline_at = CASE node_id WHEN $1 THEN $3::timestamptz ELSE $7::timestamptz END,
           dispatch_deadline_at = CASE node_id WHEN $1 THEN $4::timestamptz ELSE $8::timestamptz END,
           execution_deadline_at = CASE node_id WHEN $1 THEN $5::timestamptz ELSE $9::timestamptz END,
           result_deadline_at = CASE node_id WHEN $1 THEN $6::timestamptz ELSE $10::timestamptz END
       WHERE node_id IN ($1, $2)`,
      [
        NODE_A,
        NODE_B,
        new Date(now.getTime() - 4_000),
        new Date(now.getTime() - 3_000),
        new Date(now.getTime() - 2_000),
        new Date(now.getTime() - 1_000),
        new Date(now.getTime() + 10_000),
        new Date(now.getTime() + 20_000),
        new Date(now.getTime() + 30_000),
        new Date(now.getTime() + 40_000),
      ],
    );

    await expect(repo.markExpiredActiveStuck("phase3_test_deadline", now)).resolves.toBe(1);

    const jobs = await pool.query<{ request_key: string; status: string }>(
      "SELECT request_key, status FROM pnq_jobs ORDER BY request_key",
    );
    expect(jobs.rows).toEqual([
      { request_key: "expired", status: "STUCK" },
      { request_key: "fresh", status: "RUNNING" },
    ]);

    const audit = await pool.query<{ event_type: string; evidence: Record<string, unknown> }>(
      `SELECT event_type, evidence
       FROM pnq_resolution_audit
       WHERE event_type = 'marked_stuck'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.evidence).toMatchObject({
      reason: "phase3_test_deadline",
      observedStatus: "RUNNING",
      observedDispatchGeneration: 1,
    });
  });

  it("records results only for the socket-bound epoch and audits stale epoch attempts", async () => {
    await repo.enqueueMappedJob({
      legacyJobId: "current-result",
      nodeId: NODE_A,
      payload: { n: "current" },
      timeoutMs: 10_000,
    });
    await repo.claimAndStart("current-result", 0, "33000000-0000-4000-8000-0000000000a1");

    const done = await repo.recordResult("current-result", 0, true, { ok: true });
    expect(done).toMatchObject({ status: "DONE", terminalReason: "result_succeeded" });

    await repo.enqueueMappedJob({
      legacyJobId: "stale-result",
      nodeId: NODE_B,
      payload: { n: "stale" },
      timeoutMs: 10_000,
    });
    await repo.claimAndStart("stale-result", 0, "33000000-0000-4000-8000-0000000000b2");
    await repo.bumpEpoch(NODE_B, 0);

    const stale = await repo.recordResult("stale-result", 0, true, { ok: true });
    expect(stale).toMatchObject({ status: "RUNNING" });

    const audit = await pool.query<{ event_type: string; decision: string; evidence: Record<string, unknown> }>(
      `SELECT event_type, decision, evidence
       FROM pnq_resolution_audit
       WHERE event_type = 'stale_result'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      event_type: "stale_result",
      decision: "rejected",
    });
    expect(audit.rows[0]!.evidence).toMatchObject({
      claimed_connection_epoch: 0,
      reason: "connection_epoch_mismatch",
    });
  });
});

async function assertRealPostgres(pool: Pool): Promise<void> {
  const result = await pool.query("SELECT version() AS version");
  expect(result.rows[0]?.version).toMatch(/PostgreSQL/i);
}

function assertSafeTestDatabase(url: string): void {
  if (!/127\.0\.0\.1|localhost/.test(url) || !/(test|pnq)/i.test(url)) {
    throw new Error(`Refusing to run destructive PNQ runtime test against non-local/non-test database: ${url}`);
  }
}
