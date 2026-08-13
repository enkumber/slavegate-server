import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../../src/modules/workflows/types";
import { compileGeneratedWorkflowTemplate } from "../../src/modules/workflows/workflow-validator";
import { setDeviceExecutionAuthorityForTest } from "../../src/modules/device-execution";
import { configureDeviceExecutionLifecycleFixture } from "../fixtures/device-execution-policy";

const repoRoot = path.resolve(__dirname, "../..");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const describePostgres = postgresUrl ? describe.sequential : describe.skip;

const DEVICE_ID = "33333333-3333-4333-8333-333333333301";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333302";
const TASK_ID = "33333333-3333-4333-8333-333333333303";
const CACHE_KEY = "333333333333333333333301";
const REQUEST_KEY = "333333333333333333333302";

let pool: Pool;
let adminPool: Pool;
let schema = "";
const originalDatabaseUrl = process.env.DATABASE_URL;

describePostgres("PNQ-003 Phase 1 real route and cron/task-runner overlap", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `pnq003_phase1_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = withSearchPath(postgresUrl, schema);
    process.env.DATABASE_URL = isolatedUrl;
    process.env.API_KEY = "pnq-003-test-api-key";
    process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS = "60000";

    const dbClient = await import("../../src/db/client");
    await dbClient.closeDb();
    pool = new Pool({ connectionString: isolatedUrl, max: 6 });
    await assertRealPostgres(pool);
    await applySql("src/db/schema.sql");
    for (const file of [
      "src/db/migrations/011_marketing_agency.sql",
      "src/db/migrations/022_task_runner_columns.sql",
      "src/db/migrations/023_task_retry.sql",
      "src/db/migrations/027_app_maps.sql",
      "src/db/migrations/032_generated_workflow_plan_cache.sql",
      "src/db/migrations/034_generated_workflow_request_key.sql",
      "src/db/migrations/035_generated_workflow_canonical_artifact.sql",
      "src/db/migrations/036_agency_workflow_runs.sql",
      "src/db/migrations/060_generated_workflow_artifact_lifecycle.sql",
      "src/db/migrations/087_ui_graph_runtime.sql",
      "src/db/migrations/088_app_runtime_profiles.sql",
      "src/db/migrations/090_edge_workflow_runtime_contract.sql",
      "src/db/migrations/097_verified_ui_state_machine_runtime.sql",
      "src/db/migrations/099_db_authoritative_workflow_semantics.sql",
      "src/db/migrations/116_ui_graph_runtime_structural_enablement.sql",
      "src/db/migrations/117_runtime_semantic_entry_lifecycle_compatibility.sql",
      "src/db/migrations/081_device_execution_queue.sql",
    ]) {
      await applySql(file);
    }
    await configureDeviceExecutionLifecycleFixture(pool, repoRoot, "phase1_device_execution");
    await pool.query(`
      ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;

      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative,
         dispatchable, manual, sort_order)
      VALUES
        ('phase1_workflow_fixture', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
        ('phase1_workflow_fixture', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase1_workflow_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 30),
        ('phase1_workflow_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 40),
        ('phase1_workflow_fixture', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 50),
        ('phase1_job_fixture', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
        ('phase1_job_fixture', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase1_job_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 30),
        ('phase1_job_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 40),
        ('phase1_job_fixture', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 50),
        ('phase1_task_fixture', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
        ('phase1_task_fixture', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
        ('phase1_task_fixture', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 30),
        ('phase1_task_fixture', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 40),
        ('phase1_task_fixture', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 50),
        ('phase1_artifact_fixture', 'candidate_fixture', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE, 10),
        ('phase1_artifact_fixture', 'executable_fixture', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 20),
        ('phase1_runtime_fixture', 'enabled_fixture', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10);
      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, external_allowed,
         automatic, manual_allowed, mark_started, mark_completed)
      VALUES
        ('phase1_workflow_fixture', 'start', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE),
        ('phase1_workflow_fixture', 'complete', 'queued', 'completed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_workflow_fixture', 'complete_running', 'running', 'completed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_workflow_fixture', 'fail', 'queued', 'failed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_workflow_fixture', 'fail_running', 'running', 'failed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_workflow_fixture', 'cancel', 'queued', 'cancelled', FALSE, FALSE, TRUE, FALSE, TRUE),
        ('phase1_job_fixture', 'start', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE),
        ('phase1_job_fixture', 'complete', 'queued', 'completed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_job_fixture', 'complete_running', 'running', 'completed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_job_fixture', 'fail', 'queued', 'failed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_job_fixture', 'fail_running', 'running', 'failed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_task_fixture', 'start', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE),
        ('phase1_task_fixture', 'complete', 'running', 'completed', TRUE, FALSE, FALSE, FALSE, TRUE),
        ('phase1_task_fixture', 'fail', 'running', 'failed', TRUE, FALSE, FALSE, FALSE, TRUE);
      UPDATE lifecycle_state_definitions
         SET stale_after_ms = 10,
             stale_action_key = 'cancel'
       WHERE lifecycle_key = 'phase1_workflow_fixture'
         AND initial;
      SELECT configure_lifecycle_resource_binding('workflows'::regclass, 'phase1_workflow_fixture');
      SELECT configure_lifecycle_resource_binding('jobs'::regclass, 'phase1_job_fixture');
      SELECT configure_lifecycle_resource_binding('tasks'::regclass, 'phase1_task_fixture');
      SELECT configure_lifecycle_resource_binding(
        'generated_workflow_plan_cache'::regclass,
        'phase1_artifact_fixture',
        'artifact_state'
      );
      SELECT configure_lifecycle_resource_binding(
        'runtime_semantic_entries'::regclass,
        'phase1_runtime_fixture',
        'status'
      );

      CREATE TABLE IF NOT EXISTS workflow_compositions(id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS resource_runtime_policies (
        resource_table REGCLASS PRIMARY KEY,
        policy JSONB NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        updated_by TEXT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO resource_runtime_policies(resource_table, policy, updated_by)
      VALUES (
        'workflow_compositions'::regclass,
        '{"predicateMetadata":{}}'::jsonb,
        'phase1_fixture'
      )
      ON CONFLICT (resource_table) DO UPDATE
        SET policy = EXCLUDED.policy,
            version = resource_runtime_policies.version + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW();

      INSERT INTO runtime_semantic_entries
        (namespace, entry_key, platform, status, lifecycle_key, priority, payload)
      VALUES
        (
          'phase1_fixture',
          'workflow_interpreter',
          '*',
          'enabled_fixture',
          'phase1_runtime_fixture',
          100,
          '{
            "workflowInterpreterPolicy": {
              "distributionOpcodes": {"fixture_distribution": 0},
              "conditionOpcodes": {"fixture_condition": 0},
              "predicateOpcodes": {"fixture_predicate": 0},
              "failureOpcodes": {"fixture_fail": 0},
              "defaultFailureMode": "fixture_fail",
              "verificationOpcodes": {"local_with_screenshot": 0},
              "defaultVerificationMode": "local_with_screenshot",
              "runtimeDefaults": {
                "actionRetries": 0,
                "actionRetryDelayMs": 0,
                "actionDelayAfterMs": 0,
                "actionTimeoutMs": 15000,
                "pollIntervalMs": 1,
                "pollTimeoutMs": 1,
                "conditionProbability": 1,
                "regexGroup": 0,
                "recoveryAutonomy": "fixture_disabled",
                "recoveryAiEnabled": false,
                "recoveryMaxAttemptsPerStep": 0,
                "recoveryMaxAttemptsPerWorkflow": 0,
                "recoveryMaxActionsPerAttempt": 0,
                "recoveryAllowedRequests": [],
                "recoveryRequireStateVerification": false,
                "recoveryLearnFromFailure": false,
                "recoveryPlannerInstruction": "",
                "recoveryExecuteDecisionKey": "",
                "recoveryRetryDecisionKey": "",
                "recoveryAbortDecisionKey": "",
                "recoveryProbeActionKey": "fixture_probe",
                "recoveryProbeTimeoutMs": 1,
                "recoveryPlannerSystem": "",
                "recoveryPlannerMaxTokens": 1,
                "recoveryPlannerTimeoutMs": 1
              },
              "enginePolicy": {
                "maxNestedDepth": 1,
                "minActionTimeoutMs": 1,
                "captureTimeoutMs": 1,
                "defaultSubstepTimeoutMs": 1,
                "substepTimeoutPaddingMs": 1,
                "ackTimeoutMs": 60000,
                "progressSweepMs": 1000,
                "progressGraceMs": 1000,
                "minStaleMs": 1000,
                "maxStaleMs": 120000,
                "localStepBudgetMs": 15000
              }
            }
          }'::jsonb
        ),
        (
          'phase1_fixture',
          'open_app',
          '*',
          'enabled_fixture',
          'phase1_runtime_fixture',
          100,
          '{
            "jobActionPolicy": {
              "actionKey": "open_app",
              "allowed": true,
              "requiresRoot": false,
              "nativeOpcode": 0,
              "verificationOpcode": 0,
              "observationOnly": false,
              "defaultParams": {},
              "executionPolicy": {
                "verificationStrategy": "local_only",
                "l1TimeoutMs": 1,
                "l2SettleMs": 1
              },
              "parameterTransforms": []
            }
          }'::jsonb
        ),
        (
          'workflow_safety_policy',
          'standard',
          '*',
          'enabled_fixture',
          'phase1_runtime_fixture',
          100,
          '{
            "version": "phase1_v1",
            "requiresAdmissionLedger": false,
            "requireExplicitEffects": false,
            "scopeTemplate": "{{deviceId}}",
            "unitCost": 1,
            "allowedEffects": [],
            "requiredGoalStages": [],
            "requirePostcondition": false,
            "approval": {"required": false, "granted": false},
            "limits": []
          }'::jsonb
        );
    `);
    await pool.query(`
      INSERT INTO workflow_runtime_contracts (
        contract_id, schema_version, allowed_actions, limits, metadata
      ) VALUES (
        'phase1_test_contract',
        2,
        '["open_app"]'::jsonb,
        '{
          "maxSteps": 20,
          "maxNestedDepth": 2,
          "maxRetriesPerAction": 2,
          "maxStepTimeoutMs": 60000,
          "maxWorkflowTimeoutMs": 120000,
          "timingMode": "explicit_only",
          "serverStepFallback": false
        }'::jsonb,
        '{"fixture":true}'::jsonb
      )
    `);
    await ensureRouteCronCompatibilitySchema();
  });

  beforeEach(async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    await cleanupRows();
    await seedRows();
  });

  afterEach(async () => {
    setDeviceExecutionAuthorityForTest(null);
    const { directWsServer } = await import("../../src/ws/direct-ws.server");
    const internals = directWsServer as unknown as { connections: Map<string, unknown> };
    internals.connections.delete(DEVICE_ID);
    await cleanupRows();
  });

  afterAll(async () => {
    delete process.env.API_KEY;
    delete process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS;
    await pool?.end();
    const dbClient = await import("../../src/db/client");
    await dbClient.closeDb();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("sends once when the generated workflow API route and cron task target the same device", async () => {
    const sends: string[] = [];
    const { directWsServer } = await import("../../src/ws/direct-ws.server");
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
      }>;
    };
    internals.connections.set(DEVICE_ID, {
      ws: { readyState: 1, send: (message: string) => sends.push(message) },
      deviceId: DEVICE_ID,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastPongAt: Date.now(),
      msgCount: 0,
      windowStart: Date.now(),
      agentVersion: "4.0.0",
    });

    const apiRouter = (await import("../../src/api/routes")).default;
    const { executeTaskNow } = await import("../../src/modules/task-runner");
    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    const server = await listen(app);

    try {
      const routeResponse = await postJson(server, "/api/workflows/generated", {
        cacheKey: CACHE_KEY,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
      });

      expect(routeResponse.status, JSON.stringify(routeResponse.body)).toBe(202);
      expect(routeResponse.body).toMatchObject({
        ok: true,
        data: {
          status: "running",
          mode: "edge",
          cacheKey: CACHE_KEY,
        },
      });

      const cronResult = await executeTaskNow(TASK_ID);

      expect(cronResult).toMatchObject({
        success: false,
      });
      expect(sends).toHaveLength(1);
      const wireMessage = JSON.parse(sends[0]);
      expect(wireMessage).toMatchObject({
        type: "WORKFLOW_START",
        workflowId: routeResponse.body.data.workflowId,
      });
      expect(wireMessage.pnqHandle).toMatchObject({
        pnqDeviceId: DEVICE_ID,
        pnqOperationId: routeResponse.body.data.workflowId,
        pnqOperationKind: "workflow",
        pnqOwnerGeneration: 1,
        pnqRootKind: "edge_workflow",
      });
      expect(wireMessage.pnqHandle.pnqRootId).toEqual(expect.any(String));

      const rootCount = await pool.query(
        `SELECT state, COUNT(*)::int AS count
         FROM device_execution_roots
         WHERE device_id = $1 AND external_id = $2
         GROUP BY state`,
        [DEVICE_ID, routeResponse.body.data.workflowId],
      );
      expect(rootCount.rows).toEqual([{ state: "dispatched", count: 1 }]);

      const workflowCount = await pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM workflows
         WHERE device_id = $1
         GROUP BY status`,
        [DEVICE_ID],
      );
      expect(workflowCount.rows).toEqual([
        { status: "cancelled", count: 1 },
        { status: "running", count: 1 },
      ]);

      const task = await pool.query<{ status: string; failure_code: string | null }>(
        `SELECT status, result -> 'generatedWorkflow' ->> 'failureCode' AS failure_code
         FROM tasks
         WHERE id = $1`,
        [TASK_ID],
      );
      expect(task.rows).toEqual([{ status: "failed", failure_code: null }]);
    } finally {
      await close(server);
    }
  }, 10_000);
});

