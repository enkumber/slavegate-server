import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const postgresUrl = process.env.PNQ001_PG_URL;
const describePostgres = postgresUrl ? describe.sequential : describe.skip;

describePostgres("human compile-job durable reconciler", () => {
  let admin: Pool;
  let setup: Pool;
  let schema = "";
  let serviceModule: typeof import("../src/modules/human-workflow/compile-job.service");
  let closeDb: typeof import("../src/db/client").closeDb;

  beforeAll(async () => {
    const parsed = new URL(postgresUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("compile-job reconciliation integration requires local PostgreSQL");
    }
    admin = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `human_compile_reconcile_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(postgresUrl!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    setup = new Pool({ connectionString: isolated.toString(), max: 4 });
    await setup.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        initial BOOLEAN NOT NULL,
        terminal BOOLEAN NOT NULL,
        retryable BOOLEAN NOT NULL,
        administrative BOOLEAN NOT NULL,
        dispatchable BOOLEAN NOT NULL,
        manual BOOLEAN NOT NULL,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE lifecycle_transitions (
        lifecycle_key TEXT NOT NULL,
        action_key TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        manual_allowed BOOLEAN NOT NULL,
        external_allowed BOOLEAN NOT NULL,
        automatic BOOLEAN NOT NULL,
        mark_started BOOLEAN NOT NULL,
        mark_completed BOOLEAN NOT NULL,
        clear_completed BOOLEAN NOT NULL,
        clear_failure BOOLEAN NOT NULL,
        reset_retry BOOLEAN NOT NULL,
        PRIMARY KEY (lifecycle_key, action_key, from_status)
      );
      CREATE TABLE human_workflow_compile_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_key TEXT NOT NULL UNIQUE,
        request_payload_hash TEXT,
        device_id UUID NOT NULL,
        account_id UUID,
        intent TEXT NOT NULL,
        platform TEXT NOT NULL,
        lifecycle_key TEXT NOT NULL DEFAULT 'test_compile',
        status TEXT NOT NULL DEFAULT 'pending',
        cache_key TEXT,
        source TEXT,
        shortcut_id UUID,
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
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS NOT NULL,
        lifecycle_key TEXT NOT NULL,
        state_column NAME NOT NULL,
        PRIMARY KEY (resource_table, state_column)
      );
      CREATE TABLE lifecycle_resource_policies (
        resource_table REGCLASS NOT NULL,
        state_column NAME NOT NULL,
        policy JSONB NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (resource_table, state_column)
      );
      CREATE TABLE resource_runtime_policies (
        resource_table REGCLASS PRIMARY KEY,
        policy JSONB NOT NULL,
        version BIGINT NOT NULL DEFAULT 1
      );
      INSERT INTO lifecycle_state_definitions VALUES
        ('test_compile', 'pending', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE),
        ('test_compile', 'active', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
        ('test_compile', 'complete', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE),
        ('test_compile', 'retryable', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE);
      INSERT INTO lifecycle_transitions VALUES
        ('test_compile', 'claim', 'pending', 'active', FALSE, FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, FALSE),
        ('test_compile', 'finish', 'active', 'complete', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
        ('test_compile', 'fail', 'active', 'retryable', FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE, FALSE);
      INSERT INTO lifecycle_resource_bindings
        VALUES ('human_workflow_compile_jobs'::regclass, 'test_compile', 'status');
      INSERT INTO lifecycle_resource_policies
        VALUES ('human_workflow_compile_jobs'::regclass, 'status', '{"enabled":true}', 1);
      INSERT INTO resource_runtime_policies VALUES (
        'human_workflow_compile_jobs'::regclass,
        '{"enabled":true,"compileWorker":{"leaseDurationMs":5000,"heartbeatIntervalMs":1000,"reconcileIntervalMs":1000,"batchSize":1,"maxAttempts":5}}',
        3
      );
    `);
    const migration = fs.readFileSync(
      path.join(process.cwd(), "src/db/migrations/122_human_compile_job_durable_lease.sql"),
      "utf8",
    );
    await setup.query(migration);
    vi.resetModules();
    serviceModule = await import("../src/modules/human-workflow/compile-job.service");
    ({ closeDb } = await import("../src/db/client"));
  });

  afterAll(async () => {
    await closeDb?.();
    await setup?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("gives one PostgreSQL claim to two racing workers", async () => {
    await setup.query(`
      INSERT INTO human_workflow_compile_jobs
        (request_key, device_id, account_id, intent, platform)
      VALUES (
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'test intent',
        'test platform'
      )
    `);
    const first = new serviceModule.HumanWorkflowCompileJobService();
    const second = new serviceModule.HumanWorkflowCompileJobService();
    let executions = 0;
    const runner = async () => {
      executions += 1;
      return { cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb" };
    };
    first.configureRunner(runner);
    second.configureRunner(runner);

    const claims = await Promise.all([first.reconcileOnce(), second.reconcileOnce()]);
    expect(claims.reduce((sum, value) => sum + value, 0)).toBe(1);
    await vi.waitFor(async () => {
      const result = await setup.query(
        `SELECT definition.terminal
           FROM human_workflow_compile_jobs job
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = job.lifecycle_key
            AND definition.status = job.status
          WHERE job.request_key = 'aaaaaaaaaaaaaaaaaaaaaaaa'`,
      );
      expect(result.rows[0]?.terminal).toBe(true);
    });
    expect(executions).toBe(1);
    const row = await setup.query(
      `SELECT lease_generation, lease_owner, result
         FROM human_workflow_compile_jobs
        WHERE request_key = 'aaaaaaaaaaaaaaaaaaaaaaaa'`,
    );
    expect(Number(row.rows[0].lease_generation)).toBe(1);
    expect(row.rows[0].lease_owner).toBeNull();
    expect(row.rows[0].result.cacheKey).toBe("bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("reclaims an expired running lease and fences the old generation", async () => {
    await setup.query(`
      INSERT INTO human_workflow_compile_jobs
        (request_key, device_id, intent, platform, status, lease_owner,
         lease_generation, lease_expires_at)
      VALUES (
        'cccccccccccccccccccccccc',
        '11111111-1111-4111-8111-111111111111',
        'restart intent',
        'test platform',
        'active',
        'dead-process',
        1,
        NOW() - INTERVAL '1 second'
      )
    `);
    const service = new serviceModule.HumanWorkflowCompileJobService();
    service.configureRunner(async () => ({ cacheKey: "dddddddddddddddddddddddd" }));

    await expect(service.reconcileOnce()).resolves.toBe(1);
    await vi.waitFor(async () => {
      const result = await setup.query(
        `SELECT lease_generation, completed_at
           FROM human_workflow_compile_jobs
          WHERE request_key = 'cccccccccccccccccccccccc'`,
      );
      expect(Number(result.rows[0].lease_generation)).toBe(2);
      expect(result.rows[0].completed_at).not.toBeNull();
    });
    const rejected = await setup.query(
      `UPDATE human_workflow_compile_jobs
          SET result = '{"late":true}'::jsonb
        WHERE request_key = 'cccccccccccccccccccccccc'
          AND lease_owner = 'dead-process'
          AND lease_generation = 1
        RETURNING id`,
    );
    expect(rejected.rows).toHaveLength(0);
  });
});
