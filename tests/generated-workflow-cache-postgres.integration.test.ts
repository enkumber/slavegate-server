import express from "express";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.GENERATED_WORKFLOW_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const API_KEY = "generated-workflow-cache-test-key";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_KEY = "aaaaaaaaaaaaaaaaaaaaaaaa";

let adminPool: Pool;
let schema = "";
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalApiKey = process.env.API_KEY;
const originalJwtSecret = process.env.JWT_SECRET;

vi.mock("../src/ws/direct-ws.server", () => ({
  directWsServer: {
    getConnectedDeviceIds: vi.fn(() => [DEVICE_ID]),
    getAgentVersion: vi.fn(() => null),
    supportsEdgeExecution: vi.fn(() => false),
  },
}));

vi.mock("../src/modules/workflows/workflow.executor", () => ({
  startWorkflow: vi.fn(async () => undefined),
}));

describe("generated workflow cache PostgreSQL contract", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `generated_workflow_cache_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);

    process.env.API_KEY = API_KEY;
    process.env.JWT_SECRET = "generated-workflow-cache-test-jwt";
    process.env.DATABASE_URL = withSearchPath(postgresUrl, schema);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    try {
      await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/schema.sql"), "utf8"));
      for (const migration of [
        "032_generated_workflow_plan_cache.sql",
        "034_generated_workflow_request_key.sql",
        "035_generated_workflow_canonical_artifact.sql",
        "060_generated_workflow_artifact_lifecycle.sql",
        "088_app_runtime_profiles.sql",
        "090_edge_workflow_runtime_contract.sql",
        "096_workflow_capability_catalog.sql",
      ]) {
        await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", migration), "utf8"));
      }
      await pool.query(
        `INSERT INTO devices (id, hardware_uuid, imei, friendly_name, model, status)
         VALUES ($1, $2, $3, 'PG cache device', 'test', 'approved')`,
        [DEVICE_ID, "pg-cache-device", "pg-cache-imei"],
      );
      await pool.query(`
        CREATE TABLE lifecycle_state_definitions (
          lifecycle_key TEXT NOT NULL,
          status TEXT NOT NULL,
          initial BOOLEAN NOT NULL,
          terminal BOOLEAN NOT NULL,
          retryable BOOLEAN NOT NULL,
          administrative BOOLEAN NOT NULL,
          dispatchable BOOLEAN NOT NULL,
          manual BOOLEAN NOT NULL,
          stale_after_ms BIGINT,
          stale_action_key TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          description TEXT,
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
      `);
      await pool.query(fs.readFileSync(
        path.join(repoRoot, "src/db/migrations/110_generic_lifecycle_queries.sql"),
        "utf8",
      ));
      await pool.query(`
        INSERT INTO lifecycle_state_definitions
          (lifecycle_key, status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order)
        VALUES
          ('generated_cache_fixture', 'candidate_fixture', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE, 10),
          ('generated_cache_fixture', 'executable_fixture', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 20);
        INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
        VALUES (
          'generated_workflow_plan_cache'::regclass,
          'generated_cache_fixture',
          'artifact_state'
        );

        INSERT INTO workflow_runtime_contracts
          (contract_id, schema_version, allowed_actions, limits, metadata)
        VALUES (
          'edge-workflow/v2',
          2,
          '["open_app","screenshot"]'::jsonb,
          '{"maxSteps":20}'::jsonb,
          '{"fixture":true}'::jsonb
        )
      `);
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client");
    await closeDb();
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
    restoreEnv("API_KEY", originalApiKey);
    restoreEnv("JWT_SECRET", originalJwtSecret);
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("persists and reads a cache artifact, then refuses server fallback without an edge agent", async () => {
    const persisted = await postJson("/api/workflows/generated", {
      workflow: generatedWorkflow(),
      requestKey: REQUEST_KEY,
      dryRun: true,
      persist: true,
    });

    expect(persisted.status, JSON.stringify(persisted.body)).toBe(200);
    expect(persisted.body.data).toMatchObject({
      persisted: true,
      artifactState: "executable_fixture",
      requestKey: REQUEST_KEY,
      canExecuteFromCache: true,
    });
    const cacheKey = persisted.body.data.cacheKey;
    expect(cacheKey).toMatch(/^[a-f0-9]{24}$/);

    const cached = await getJson(`/api/workflows/generated/cache/${cacheKey}`);
    expect(cached.status, JSON.stringify(cached.body)).toBe(200);
    expect(cached.body.data).toMatchObject({
      cacheKey,
      requestKey: REQUEST_KEY,
      artifactState: "executable_fixture",
      canonicalWorkflowId: "pg_generated_cache_contract_v1",
    });

    const dispatched = await postJson("/api/workflows/generated", {
      cacheKey,
      deviceId: DEVICE_ID,
    });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(409);
    expect(dispatched.body).toMatchObject({
      ok: false,
      code: "EDGE_WORKFLOW_V2_UNSUPPORTED",
    });
  });
});

async function app() {
  const app = express();
  app.use(express.json());
  const imported = await import("../src/api/routes");
  app.use("/api", imported.default);
  return app;
}

async function postJson(pathname: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": API_KEY },
          body: JSON.stringify(body),
        });
        resolve({ status: response.status, body: await response.json() });
      } catch (err) {
        reject(err);
      } finally {
        listener.close();
      }
    });
  });
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
          method: "GET",
          headers: { "x-api-key": API_KEY },
        });
        resolve({ status: response.status, body: await response.json() });
      } catch (err) {
        reject(err);
      } finally {
        listener.close();
      }
    });
  });
}

function generatedWorkflow() {
  return {
    id: "pg_generated_cache_contract_v1",
    name: "PG generated cache contract",
    description: "Validates persisted generated workflow cache reads and dispatch.",
    version: "1.0.0",
    runtimeContract: "edge-workflow/v2",
    platform: "reddit",
    safetyClass: "read_only",
    intent: "reddit_account_health_scan",
    dataRetentionDays: 30,
    defaultVerificationStrategy: "local_with_screenshot",
    outputSchema: {
      required: [
        "loggedIn",
        "homeFeedVisible",
        "searchSurfaceAvailable",
        "challengeDetected",
        "loginWallDetected",
        "accountSwitcherVisible",
        "observedUsername",
        "screenState",
        "error",
      ],
      properties: {
        loggedIn: { type: "string" },
        homeFeedVisible: { type: "string" },
        searchSurfaceAvailable: { type: "string" },
        challengeDetected: { type: "string" },
        loginWallDetected: { type: "string" },
        accountSwitcherVisible: { type: "string" },
        observedUsername: { type: "string" },
        screenState: { type: "string" },
        error: { type: "string" },
      },
    },
    allowedRecoveryRequests: ["refresh_screen_state"],
    steps: [
      { id: "open_reddit", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
      { id: "capture", type: "action", action: "screenshot", params: { quality: 80 } },
    ],
  };
}

function withSearchPath(rawUrl: string, searchPath: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("options", `-c search_path=${searchPath}`);
  return url.toString();
}

function assertSafeTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against non-local host: ${parsed.hostname}`);
  }
  if (!/(test|pnq)/i.test(parsed.pathname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against suspicious database: ${parsed.pathname}`);
  }
}

async function assertRealPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toContain("PostgreSQL");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
