import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeviceExecutionAuthorityForTest } from "../../src/modules/device-execution";
import { setPnqV2RuntimeConfigForTest } from "../../src/modules/device-execution/pnq-v2-runtime-config";
import { pnqV2RuntimeService } from "../../src/modules/device-execution/pnq-v2-runtime.service";
import { setWorkflowJobResultResolverForTest } from "../../src/ws/direct-ws.server";
import { configurePnqV2LifecycleFixture } from "../fixtures/pnq-v2-lifecycle";
import { TEST_DEVICE_EXECUTION_RESOURCE_POLICY } from "../fixtures/device-execution-policy";

const repoRoot = path.resolve(__dirname, "../..");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const originalDatabaseUrl = process.env.DATABASE_URL;
const describePostgres = postgresUrl ? describe.sequential : describe.skip;

const DEVICE_A = "44444444-4444-4444-8444-4444444444a1";
const DEVICE_B = "44444444-4444-4444-8444-4444444444b2";

let adminPool: Pool;
let pool: Pool;
let appServer: http.Server;
let schema = "";

describePostgres("PNQ-003 Phase 4 local real-route shadow E2E", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    process.env.API_KEY = "pnq-003-phase4-test-api-key";
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `pnq003_phase4_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = withSearchPath(postgresUrl, schema);
    process.env.DATABASE_URL = isolatedUrl;
    const dbClient = await import("../../src/db/client");
    await dbClient.closeDb();
    pool = new Pool({ connectionString: isolatedUrl, max: 10 });
    await applySql("src/db/schema.sql");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        status TEXT
      )
    `);
    for (const file of [
      "src/db/migrations/081_device_execution_queue.sql",
      "src/db/migrations/082_pnq_queue_v2_contract.sql",
      "src/db/migrations/083_pnq_v2_runtime_shadow.sql",
      "src/db/migrations/105_generic_resource_lifecycle.sql",
      "src/db/migrations/107_lifecycle_resource_bindings.sql",
      "src/db/migrations/099_db_authoritative_workflow_semantics.sql",
    ]) {
      await applySql(file);
    }
    await configurePnqV2LifecycleFixture(pool, repoRoot);
    await pool.query(`
      ALTER TABLE runtime_semantic_entries
        ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative,
         dispatchable, manual, sort_order)
      VALUES
        ('phase4_runtime_policy_fixture', 'enabled_fixture', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10);
      SELECT configure_lifecycle_resource_binding(
        'runtime_semantic_entries'::regclass,
        'phase4_runtime_policy_fixture',
        'status'
      );
      INSERT INTO runtime_semantic_entries
        (namespace, entry_key, status, lifecycle_key, payload)
      VALUES (
        'phase4_job_policy',
        'screenshot_fixture',
        'enabled_fixture',
        'phase4_runtime_policy_fixture',
        '{"jobActionPolicy":{"actionKey":"screenshot","allowed":true,"requiresRoot":false}}'::jsonb
      );
    `);
    await applySql("src/db/migrations/114_lifecycle_resource_policies.sql");
    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative,
         dispatchable, manual, sort_order)
      VALUES
        ('phase4_root_fixture', 'queued', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 10),
        ('phase4_root_fixture', 'claimed', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase4_root_fixture', 'dispatching', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 30),
        ('phase4_root_fixture', 'dispatched', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 40),
        ('phase4_root_fixture', 'blocked', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 50),
        ('phase4_root_fixture', 'reconciling', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 60),
        ('phase4_root_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 70),
        ('phase4_root_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 80),
        ('phase4_root_fixture', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 90),
        ('phase4_operation_fixture', 'registered', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 10),
        ('phase4_operation_fixture', 'dispatching', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase4_operation_fixture', 'dispatched', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 30),
        ('phase4_operation_fixture', 'rejected', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE, 40),
        ('phase4_operation_fixture', 'blocked', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 50),
        ('phase4_operation_fixture', 'reconciling', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 60),
        ('phase4_operation_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 70),
        ('phase4_operation_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 80),
        ('phase4_operation_fixture', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 90);

      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, manual_allowed,
         external_allowed, automatic, mark_started, mark_completed, clear_failure)
      VALUES
        ('phase4_root_fixture', 'claim', 'queued', 'claimed', FALSE, FALSE, TRUE, TRUE, FALSE, FALSE),
        ('phase4_root_fixture', 'begin_dispatch', 'queued', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'observe_dispatch', 'queued', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'dispatch_claimed', 'claimed', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'observe_claimed_dispatch', 'claimed', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'finish_dispatch', 'dispatching', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'reconcile_claimed', 'claimed', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'block_dispatching', 'dispatching', 'blocked', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'reconcile_dispatched', 'dispatched', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_root_fixture', 'complete_claimed', 'claimed', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'fail_claimed', 'claimed', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'complete_dispatching', 'dispatching', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'fail_dispatching', 'dispatching', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'complete_dispatched', 'dispatched', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'fail_dispatched', 'dispatched', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_root_fixture', 'cancel_queued', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE),
        ('phase4_operation_fixture', 'begin_dispatch', 'registered', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'observe_dispatch', 'registered', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'reject_send', 'registered', 'rejected', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'finish_dispatch', 'dispatching', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'block_dispatching', 'dispatching', 'blocked', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'reconcile_dispatched', 'dispatched', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
        ('phase4_operation_fixture', 'complete_dispatching', 'dispatching', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_operation_fixture', 'fail_dispatching', 'dispatching', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_operation_fixture', 'complete_dispatched', 'dispatched', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_operation_fixture', 'fail_dispatched', 'dispatched', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
        ('phase4_operation_fixture', 'cancel_registered', 'registered', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE);

      SELECT configure_lifecycle_resource_binding(
        'device_execution_roots'::regclass, 'phase4_root_fixture', 'state'
      );
      SELECT configure_lifecycle_resource_binding(
        'device_execution_operations'::regclass, 'phase4_operation_fixture', 'state'
      );
    `);
    await pool.query(
      `INSERT INTO lifecycle_resource_policies
         (resource_table, state_column, policy, updated_by)
       VALUES ('device_execution_roots'::regclass, 'state', $1::jsonb, 'phase4-test')`,
      [JSON.stringify(TEST_DEVICE_EXECUTION_RESOURCE_POLICY)],
    );
    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative,
         dispatchable, manual, sort_order)
      VALUES
        ('phase4_job_fixture', 'fixture_waiting', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
        ('phase4_job_fixture', 'fixture_active', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase4_job_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 30),
        ('phase4_job_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 40);
      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, external_allowed,
         mark_started, mark_completed)
      VALUES
        ('phase4_job_fixture', 'fixture_dispatch', 'fixture_waiting', 'fixture_active', FALSE, TRUE, FALSE),
        ('phase4_job_fixture', 'fixture_complete_waiting', 'fixture_waiting', 'completed', TRUE, FALSE, TRUE),
        ('phase4_job_fixture', 'fixture_fail_waiting', 'fixture_waiting', 'failed', TRUE, FALSE, TRUE),
        ('phase4_job_fixture', 'fixture_complete', 'fixture_active', 'completed', TRUE, FALSE, TRUE),
        ('phase4_job_fixture', 'fixture_fail', 'fixture_active', 'failed', TRUE, FALSE, TRUE);
      SELECT configure_lifecycle_resource_binding('jobs', 'phase4_job_fixture');
    `);
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT`);
    setDeviceExecutionAuthorityForTest("observe_only");
    const { dispatcherService } = await import("../../src/modules/dispatcher/dispatcher.service");
    const dispatcherInternals = dispatcherService as unknown as {
      getQueue(deviceId: string): { add(...args: unknown[]): Promise<void> };
    };
    dispatcherInternals.getQueue = () => ({ add: async () => undefined });
    const apiRouter = (await import("../../src/api/routes")).default;
    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    appServer = await listen(app);
  });

  beforeEach(async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    setPnqV2RuntimeConfigForTest({ enabled: true, sweepIntervalMs: 30_000 });
    // This suite validates the Queue v2 shadow lifecycle, not the workflow
    // executor's CommonJS cycle. Production keeps the original synchronous
    // resolver; inject a no-op here so Vitest does not try to require a TS
    // module through Node's CommonJS loader.
    setWorkflowJobResultResolverForTest(() => false);
    await cleanupRows();
    await seedDevice(DEVICE_A);
    await seedDevice(DEVICE_B);
  });

  afterEach(async () => {
    setWorkflowJobResultResolverForTest(null);
    setPnqV2RuntimeConfigForTest(null);
    vi.restoreAllMocks();
    // Observe-only terminal bookkeeping is intentionally detached from the
    // legacy result path. Let it release its transaction before truncating the
    // isolated schema for the next case.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { directWsServer } = await import("../../src/ws/direct-ws.server");
    const internals = directWsServer as unknown as { connections: Map<string, unknown> };
    internals.connections.delete(DEVICE_A);
    internals.connections.delete(DEVICE_B);
    await cleanupRows();
  });

  afterAll(async () => {
    setDeviceExecutionAuthorityForTest(null);
    delete process.env.API_KEY;
    if (appServer) await close(appServer);
    const dbClient = await import("../../src/db/client");
    await dbClient.closeDb();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("persists the happy-path shadow lifecycle while the canonical DirectWS route sends exactly once", async () => {
    const sends = await connectDevices([DEVICE_A]);

    const response = await postJob(DEVICE_A, { phase: "happy" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const jobId = response.body.data.jobId as string;

    expect(sends.get(DEVICE_A)).toHaveLength(1);
    expect(JSON.parse(sends.get(DEVICE_A)![0]!)).toMatchObject({
      type: "JOB",
      jobId,
      jobType: "screenshot",
    });

    await waitForShadowJob(jobId, "RUNNING");
    await deliverJobResult(DEVICE_A, jobId, { ok: true });
    await waitForLegacyJob(jobId, "completed");
    await waitForShadowJob(jobId, "DONE");

    const lifecycle = await pool.query<{
      legacy_job_id: string;
      status: string;
      node_seq: string;
      attempt_execution_id: string | null;
      terminal_reason: string | null;
    }>(
      `SELECT m.legacy_job_id, j.status, j.node_seq, m.attempt_execution_id, j.terminal_reason
       FROM pnq_legacy_job_map m
       JOIN pnq_jobs j ON j.id = m.pnq_job_id
       WHERE m.legacy_job_id = $1`,
      [jobId],
    );
    expect(lifecycle.rows).toMatchObject([{
      legacy_job_id: jobId,
      status: "DONE",
      node_seq: "1",
      terminal_reason: "result_succeeded",
    }]);
    expect(lifecycle.rows[0]!.attempt_execution_id).toMatch(/[0-9a-f-]{36}/);
  });

  it("keeps standalone job admission fail-closed until the generic lifecycle policy API configures the bound resource", async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    const sends = await connectDevices([DEVICE_A]);
    await pool.query(
      `DELETE FROM lifecycle_resource_policies
        WHERE resource_table = 'device_execution_roots'::regclass
          AND state_column = 'state'::name`,
    );

    const absent = await postJob(DEVICE_A, { phase: "policy-absent" });
    expect(absent.status).toBe(503);
    expect(absent.body).toMatchObject({
      ok: false,
      code: "LIFECYCLE_RESOURCE_POLICY_UNAVAILABLE",
      details: { retryable: true },
    });
    expect(absent.body.error).toContain("operational policy is not configured");
    expect(sends.get(DEVICE_A)).toHaveLength(0);
    const healthAfterAbsentAdmission = await requestJson(appServer, "GET", "/api/health");
    expect(healthAfterAbsentAdmission.status).toBe(200);
    expect(healthAfterAbsentAdmission.body).toMatchObject({
      ok: true,
      data: { health: "healthy" },
    });

    const configured = await requestJson(
      appServer,
      "PUT",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
      { policy: TEST_DEVICE_EXECUTION_RESOURCE_POLICY, updatedBy: "phase4-test-api" },
    );
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    expect(configured.body.data).toMatchObject({
      resourceTable: expect.stringContaining("device_execution_roots"),
      stateColumn: "state",
      policy: TEST_DEVICE_EXECUTION_RESOURCE_POLICY,
    });

    const readback = await requestJson(
      appServer,
      "GET",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
    );
    expect(readback.status).toBe(200);
    expect(readback.body.data.policy).toMatchObject(TEST_DEVICE_EXECUTION_RESOURCE_POLICY);

    const admitted = await postJob(DEVICE_A, { phase: "policy-configured" });
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(202);
    expect(sends.get(DEVICE_A)).toHaveLength(1);

    const disabled = await requestJson(
      appServer,
      "PUT",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
      { disabled: true, updatedBy: "phase4-test-api" },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.policy).toEqual({ enabled: false });

    const disabledAdmission = await postJob(DEVICE_A, { phase: "policy-disabled" });
    expect(disabledAdmission.status).toBe(503);
    expect(disabledAdmission.body.error).toContain("operational policy is disabled");

    const rootKinds = TEST_DEVICE_EXECUTION_RESOURCE_POLICY.rootKinds as Record<string, unknown>;
    const configuredRootKind = Object.keys(rootKinds)[0]!;
    const ambiguousPolicy = {
      ...TEST_DEVICE_EXECUTION_RESOURCE_POLICY,
      rootKinds: {
        ...rootKinds,
        [configuredRootKind]: [rootKinds[configuredRootKind], rootKinds[configuredRootKind]],
      },
    };
    const ambiguous = await requestJson(
      appServer,
      "PUT",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
      { policy: ambiguousPolicy, updatedBy: "phase4-test-api" },
    );
    expect(ambiguous.status, JSON.stringify(ambiguous.body)).toBe(200);
    const ambiguousAdmission = await postJob(DEVICE_A, { phase: "policy-ambiguous" });
    expect(ambiguousAdmission.status).toBe(503);
    expect(ambiguousAdmission.body).toMatchObject({
      ok: false,
      code: "LIFECYCLE_RESOURCE_POLICY_UNAVAILABLE",
      details: { retryable: true },
    });
    expect(ambiguousAdmission.body.error).toContain("root-kind policy is ambiguous");
    const healthAfterAmbiguousAdmission = await requestJson(appServer, "GET", "/api/health");
    expect(healthAfterAmbiguousAdmission.status).toBe(200);
    expect(healthAfterAmbiguousAdmission.body).toMatchObject({
      ok: true,
      data: { health: "healthy" },
    });

    const deleted = await requestJson(
      appServer,
      "DELETE",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
    );
    expect(deleted.status).toBe(200);
    const deletedAdmission = await postJob(DEVICE_A, { phase: "policy-deleted" });
    expect(deletedAdmission.status).toBe(503);
    expect(deletedAdmission.body.error).toContain("operational policy is not configured");

    await requestJson(
      appServer,
      "PUT",
      "/api/lifecycle-resource-policies/device_execution_roots/state",
      { policy: TEST_DEVICE_EXECUTION_RESOURCE_POLICY, updatedBy: "phase4-test-restore" },
    );
  });

  it("keeps HTTP and legacy result handling prompt when shadow DB work is pending or rejected", async () => {
    const sends = await connectDevices([DEVICE_A]);
    vi.spyOn(pnqV2RuntimeService, "enqueueShadowJob").mockReturnValue(new Promise(() => undefined));
    const response = await postJob(DEVICE_A, { phase: "pending-shadow" });

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(sends.get(DEVICE_A)).toHaveLength(1);

    vi.restoreAllMocks();
    vi.spyOn(pnqV2RuntimeService, "recordShadowResult").mockRejectedValue(new Error("shadow db rejected"));
    const jobId = response.body.data.jobId as string;
    await deliverJobResult(DEVICE_A, jobId, { shadow: "rejected" });
    await waitForLegacyJob(jobId, "completed");
  });

  it("audits stale socket epochs only in shadow while legacy authority continues", async () => {
    const sends = await connectDevices([DEVICE_A]);
    const response = await postJob(DEVICE_A, { phase: "stale-epoch" });
    const jobId = response.body.data.jobId as string;

    expect(sends.get(DEVICE_A)).toHaveLength(1);
    await waitForShadowJob(jobId, "RUNNING");
    await pool.query("SELECT pnq_bump_connection_epoch($1, $2)", [DEVICE_A, 0]);

    await deliverJobResult(DEVICE_A, jobId, { stale: true });
    await waitForLegacyJob(jobId, "completed");

    const shadow = await pool.query<{ status: string }>(
      `SELECT j.status
       FROM pnq_legacy_job_map m
       JOIN pnq_jobs j ON j.id = m.pnq_job_id
       WHERE m.legacy_job_id = $1`,
      [jobId],
    );
    expect(shadow.rows).toEqual([{ status: "RUNNING" }]);

    const audit = await pool.query<{ decision: string; evidence: Record<string, unknown> }>(
      `SELECT decision, evidence
       FROM pnq_resolution_audit
       WHERE event_type = 'stale_result'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      decision: "rejected",
      evidence: { reason: "connection_epoch_mismatch" },
    });
  });

  it("marks expired shadow work STUCK without replay and preserves FIFO for the same device", async () => {
    const sends = await connectDevices([DEVICE_A]);
    const first = await postJob(DEVICE_A, { order: 1 });
    const second = await postJob(DEVICE_A, { order: 2 });
    const firstJobId = first.body.data.jobId as string;
    const secondJobId = second.body.data.jobId as string;

    expect(sends.get(DEVICE_A)).toHaveLength(2);
    await waitForShadowJob(firstJobId, "RUNNING");
    await waitForShadowJob(secondJobId, "PENDING");

    const fifo = await pool.query<{ legacy_job_id: string; node_seq: string; status: string }>(
      `SELECT m.legacy_job_id, j.node_seq, j.status
       FROM pnq_legacy_job_map m
       JOIN pnq_jobs j ON j.id = m.pnq_job_id
       WHERE m.legacy_job_id = ANY($1::text[])
       ORDER BY j.node_seq`,
      [[firstJobId, secondJobId]],
    );
    expect(fifo.rows).toEqual([
      { legacy_job_id: firstJobId, node_seq: "1", status: "RUNNING" },
      { legacy_job_id: secondJobId, node_seq: "2", status: "PENDING" },
    ]);

    await pool.query(
      `UPDATE pnq_jobs
       SET queue_deadline_at = NOW() - INTERVAL '4 seconds',
           dispatch_deadline_at = NOW() - INTERVAL '3 seconds',
           execution_deadline_at = NOW() - INTERVAL '2 seconds',
           result_deadline_at = NOW() - INTERVAL '1 second'
       WHERE id = (SELECT pnq_job_id FROM pnq_legacy_job_map WHERE legacy_job_id = $1)`,
      [firstJobId],
    );
    const sendCountBeforeSweep = sends.get(DEVICE_A)!.length;
    await expect(pnqV2RuntimeService.reconcileStartup()).resolves.toMatchObject({ ok: true });
    expect(sends.get(DEVICE_A)).toHaveLength(sendCountBeforeSweep);
    await waitForShadowJob(firstJobId, "STUCK");
  });

  it("progresses different devices in parallel with real PostgreSQL connections", async () => {
    const sends = await connectDevices([DEVICE_A, DEVICE_B]);
    const [a, b] = await Promise.all([
      postJob(DEVICE_A, { device: "a" }),
      postJob(DEVICE_B, { device: "b" }),
    ]);
    const jobA = a.body.data.jobId as string;
    const jobB = b.body.data.jobId as string;

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(sends.get(DEVICE_A)).toHaveLength(1);
    expect(sends.get(DEVICE_B)).toHaveLength(1);
    await Promise.all([
      waitForShadowJob(jobA, "RUNNING"),
      waitForShadowJob(jobB, "RUNNING"),
    ]);

    const active = await pool.query<{ node_id: string; count: string }>(
      `SELECT node_id, COUNT(*)::int AS count
       FROM pnq_jobs
       WHERE status = 'RUNNING' AND node_id = ANY($1::uuid[])
       GROUP BY node_id
       ORDER BY node_id`,
      [[DEVICE_A, DEVICE_B]],
    );
    expect(active.rows).toEqual([
      { node_id: DEVICE_A, count: 1 },
      { node_id: DEVICE_B, count: 1 },
    ]);
  });
});