function workflow(): WorkflowTemplate {
  return {
    id: "agent_generated_pnq003_route_cron_v1",
    name: "PNQ003 route cron overlap",
    platform: "reddit",
    description: "Read-only route and cron overlap test workflow.",
    version: "1.0.0",
    runtimeContract: "phase1_test_contract",
    safetyClass: "standard",
    defaultVerificationStrategy: "local_with_screenshot",
    dataRetentionDays: 1,
    steps: [
      {
        type: "action",
        id: "open_reddit",
        action: "open_app",
        params: { packageName: "com.reddit.frontpage" },
        timeoutMs: 15000,
      },
      {
        type: "checkpoint",
        id: "opened",
        reason: "Application open request dispatched",
      },
    ],
  };
}

async function seedRows(): Promise<void> {
  const template = workflow();
  const compiledPlan = compileGeneratedWorkflowTemplate(template);
  await pool.query(
    `INSERT INTO devices (id, friendly_name, status, agent_version)
     VALUES ($1, 'pnq003-test-device', 'online', '4.0.0')`,
    [DEVICE_ID],
  );
  await pool.query(
    `INSERT INTO accounts (id, platform, username, device_id, status, simulated_timezone)
     VALUES ($1, 'reddit', 'pnq003_test_account', $2, 'active', 'fixture/timezone')`,
    [ACCOUNT_ID, DEVICE_ID],
  );
  await pool.query(
    `INSERT INTO workflow_templates
       (id, platform, definition, data_retention_days, default_verification_strategy)
     VALUES ($1, 'reddit', $2, 1, 'local_with_screenshot')`,
    [template.id, JSON.stringify(template)],
  );
  await pool.query(
    `INSERT INTO generated_workflow_plan_cache
       (cache_key, request_key, template_id, platform, template_version, workflow, compiled_plan,
        canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, source_metadata, artifact_state)
     VALUES ($1, $2, $3, 'reddit', $4, $5, $6, $3, $4, $7, $8, 'executable_fixture')`,
    [
      CACHE_KEY,
      REQUEST_KEY,
      template.id,
      template.version,
      JSON.stringify(template),
      JSON.stringify(compiledPlan),
      compiledPlan.cacheKey,
      JSON.stringify({
        source: "pnq003_real_route_cron_test",
        safetyClass: "standard",
      }),
    ],
  );
  await pool.query(
    `INSERT INTO tasks (id, account_id, device_id, routine, params, scheduled_time, status)
     VALUES ($1, $2, $3, 'generated_workflow', $4, NOW(), 'queued')`,
    [
      TASK_ID,
      ACCOUNT_ID,
      DEVICE_ID,
      JSON.stringify({ cacheKey: CACHE_KEY, deviceId: DEVICE_ID, platform: "reddit" }),
    ],
  );
}

