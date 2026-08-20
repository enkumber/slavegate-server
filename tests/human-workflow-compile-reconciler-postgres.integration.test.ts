import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client";
import {
  HumanWorkflowCompileJobConflictError,
  HumanWorkflowCompileJobLeaseFenceError,
  HumanWorkflowCompileJobPolicyUnavailableError,
  humanWorkflowCompileJobService,
} from "../src/modules/human-workflow/compile-job.service";

const postgresUrl = process.env.HUMAN_WORKFLOW_COMPILE_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schema = `human_compile_reconciler_${process.pid}_${Date.now()}`;

let adminPool: Pool;
let pool: Pool;

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("human workflow compile PostgreSQL reconciler", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await adminPool.query("SELECT 1");
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    process.env.DATABASE_URL = withSearchPath(postgresUrl, schema);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
    await installSchema(pool);
  });

  beforeEach(async () => {
    await humanWorkflowCompileJobService.stopReconciler();
    await pool.query("TRUNCATE human_workflow_compile_job_events, human_workflow_compile_jobs RESTART IDENTITY CASCADE");
    await installPolicy(pool, { enabled: true });
  });

  afterAll(async () => {
    await humanWorkflowCompileJobService.stopReconciler();
    await closeDb();
    process.env.DATABASE_URL = originalDatabaseUrl;
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("completes queued persisted work after startup reconciliation", async () => {
    const job = await insertJob("queued", "restart-key-000000000001");

    humanWorkflowCompileJobService.startReconciler(async (claimed) => ({
      ready: true,
      requestKey: claimed.requestKey,
      cacheKey: "aaaaaaaaaaaaaaaaaaaaaaaa",
    }));

    const completed = await waitForJob(job.id, (row) => row.status === "completed");
    expect(completed.cache_key).toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(completed.owner_token).toBeNull();
  });

  it("reclaims an expired running lease exactly once", async () => {
    const job = await insertJob("running", "stale-key-0000000000001", {
      owner_token: "old-owner",
      owner_generation: 3,
      lease_expires_at: "NOW() - INTERVAL '1 second'",
      worker_attempt_count: 1,
    });

    const claims = await Promise.all([
      humanWorkflowCompileJobService.claimNext("worker-a"),
      humanWorkflowCompileJobService.claimNext("worker-b"),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await getJob(job.id);
    expect(Number(row.owner_generation)).toBe(4);
    expect(row.owner_token).not.toBe("old-owner");
  });

  it("does not steal a non-stale running lease", async () => {
    await insertJob("running", "fresh-key-0000000000001", {
      owner_token: "active-owner",
      owner_generation: 2,
      lease_expires_at: "NOW() + INTERVAL '30 seconds'",
      worker_attempt_count: 1,
    });

    await expect(humanWorkflowCompileJobService.claimNext("worker")).resolves.toBeNull();
  });

  it("claims one queued job once under concurrent reconcilers", async () => {
    await insertJob("queued", "concurrent-key-000000001");
    let ran = 0;
    const runner = async () => {
      ran += 1;
      return { ready: true, cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb" };
    };

    await Promise.all([
      humanWorkflowCompileJobService.reconcileOnce(runner, "worker-a"),
      humanWorkflowCompileJobService.reconcileOnce(runner, "worker-b"),
    ]);
    await waitForCount("completed", 1);

    expect(ran).toBe(1);
  });

  it("returns the same job for the same idempotency identity", async () => {
    const first = await humanWorkflowCompileJobService.createOrGet({
      requestKey: "cccccccccccccccccccccccc",
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      intent: "open reddit",
      platform: "reddit",
    });
    const second = await humanWorkflowCompileJobService.createOrGet({
      requestKey: "cccccccccccccccccccccccc",
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      intent: "open reddit",
      platform: "reddit",
    });

    expect(second.id).toBe(first.id);
  });

  it("fails closed for a conflicting payload under the same request key", async () => {
    await humanWorkflowCompileJobService.createOrGet({
      requestKey: "dddddddddddddddddddddddd",
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      intent: "open reddit",
      platform: "reddit",
    });

    await expect(humanWorkflowCompileJobService.createOrGet({
      requestKey: "dddddddddddddddddddddddd",
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      intent: "open gmail",
      platform: "gmail",
    })).rejects.toBeInstanceOf(HumanWorkflowCompileJobConflictError);
  });

  it("recovers claim-before-compile and artifact-before-readback crashes without duplicate terminal writes", async () => {
    const beforeCompile = await insertJob("queued", "claim-crash-key-0000001");
    const claim = await humanWorkflowCompileJobService.claimNext("crashing-worker");
    expect(claim?.job.id).toBe(beforeCompile.id);
    await pool.query(
      "UPDATE human_workflow_compile_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [beforeCompile.id],
    );
    await humanWorkflowCompileJobService.reconcileOnce(async () => ({
      ready: true,
      cacheKey: "eeeeeeeeeeeeeeeeeeeeeeee",
    }), "restart-worker");
    await waitForJob(beforeCompile.id, (row) => row.status === "completed");

    const afterArtifact = await insertJob("running", "artifact-crash-key-001", {
      owner_token: "artifact-owner",
      owner_generation: 1,
      lease_expires_at: "NOW() - INTERVAL '1 second'",
      worker_attempt_count: 1,
    });
    let artifactWrites = 0;
    await humanWorkflowCompileJobService.reconcileOnce(async () => {
      artifactWrites += 1;
      return { ready: true, cacheKey: "ffffffffffffffffffffffff" };
    }, "restart-worker");
    await waitForJob(afterArtifact.id, (row) => row.status === "completed");
    await humanWorkflowCompileJobService.reconcileOnce(async () => {
      artifactWrites += 1;
      return { ready: true, cacheKey: "ffffffffffffffffffffffff" };
    }, "restart-worker");

    expect(artifactWrites).toBe(1);
    expect(await eventCount(afterArtifact.id, "completed")).toBe(1);
  });

  it("fails closed when runtime policy is missing or disabled", async () => {
    await pool.query("DELETE FROM resource_runtime_policies");
    await expect(humanWorkflowCompileJobService.claimNext("worker"))
      .rejects.toBeInstanceOf(HumanWorkflowCompileJobPolicyUnavailableError);
    await installPolicy(pool, { enabled: false });
    await expect(humanWorkflowCompileJobService.claimNext("worker"))
      .rejects.toBeInstanceOf(HumanWorkflowCompileJobPolicyUnavailableError);
  });

  it("fences late owner writes by lease generation", async () => {
    const job = await insertJob("queued", "fence-key-000000000001");
    const stale = await humanWorkflowCompileJobService.claimNext("old-worker");
    expect(stale?.job.id).toBe(job.id);
    await pool.query(
      "UPDATE human_workflow_compile_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [job.id],
    );
    const fresh = await humanWorkflowCompileJobService.claimNext("new-worker");
    expect(fresh?.ownerGeneration).toBe((stale?.ownerGeneration ?? 0) + 1);

    await expect(humanWorkflowCompileJobService.completeClaim(stale!, {
      ready: true,
      cacheKey: "abababababababababababab",
    })).rejects.toBeInstanceOf(HumanWorkflowCompileJobLeaseFenceError);
  });
});

async function installSchema(db: Pool): Promise<void> {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE workflow_shortcuts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), key TEXT NOT NULL UNIQUE);
    CREATE TABLE lifecycle_state_definitions (
      lifecycle_key TEXT NOT NULL,
      status TEXT NOT NULL,
      initial BOOLEAN NOT NULL,
      terminal BOOLEAN NOT NULL,
      retryable BOOLEAN NOT NULL,
      administrative BOOLEAN NOT NULL,
      dispatchable BOOLEAN NOT NULL,
      manual BOOLEAN NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (lifecycle_key, status)
    );
    CREATE TABLE lifecycle_transitions (
      lifecycle_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      manual_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      external_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      automatic BOOLEAN NOT NULL DEFAULT FALSE,
      mark_started BOOLEAN NOT NULL DEFAULT FALSE,
      mark_completed BOOLEAN NOT NULL DEFAULT FALSE,
      clear_completed BOOLEAN NOT NULL DEFAULT FALSE,
      clear_failure BOOLEAN NOT NULL DEFAULT FALSE,
      reset_retry BOOLEAN NOT NULL DEFAULT FALSE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE lifecycle_resource_bindings (
      resource_table REGCLASS PRIMARY KEY,
      lifecycle_key TEXT NOT NULL,
      state_column NAME NOT NULL
    );
    CREATE TABLE resource_runtime_policies (
      resource_table REGCLASS PRIMARY KEY,
      policy JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_by TEXT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE human_workflow_compile_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_key TEXT NOT NULL UNIQUE,
      device_id UUID NOT NULL,
      account_id UUID NULL,
      intent TEXT NOT NULL,
      platform TEXT NOT NULL,
      lifecycle_key TEXT NOT NULL DEFAULT 'human_compile_fixture',
      status TEXT NOT NULL DEFAULT 'queued',
      cache_key TEXT,
      source TEXT,
      shortcut_id UUID REFERENCES workflow_shortcuts(id),
      error TEXT,
      provider_error_code TEXT,
      result JSONB,
      llm_started_at TIMESTAMPTZ,
      llm_completed_at TIMESTAMPTZ,
      retry_count INTEGER DEFAULT 0,
      last_retried_at TIMESTAMPTZ,
      timeout_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      owner_token TEXT,
      owner_generation BIGINT NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ,
      worker_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_worker_heartbeat_at TIMESTAMPTZ
    );
    CREATE TABLE human_workflow_compile_job_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES human_workflow_compile_jobs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      owner_token TEXT,
      owner_generation BIGINT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO lifecycle_state_definitions
      (lifecycle_key, status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order)
    VALUES
      ('human_compile_fixture', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
      ('human_compile_fixture', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
      ('human_compile_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, 30),
      ('human_compile_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 40);
    INSERT INTO lifecycle_transitions
      (lifecycle_key, action_key, from_status, to_status, automatic, mark_started, mark_completed, clear_completed, clear_failure)
    VALUES
      ('human_compile_fixture', 'claim', 'queued', 'running', TRUE, TRUE, FALSE, TRUE, TRUE),
      ('human_compile_fixture', 'reclaim', 'running', 'running', TRUE, TRUE, FALSE, TRUE, TRUE),
      ('human_compile_fixture', 'complete', 'running', 'completed', TRUE, FALSE, TRUE, FALSE, TRUE),
      ('human_compile_fixture', 'fail', 'running', 'failed', TRUE, FALSE, TRUE, FALSE, FALSE),
      ('human_compile_fixture', 'retry', 'failed', 'queued', TRUE, FALSE, FALSE, TRUE, TRUE);
    INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
    VALUES ('human_workflow_compile_jobs'::regclass, 'human_compile_fixture', 'status');
  `);
}

async function installPolicy(db: Pool, overrides: Record<string, unknown>): Promise<void> {
  const policy = {
    enabled: true,
    claimLimit: 1,
    leaseMs: 250,
    heartbeatIntervalMs: 50,
    reconcileIntervalMs: 50,
    maxAttempts: 5,
    serverActor: "test-reconciler",
    ...overrides,
  };
  await db.query(
    `INSERT INTO resource_runtime_policies(resource_table, policy)
     VALUES ('human_workflow_compile_jobs'::regclass, $1::jsonb)
     ON CONFLICT (resource_table) DO UPDATE SET policy = EXCLUDED.policy`,
    [JSON.stringify(policy)],
  );
}

async function insertJob(status: string, requestKey: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const columns = ["request_key", "device_id", "account_id", "intent", "platform", "status"];
  const values: unknown[] = [requestKey, DEVICE_ID, ACCOUNT_ID, `intent ${requestKey}`, "reddit", status];
  const expressions = ["$1", "$2", "$3", "$4", "$5", "$6"];
  for (const [key, value] of Object.entries(overrides)) {
    columns.push(key);
    if (typeof value === "string" && (value.startsWith("NOW()") || value.includes("INTERVAL"))) {
      expressions.push(value);
    } else {
      values.push(value);
      expressions.push(`$${values.length}`);
    }
  }
  const result = await pool.query<{ id: string }>(
    `INSERT INTO human_workflow_compile_jobs (${columns.join(", ")})
     VALUES (${expressions.join(", ")})
     RETURNING id`,
    values,
  );
  return result.rows[0];
}

async function getJob(id: string): Promise<Record<string, any>> {
  const result = await pool.query("SELECT * FROM human_workflow_compile_jobs WHERE id = $1", [id]);
  return result.rows[0];
}

async function waitForJob(id: string, predicate: (row: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let i = 0; i < 40; i += 1) {
    const row = await getJob(id);
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not reach expected state`);
}

async function waitForCount(status: string, expected: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const result = await pool.query("SELECT count(*)::int AS count FROM human_workflow_compile_jobs WHERE status = $1", [status]);
    if (result.rows[0].count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`status ${status} count did not become ${expected}`);
}

async function eventCount(jobId: string, eventType: string): Promise<number> {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM human_workflow_compile_job_events WHERE job_id = $1 AND event_type = $2",
    [jobId, eventType],
  );
  return result.rows[0].count;
}

function withSearchPath(url: string, searchPath: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${searchPath}`);
  return parsed.toString();
}

function assertSafeTestDatabase(url: string): void {
  if (!/(test|localhost|127\.0\.0\.1|55432)/i.test(url)) {
    throw new Error(`Refusing to run PostgreSQL integration test against non-test database: ${url}`);
  }
}