async function connectDevices(deviceIds: string[]): Promise<Map<string, string[]>> {
  const { directWsServer } = await import("../../src/ws/direct-ws.server");
  const sends = new Map<string, string[]>();
  const internals = directWsServer as unknown as {
    connections: Map<string, {
      ws: { readyState: number; send: (message: string) => void };
      deviceId: string;
      connectedAt: number;
      lastSeenAt: number;
      lastPongAt: number;
      msgCount: number;
      windowStart: number;
      agentVersion: string;
      pnqV2ConnectionEpoch: number;
    }>;
  };
  for (const deviceId of deviceIds) {
    const frames: string[] = [];
    sends.set(deviceId, frames);
    internals.connections.set(deviceId, {
      ws: { readyState: 1, send: (message: string) => frames.push(message) },
      deviceId,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "4.0.0",
      pnqV2ConnectionEpoch: 0,
    });
  }
  return sends;
}

async function deliverJobResult(deviceId: string, jobId: string, output: Record<string, unknown>): Promise<void> {
  const { directWsServer } = await import("../../src/ws/direct-ws.server");
  const internals = directWsServer as unknown as {
    connections: Map<string, unknown>;
    _handleJobResult: (conn: unknown, msg: Record<string, unknown>) => Promise<void>;
  };
  const conn = internals.connections.get(deviceId);
  if (!conn) throw new Error(`No DirectWS connection for ${deviceId}`);
  await internals._handleJobResult(conn, {
    type: "JOB_RESULT",
    jobId,
    success: true,
    output,
    durationMs: 7,
  });
}