async function cleanupRows(): Promise<void> {
  await pool.query(`DELETE FROM device_execution_events WHERE device_id = $1`, [DEVICE_ID]);
  await pool.query(`DELETE FROM device_execution_operations WHERE device_id = $1`, [DEVICE_ID]);
  await pool.query(`DELETE FROM device_execution_roots WHERE device_id = $1`, [DEVICE_ID]);
  await pool.query(`DELETE FROM tasks WHERE id = $1 OR device_id = $2`, [TASK_ID, DEVICE_ID]);
  await pool.query(`DELETE FROM workflows WHERE device_id = $1`, [DEVICE_ID]);
  await pool.query(`DELETE FROM generated_workflow_plan_cache WHERE cache_key = $1 OR request_key = $2`, [CACHE_KEY, REQUEST_KEY]);
  await pool.query(`DELETE FROM workflow_templates WHERE id = $1`, [workflow().id]);
  await pool.query(`DELETE FROM accounts WHERE id = $1`, [ACCOUNT_ID]);
  await pool.query(`DELETE FROM devices WHERE id = $1`, [DEVICE_ID]);
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
    ) {
      return;
    }
    throw err;
  }
}

async function ensureRouteCronCompatibilitySchema(): Promise<void> {
  await pool.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS root_error_code TEXT,
      ADD COLUMN IF NOT EXISTS root_error_message TEXT,
      ADD COLUMN IF NOT EXISTS root_error_details JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT`);
  await pool.query(`
    ALTER TABLE workflows
      ADD COLUMN IF NOT EXISTS template_id TEXT,
      ADD COLUMN IF NOT EXISTS account_id UUID,
      ADD COLUMN IF NOT EXISTS current_step INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_steps INT,
      ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS hbe_params JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
  await pool.query(`ALTER TABLE workflows ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
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
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const response = await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.API_KEY!,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function assertSafeTestDatabase(connectionString: string): void {
  const dbName = new URL(connectionString).pathname.replace(/^\//, "");
  if (!/(pnq.*test|test.*pnq|pnq001|pnq003|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to use PostgreSQL database "${dbName}". Use a disposable PNQ/test database.`);
  }
}

function withSearchPath(connectionString: string, targetSchema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${targetSchema}`);
  return url.toString();
}

async function assertRealPostgres(db: Pool): Promise<void> {
  const result = await db.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toMatch(/PostgreSQL/i);
}
