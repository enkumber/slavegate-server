import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const postgresUrl = process.env.PNQ001_PG_URL ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const repoRoot = path.resolve(__dirname, "..");
let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("Phone Network incident and audit migration", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `phone_network_incidents_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE devices (id UUID PRIMARY KEY);
      CREATE TABLE tasks (
        id UUID PRIMARY KEY,
        device_id UUID,
        account_id UUID,
        routine TEXT,
        params JSONB NOT NULL DEFAULT '{}'::jsonb,
        scheduled_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE generated_workflow_plan_cache (
        cache_key TEXT PRIMARY KEY,
        artifact_state TEXT NOT NULL,
        workflow JSONB NOT NULL DEFAULT '{}'::jsonb,
        compiled_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("applies idempotently and keeps one incident per terminal source", async () => {
    const sql = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/094_phone_network_incidents_and_audits.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    await pool.query(`
      INSERT INTO devices VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO tasks VALUES ('22222222-2222-4222-8222-222222222222');
      INSERT INTO phone_network_incidents (
        incident_key, source_type, source_id, task_id, device_id, category, severity,
        status, assigned_agent, recovery_exhausted, summary
      ) VALUES (
        'task:22222222-2222-4222-8222-222222222222', 'task',
        '22222222-2222-4222-8222-222222222222',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'fixture_category', 'fixture_severity', 'test_open',
        'fixture_agent', TRUE, 'terminal failure'
      );
    `);
    await expect(pool.query(`
      INSERT INTO phone_network_incidents (
        incident_key, source_type, source_id, category, severity, status,
        assigned_agent, recovery_exhausted, summary
      )
      VALUES (
        'task:22222222-2222-4222-8222-222222222222', 'task', 'duplicate',
        'fixture_category', 'fixture_severity', 'test_open',
        'fixture_agent', TRUE, 'duplicate'
      )
    `)).rejects.toMatchObject({ code: "23505" });

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'phone_network_%'
      ORDER BY table_name
    `, [schema]);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "phone_network_audit_findings",
      "phone_network_audit_runs",
      "phone_network_incident_events",
      "phone_network_incidents",
    ]);
  });

  it("applies reconciliation ownership schema without product-semantic artifact rewrites", async () => {
    const baseSql = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/094_phone_network_incidents_and_audits.sql"),
      "utf8",
    );
    const sql = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/095_incident_reconciliation_and_artifact_safety.sql"),
      "utf8",
    );
    await pool.query(baseSql);
    await pool.query(`
      INSERT INTO generated_workflow_plan_cache (cache_key, artifact_state, workflow)
      VALUES
        ('read-only', 'promoted', '{"steps":[{"action":"ui_tree_dump"}]}'::jsonb),
        ('navigation', 'promoted', '{"steps":[{"action":"screen_wake"},{"action":"intent_send"}]}'::jsonb),
        ('unsafe', 'promoted', '{"steps":[{"action":"type_text"}]}'::jsonb)
      ON CONFLICT (cache_key) DO NOTHING
    `);

    await pool.query(sql);
    await pool.query(sql);

    const artifacts = await pool.query(`
      SELECT cache_key, artifact_state,
             COALESCE(
               compiled_plan #>> '{metadata,safetyClass}',
               workflow ->> 'safetyClass',
               source_metadata ->> 'safetyClass'
             ) AS safety_class
      FROM generated_workflow_plan_cache
      ORDER BY cache_key
    `);
    expect(artifacts.rows).toEqual([
      { cache_key: "navigation", artifact_state: "promoted", safety_class: null },
      { cache_key: "read-only", artifact_state: "promoted", safety_class: null },
      { cache_key: "unsafe", artifact_state: "promoted", safety_class: null },
    ]);

    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'phone_network_incidents'
        AND column_name IN (
          'incident_commander', 'remediation_owner', 'recovery_budget',
          'task_retry_attempts', 'superseded_by_task_id'
        )
      ORDER BY column_name
    `, [schema]);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "incident_commander",
      "recovery_budget",
      "remediation_owner",
      "superseded_by_task_id",
      "task_retry_attempts",
    ]);
  });
});