async function postJob(deviceId: string, params: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return postJson(appServer, "/api/jobs", {
    deviceId,
    type: "screenshot",
    params,
    timeoutMs: 10_000,
  });
}

async function waitForLegacyJob(jobId: string, status: string): Promise<void> {
  await waitFor(async () => {
    const result = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [jobId]);
    return result.rows[0]?.status === status;
  });
}

async function waitForShadowJob(jobId: string, status: string): Promise<void> {
  await waitFor(async () => {
    const result = await pool.query<{ status: string }>(
      `SELECT j.status
       FROM pnq_legacy_job_map m
       JOIN pnq_jobs j ON j.id = m.pnq_job_id
       WHERE m.legacy_job_id = $1`,
      [jobId],
    );
    return result.rows[0]?.status === status;
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function seedDevice(deviceId: string): Promise<void> {
  await pool.query(
    `INSERT INTO devices (id, friendly_name, status, agent_version)
     VALUES ($1, $2, 'online', '4.0.0')
     ON CONFLICT (id) DO UPDATE SET status = 'online', agent_version = '4.0.0'`,
    [deviceId, `pnq003-phase4-${deviceId.slice(-2)}`],
  );
}

async function cleanupRows(): Promise<void> {
  await pool.query(
    `TRUNCATE pnq_resolution_audit, pnq_legacy_job_map, pnq_jobs, pnq_nodes,
              command_log, jobs, devices RESTART IDENTITY CASCADE`,
  );
}

async function applySql(relativePath: string): Promise<void> {
  const sql = fs.readFileSync(path.join(repoRoot, relativePath), "utf8").trim();
  if (!sql) return;
  try {
    await pool.query(sql);
  } catch (err) {
    const typed = err as Error & { code?: string };
    if (
      typed.code === "42P07" ||
      typed.code === "42703" ||
      typed.code === "42710" ||
      typed.code === "23505" ||
      typed.message.includes("already exists")
    ) return;
    throw err;
  }
}

async function listen(app: express.Express): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function postJson(server: http.Server, pathName: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return requestJson(server, "POST", pathName, body);
}

async function requestJson(
  server: http.Server,
  method: string,
  pathName: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.API_KEY!,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function assertSafeTestDatabase(connectionString: string): void {
  const dbName = new URL(connectionString).pathname.replace(/^\//, "");
  if (!/(pnq.*test|test.*pnq|pnq001|pnq003|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to use PostgreSQL database "${dbName}". Use a disposable PNQ/test database.`);
  }
}

async function assertRealPostgres(db: Pool): Promise<void> {
  const result = await db.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toMatch(/PostgreSQL/i);
}

function withSearchPath(connectionString: string, targetSchema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${targetSchema}`);
  return url.toString();
}
