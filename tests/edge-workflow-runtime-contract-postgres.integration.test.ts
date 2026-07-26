import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const migrationPath = path.join(repoRoot, "src/db/migrations/090_edge_workflow_runtime_contract.sql");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("edge workflow runtime contract PostgreSQL migration", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query<{ version: string }>("SELECT version()");
    expect(version.rows[0]?.version).toContain("PostgreSQL");

    schema = `edge_workflow_contract_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      options: `-c search_path=${schema}`,
    });

    await pool.query(`
      CREATE TABLE app_runtime_profiles (
        app_id TEXT PRIMARY KEY,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE generated_workflow_plan_cache (
        cache_key TEXT PRIMARY KEY,
        workflow JSONB NOT NULL,
        compiled_plan JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE workflow_templates (
        id TEXT PRIMARY KEY,
        definition JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE workflow_shortcuts (
        id TEXT PRIMARY KEY,
        workflow_template JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO app_runtime_profiles (app_id) VALUES ('test.app');
      INSERT INTO generated_workflow_plan_cache (cache_key, workflow, compiled_plan)
      VALUES ('legacy', '{"steps":[{"action":"legacy_app_opcode"}]}', '{}');
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("creates operator-managed contract schema idempotently without packaging product semantics", async () => {
    const migration = fs.readFileSync(migrationPath, "utf8");
    await pool.query(migration);
    await pool.query(migration);

    const contract = await pool.query<{
      allowed_actions: string[];
      limits: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }>(
      "SELECT allowed_actions, limits, metadata FROM workflow_runtime_contracts WHERE contract_id = 'edge-workflow/v2'",
    );
    expect(contract.rows).toEqual([]);

    const profile = await pool.query<{ workflow_policy: Record<string, unknown> }>(
      "SELECT workflow_policy FROM app_runtime_profiles WHERE app_id = 'test.app'",
    );
    expect(profile.rows[0]?.workflow_policy).toEqual({});

    await pool.query(`
      INSERT INTO workflow_runtime_contracts
        (contract_id, schema_version, allowed_actions, limits, metadata)
      VALUES (
        'fixture-contract',
        1,
        '["fixture_action"]'::jsonb,
        '{"maxSteps":3}'::jsonb,
        '{"operatorManaged":true}'::jsonb
      )
    `);
    await pool.query(migration);
    const operatorContract = await pool.query(
      `SELECT allowed_actions, limits, metadata
         FROM workflow_runtime_contracts
        WHERE contract_id = 'fixture-contract'`,
    );
    expect(operatorContract.rows[0]).toMatchObject({
      allowed_actions: ["fixture_action"],
      limits: { maxSteps: 3 },
      metadata: { operatorManaged: true },
    });

    const legacy = await pool.query<{ workflow: Record<string, unknown> }>(
      "SELECT workflow FROM generated_workflow_plan_cache WHERE cache_key = 'legacy'",
    );
    expect(legacy.rows[0]?.workflow).toEqual({ steps: [{ action: "legacy_app_opcode" }] });
  });
});

function assertSafeTestDatabase(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against non-local host: ${parsed.hostname}`);
  }
  if (!/(test|pnq)/i.test(parsed.pathname)) {
    throw new Error(`Refusing to run PostgreSQL integration test against suspicious database: ${parsed.pathname}`);
  }
}
