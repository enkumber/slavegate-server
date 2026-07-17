import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../../src/modules/workflows/types";
import { compileGeneratedWorkflowTemplate } from "../../src/modules/workflows/workflow-validator";
import { setDeviceExecutionAuthorityForTest } from "../../src/modules/device-execution";

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

describePostgres("PNQ-003 Phase 1 real route and cron/task-runner overlap", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    process.env.DATABASE_URL = postgresUrl;
    process.env.API_KEY = "pnq-003-test-api-key";
    process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS = "60000";

    const dbClient = await import("../../src/db/client");
    await dbClient.closeDb();
    pool = new Pool({ connectionString: postgresUrl, max: 6 });
    await assertRealPostgres(pool);
    await applySql("src/db/schema.sql");
    for (const file of [
      "src/db/migrations/011_marketing_agency.sql",
      "src/db/migrations/022_task_runner_columns.sql",
      "src/db/migrations/023_task_retry.sql",
      "src/db/migrations/032_generated_workflow_plan_cache.sql",
      "src/db/migrations/034_generated_workflow_request_key.sql",
      "src/db/migrations/035_generated_workflow_canonical_artifact.sql",
      "src/db/migrations/060_generated_workflow_artifact_lifecycle.sql",
      "src/db/migrations/081_device_execution_queue.sql",
    ]) {
      await applySql(file);
    }
    await ensureRouteCronCompatibilitySchema();
  });

  beforeEach(async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
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
        generatedWorkflow: {
          failureCode: "DEVICE_BUSY",
        },
      });
      expect(sends).toHaveLength(1);
      const wireMessage = JSON.parse(sends[0]);
      expect(wireMessage).toMatchObject({
        type: "WORKFLOW_START",
        workflowId: routeResponse.body.data.workflowId,
      });
      expect(wireMessage).not.toHaveProperty("pnqHandle");

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
      expect(workflowCount.rows).toEqual([{ status: "running", count: 1 }]);

      const task = await pool.query<{ status: string; failure_code: string | null }>(
        `SELECT status, result -> 'generatedWorkflow' ->> 'failureCode' AS failure_code
         FROM tasks
         WHERE id = $1`,
        [TASK_ID],
      );
      expect(task.rows).toEqual([{ status: "failed", failure_code: "DEVICE_BUSY" }]);
    } finally {
      await close(server);
    }
  });
});

function workflow(): WorkflowTemplate {
  return {
    id: "agent_generated_pnq003_route_cron_v1",
    name: "PNQ003 route cron overlap",
    platform: "reddit",
    description: "Read-only route and cron overlap test workflow.",
    version: "1.0.0",
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
    `INSERT INTO accounts (id, platform, username, device_id, status)
     VALUES ($1, 'reddit', 'pnq003_test_account', $2, 'active')`,
    [ACCOUNT_ID, DEVICE_ID],
  );
  await pool.query(
    `INSERT INTO generated_workflow_plan_cache
       (cache_key, request_key, template_id, platform, template_version, workflow, compiled_plan,
        canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, source_metadata, artifact_state)
     VALUES ($1, $2, $3, 'reddit', $4, $5, $6, $3, $4, $7, $8, 'promoted')`,
    [
      CACHE_KEY,
      REQUEST_KEY,
      template.id,
      template.version,
      JSON.stringify(template),
      JSON.stringify(compiledPlan),
      compiledPlan.cacheKey,
      JSON.stringify({ source: "pnq003_real_route_cron_test" }),
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

async function assertRealPostgres(db: Pool): Promise<void> {
  const result = await db.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toMatch(/PostgreSQL/i);
}
