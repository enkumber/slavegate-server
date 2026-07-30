import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const postgresUrl = process.env.PNQ001_PG_URL;
const describePostgres = postgresUrl ? describe.sequential : describe.skip;
const API_KEY = "compile-job-e2e-local-key";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_KEY = "aaaaaaaaaaaaaaaaaaaaaaaa";
let setup: Pool;
let baseUrl = "";

describePostgres("human compile-job durable reconciler HTTP gate", () => {
  let admin: Pool;
  let schema = "";
  let server: http.Server;
  let serviceModule: typeof import("../src/modules/human-workflow/compile-job.service");
  let closeDb: typeof import("../src/db/client").closeDb;
  const transcript: string[] = [];

  beforeAll(async () => {
    const parsed = new URL(postgresUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("compile-job reconciliation integration requires local PostgreSQL clone");
    }
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === postgresUrl) {
      throw new Error("PNQ001_PG_URL must not be the production DATABASE_URL");
    }
    process.env.API_KEY = API_KEY;
    process.env.JWT_SECRET = "compile-job-e2e-local-jwt-secret";
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "5000";
    admin = new Pool({ connectionString: postgresUrl, max: 2 });
    const identity = await admin.query("SELECT current_database() AS database, inet_server_addr()::text AS host, inet_server_port() AS port, current_user AS user");
    transcript.push(`clone_identity=${JSON.stringify(identity.rows[0])}`);
    const readOnly = await admin.query("SHOW transaction_read_only");
    transcript.push(`source_read_only_probe transaction_read_only=${readOnly.rows[0].transaction_read_only}`);
    schema = `human_compile_http_e2e_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    transcript.push(`created_isolated_schema=${schema}`);
    const isolated = new URL(postgresUrl!);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    setup = new Pool({ connectionString: isolated.toString(), max: 8 });
    await installSchema(setup);
    await seedControlPlane(setup);
    vi.resetModules();
    const catalog = await import("../src/modules/human-workflow/capability-catalog.service");
    const composer = await import("../src/modules/workflow-segments/composer");
    vi.spyOn(catalog.capabilityCatalogService, "retrieve").mockResolvedValue(retrievalContext());
    vi.spyOn(composer.workflowSegmentComposer, "compose").mockResolvedValue(null);
    vi.spyOn(composer.workflowSegmentComposer, "composeCandidate").mockResolvedValue(null);
    serviceModule = await import("../src/modules/human-workflow/compile-job.service");
    ({ closeDb } = await import("../src/db/client"));
    const router = (await import("../src/api/routes")).default;
    serviceModule.humanWorkflowCompileJobService.configureRunner(async (job) => ({
      ready: true,
      requestKey: job.requestKey,
      cacheHit: false,
      cacheKey: "bbbbbbbbbbbbbbbbbbbbbbbb",
      source: "llm",
      plan: { steps: [], compileOnly: true },
      safetyClass: "compile_preview",
      platform: job.platform,
      target: {
        device_id: job.deviceId,
        device_model: "local clone",
        device_name: "clone device",
        account_id: job.accountId,
        account_username: "clone-account",
        account_platform: job.platform,
        client_id: null,
      },
      llmDebug: {
        sensitive: true,
        compilerCacheVersion: "http-e2e",
        attempts: [{ provider: "stub", model: "stub", endpoint: "local", attempt: 1, maxTokens: 1, rawResponse: "redacted", responseTruncated: false, capturedAt: new Date().toISOString() }],
      },
    }));
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    transcript.push(`http_listener=${baseUrl}`);
  });

  afterAll(async () => {
    serviceModule?.humanWorkflowCompileJobService.stopReconciler();
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    await closeDb?.();
    await setup?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
    const evidenceDir = path.join(process.cwd(), "reports/phone-network");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "human-compile-job-reconciler-http-e2e-evidence.json"),
      JSON.stringify({ story: "STORY-PN-HUMAN-COMPILE-JOB-DURABLE-LEASE-RECONCILER-3-9-311-001", transcript }, null, 2),
    );
  });

  it("creates and polls a durable compile job through real Express routes", async () => {
    const created = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: "compile preview without phone egress",
      requestKey: REQUEST_KEY,
    });
    transcript.push(`create_status=${created.status} body=${redact(created.body)}`);
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const compileJobId = created.body.data.compileJobId;
    expect(compileJobId).toMatch(/^[0-9a-f-]{36}$/);

    const polled = await waitForReady(compileJobId);
    transcript.push(`poll_ready_status=${polled.status} body=${redact(polled.body)}`);
    expect(polled.body.data.ready).toBe(true);
    expect(polled.body.data.requestKey).toBe(REQUEST_KEY);

    const counts = await setup.query(`
      SELECT
        (SELECT COUNT(*)::int FROM jobs) AS jobs,
        (SELECT COUNT(*)::int FROM command_log) AS command_log,
        (SELECT COUNT(*)::int FROM job_execution_events) AS job_execution_events
    `);
    transcript.push(`zero_egress_counts=${JSON.stringify(counts.rows[0])}`);
    expect(counts.rows[0]).toEqual({ jobs: 0, command_log: 0, job_execution_events: 0 });
  });

  it("returns the exact replay and rejects a conflicting payload under one request key", async () => {
    const replay = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: "compile preview without phone egress",
      requestKey: REQUEST_KEY,
    });
    transcript.push(`exact_replay_status=${replay.status} body=${redact(replay.body)}`);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.ready).toBe(true);
    expect(replay.body.data.requestKey).toBe(REQUEST_KEY);

    const conflict = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: "different payload same request key",
      requestKey: REQUEST_KEY,
    });
    transcript.push(`conflict_status=${conflict.status} body=${redact(conflict.body)}`);
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect(conflict.body.code).toBe("COMPILE_REQUEST_IDEMPOTENCY_CONFLICT");
  });

  it("gives one PostgreSQL claim to two racing workers across two service instances", async () => {
    const key = "cccccccccccccccccccccccc";
    await insertPendingJob(key);
    const first = new serviceModule.HumanWorkflowCompileJobService();
    const second = new serviceModule.HumanWorkflowCompileJobService();
    let executions = 0;
    const runner = async () => {
      executions += 1;
      return { cacheKey: "dddddddddddddddddddddddd" };
    };
    first.configureRunner(runner);
    second.configureRunner(runner);

    const claims = await Promise.all([first.reconcileOnce(), second.reconcileOnce()]);
    transcript.push(`two_worker_claims=${JSON.stringify(claims)}`);
    expect(claims.reduce((sum, value) => sum + value, 0)).toBe(1);
    await waitForJobTerminal(key);
    expect(executions).toBe(1);
  });

  it("reclaims an expired running lease and records stale generation rejection", async () => {
    const key = "eeeeeeeeeeeeeeeeeeeeeeee";
    await setup.query(
      `INSERT INTO human_workflow_compile_jobs
        (request_key, request_payload_hash, device_id, account_id, intent, platform, status,
         lease_owner, lease_generation, lease_expires_at)
       VALUES ($1, repeat('0', 64), $2, $3, 'restart intent', 'cloneapp', 'active',
         'dead-process', 1, NOW() - INTERVAL '1 second')`,
      [key, DEVICE_ID, ACCOUNT_ID],
    );
    const service = new serviceModule.HumanWorkflowCompileJobService();
    service.configureRunner(async () => ({ cacheKey: "ffffffffffffffffffffffff" }));

    await expect(service.reconcileOnce()).resolves.toBe(1);
    await waitForJobTerminal(key);
    const row = await setup.query(
      `SELECT lease_generation, lease_owner, completed_at
         FROM human_workflow_compile_jobs
        WHERE request_key = $1`,
      [key],
    );
    transcript.push(`expired_reclaim_row=${JSON.stringify(row.rows[0])}`);
    expect(Number(row.rows[0].lease_generation)).toBe(2);
    expect(row.rows[0].lease_owner).toBeNull();
    expect(row.rows[0].completed_at).not.toBeNull();

    const rejected = await setup.query(
      `UPDATE human_workflow_compile_jobs
          SET result = '{"late":true}'::jsonb
        WHERE request_key = $1
          AND lease_owner = 'dead-process'
          AND lease_generation = 1
        RETURNING id`,
      [key],
    );
    const events = await setup.query(
      `SELECT event_key, lease_generation FROM human_workflow_compile_job_events WHERE job_id = (
         SELECT id FROM human_workflow_compile_jobs WHERE request_key = $1
       ) ORDER BY id`,
      [key],
    );
    transcript.push(`stale_generation_update_rows=${rejected.rows.length} events=${JSON.stringify(events.rows)}`);
    expect(rejected.rows).toHaveLength(0);
    expect(events.rows.some((row) => row.event_key === "lease_completed" && Number(row.lease_generation) === 2)).toBe(true);
  });
});

async function installSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE TABLE devices (
      id UUID PRIMARY KEY,
      friendly_name TEXT NOT NULL DEFAULT '',
      model TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE accounts (
      id UUID PRIMARY KEY,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      device_id UUID REFERENCES devices(id),
      client_id UUID,
      status TEXT NOT NULL,
      simulated_timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (platform, username),
      UNIQUE (platform, device_id)
    );
    CREATE TABLE jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID NOT NULL REFERENCES devices(id),
      job_type TEXT NOT NULL,
      params JSONB NOT NULL,
      status TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE command_log (
      id BIGSERIAL PRIMARY KEY,
      device_id UUID NOT NULL REFERENCES devices(id),
      job_id UUID REFERENCES jobs(id),
      command_type TEXT NOT NULL,
      command_params JSONB,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE job_execution_events (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID NOT NULL REFERENCES jobs(id),
      device_id UUID NOT NULL REFERENCES devices(id),
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE workflow_templates (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      definition JSONB NOT NULL,
      default_verification_strategy TEXT NOT NULL DEFAULT 'none',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE generated_workflow_plan_cache (
      cache_key TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      template_version TEXT NOT NULL,
      workflow JSONB NOT NULL,
      compiled_plan JSONB NOT NULL,
      request_key TEXT,
      artifact_state TEXT NOT NULL DEFAULT 'promoted',
      source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE workflow_shortcuts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'inactive',
      priority INTEGER NOT NULL DEFAULT 100,
      intent_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      match_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      workflow_template JSONB NOT NULL DEFAULT '{}'::jsonb,
      compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE system_prompts (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE runtime_semantic_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '*',
      lifecycle_key TEXT NOT NULL DEFAULT 'runtime_semantic_fixture',
      status TEXT,
      priority INTEGER NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (namespace, entry_key)
    );
    CREATE TABLE lifecycle_state_definitions (
      lifecycle_key TEXT NOT NULL,
      status TEXT NOT NULL,
      initial BOOLEAN NOT NULL,
      terminal BOOLEAN NOT NULL,
      retryable BOOLEAN NOT NULL,
      administrative BOOLEAN NOT NULL,
      dispatchable BOOLEAN NOT NULL,
      manual BOOLEAN NOT NULL DEFAULT FALSE,
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
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (lifecycle_key, action_key, from_status)
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
      version BIGINT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE human_workflow_compile_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_key TEXT NOT NULL UNIQUE,
      request_payload_hash TEXT,
      device_id UUID NOT NULL REFERENCES devices(id),
      account_id UUID REFERENCES accounts(id),
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
    CREATE FUNCTION resolve_human_workflow_platform(p_intent TEXT)
    RETURNS TABLE (
      app_id TEXT,
      package_name TEXT,
      app_name TEXT,
      match_score INTEGER
    )
    LANGUAGE sql
    STABLE
    AS $$
      SELECT 'cloneapp'::text, 'local.cloneapp'::text, 'Clone App'::text, 100::integer
      WHERE p_intent IS NOT NULL
    $$;
    CREATE FUNCTION lifecycle_state_matches(
      p_resource_table REGCLASS,
      p_status TEXT,
      p_selector JSONB,
      p_state_column NAME DEFAULT 'status'
    )
    RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE((
        SELECT
          (NOT (p_selector ? 'initial') OR definition.initial = (p_selector->>'initial')::boolean)
          AND (NOT (p_selector ? 'terminal') OR definition.terminal = (p_selector->>'terminal')::boolean)
          AND (NOT (p_selector ? 'retryable') OR definition.retryable = (p_selector->>'retryable')::boolean)
          AND (NOT (p_selector ? 'administrative') OR definition.administrative = (p_selector->>'administrative')::boolean)
          AND (NOT (p_selector ? 'dispatchable') OR definition.dispatchable = (p_selector->>'dispatchable')::boolean)
        FROM lifecycle_resource_bindings binding
        JOIN lifecycle_state_definitions definition
          ON definition.lifecycle_key = binding.lifecycle_key
         AND definition.status = p_status
        WHERE binding.resource_table = p_resource_table
          AND binding.state_column = p_state_column
        LIMIT 1
      ), FALSE)
    $$;
  `);
  const migration = fs.readFileSync(
    path.join(process.cwd(), "src/db/migrations/122_human_compile_job_durable_lease.sql"),
    "utf8",
  );
  await pool.query(migration);
}

async function seedControlPlane(pool: Pool): Promise<void> {
  await pool.query("INSERT INTO devices (id, friendly_name, model, status) VALUES ($1, 'clone device', 'local clone', 'online')", [DEVICE_ID]);
  await pool.query(
    "INSERT INTO accounts (id, platform, username, device_id, status) VALUES ($1, 'cloneapp', 'clone-account', $2, 'active')",
    [ACCOUNT_ID, DEVICE_ID],
  );
  await pool.query(`
     INSERT INTO lifecycle_state_definitions
       (lifecycle_key, status, initial, terminal, retryable, administrative, dispatchable, manual)
     VALUES
       ('test_compile', 'pending', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE),
       ('test_compile', 'active', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
       ('test_compile', 'complete', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE),
       ('test_compile', 'retryable', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE),
       ('runtime_semantic_fixture', 'active', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE);
  `);
  await pool.query(`
     INSERT INTO lifecycle_transitions
       (lifecycle_key, action_key, from_status, to_status, automatic, mark_started, mark_completed, clear_failure, reset_retry)
     VALUES
       ('test_compile', 'claim', 'pending', 'active', TRUE, TRUE, FALSE, FALSE, FALSE),
       ('test_compile', 'finish', 'active', 'complete', FALSE, FALSE, TRUE, TRUE, FALSE),
       ('test_compile', 'fail', 'active', 'retryable', TRUE, FALSE, TRUE, FALSE, FALSE);
  `);
  await pool.query(`
     INSERT INTO lifecycle_resource_bindings VALUES
       ('human_workflow_compile_jobs'::regclass, 'test_compile', 'status'),
       ('runtime_semantic_entries'::regclass, 'runtime_semantic_fixture', 'status');
  `);
  await pool.query(`
     INSERT INTO lifecycle_resource_policies VALUES
       ('human_workflow_compile_jobs'::regclass, 'status', '{"enabled":true,"configuredBy":"http-e2e"}', 11),
       ('runtime_semantic_entries'::regclass, 'status', '{"enabled":true,"configuredBy":"http-e2e"}', 11);
  `);
  await pool.query(`
     INSERT INTO resource_runtime_policies VALUES (
       'human_workflow_compile_jobs'::regclass,
       '{"enabled":true,"compileWorker":{"leaseDurationMs":800,"heartbeatIntervalMs":100,"reconcileIntervalMs":100,"batchSize":1,"maxAttempts":5},"configuredBy":"http-e2e"}',
       11,
       'http-e2e',
       NOW()
     );
  `);
  await pool.query(`
     INSERT INTO system_prompts (key, content) VALUES
       ('compile', 'compile {{goal}} {{targetContext}} {{runtimeProfile}} {{retrievalContext}} {{toolCatalog}} {{compilerPolicy}}'),
       ('repair', 'repair {{compilePrompt}} {{rejectedWorkflow}} {{reason}}'),
       ('compile_system', 'compile system'),
       ('repair_system', 'repair system'),
       ('policy', 'policy');
  `);
  await pool.query(
    `
     INSERT INTO runtime_semantic_entries (namespace, entry_key, platform, lifecycle_key, status, priority, payload) VALUES
       ('compiler_control_plane', 'human_workflow_v1', '*', 'runtime_semantic_fixture', 'active', 100, $1::jsonb),
       ('tool_catalog', 'noop_compile_only', '*', 'runtime_semantic_fixture', 'active', 100, '{"action":"noop","compileOnly":true}'::jsonb);`,
    [JSON.stringify(controlPlanePayload())],
  );
}

function controlPlanePayload(): Record<string, unknown> {
  return {
    version: "http-e2e",
    missingCapabilityPolicy: "fail_closed",
    normalizationPolicy: "strict_reject",
    promptKeys: {
      compile: "compile",
      repair: "repair",
      compileSystem: "compile_system",
      repairSystem: "repair_system",
      policy: "policy",
    },
    llm: {
      initialMaxTokens: 1,
      repairMaxTokens: 1,
      temperature: 0,
      disableThinking: true,
    },
    retrievalPolicy: {
      maxContextArtifacts: 1,
      maxContextUiItems: 1,
      maxContextFailures: 1,
      maxRankedCapabilities: 1,
      maxArtifactRows: 1,
      maxFailedArtifactRows: 1,
      maxArtifactSteps: 1,
      artifactParamAllowlist: ["packageName"],
      uiGraphSafetyAllowlist: ["low"],
      artifactSafetyAllowlist: { low: ["compile_preview"] },
    },
    safetyClassMap: { low: "compile_preview" },
  };
}

function retrievalContext(): any {
  return {
    fullArtifactCacheKey: null,
    matchedCapabilityKey: "compile.preview",
    matchedCapabilityScore: 1,
    recommendedSafetyClass: "low",
    goalContract: {
      version: "v1",
      allowedEffects: ["none"],
      requiredOutputs: ["preview"],
      stages: [{ id: "preview", required: true, allowedActions: ["noop"], produces: ["preview"] }],
    },
    matchedCapabilityMetadata: { compositionEnabled: false },
    knowledge: { promotedArtifacts: [], uiGraph: { selectors: [], transitions: [] }, avoid: [] },
  };
}

async function insertPendingJob(requestKey: string): Promise<void> {
  await setup.query(
    `INSERT INTO human_workflow_compile_jobs
      (request_key, request_payload_hash, device_id, account_id, intent, platform)
     VALUES ($1, repeat('0', 64), $2, $3, 'race intent', 'cloneapp')`,
    [requestKey, DEVICE_ID, ACCOUNT_ID],
  );
}

async function listen(app: express.Express): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return server;
}

async function postJson(pathname: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });
  return { status: response.status, body: await response.json() };
}

async function waitForReady(compileJobId: string): Promise<{ status: number; body: any }> {
  let last: { status: number; body: any } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await getJson(`/api/workflows/human/compile-jobs/${compileJobId}`);
    if (last.status === 200 && last.body.data?.ready === true) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`compile job did not become ready: ${JSON.stringify(last)}`);
}

async function waitForJobTerminal(requestKey: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await setup.query(
      `SELECT definition.terminal
         FROM human_workflow_compile_jobs job
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = job.lifecycle_key
          AND definition.status = job.status
        WHERE job.request_key = $1`,
      [requestKey],
    );
    if (result.rows[0]?.terminal === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${requestKey} did not become terminal`);
}

function redact(value: unknown): string {
  return JSON.stringify(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}
