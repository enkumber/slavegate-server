import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client";
import { getDailyAuditSnapshot } from "../src/modules/incidents/incident.service";

const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let schema = "";
let previousDatabaseUrl: string | undefined;

describe("incident daily audit PostgreSQL bindings", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }

    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query("SELECT version()");
    if (!String(version.rows[0]?.version ?? "").includes("PostgreSQL")) {
      throw new Error("incident audit integration test requires real PostgreSQL");
    }

    schema = `incident_daily_audit_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(postgresUrl);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: isolated.toString(), max: 2 });

    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        dispatchable BOOLEAN NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE runtime_semantic_entries (
        id UUID PRIMARY KEY,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE TABLE tasks (
        status TEXT NOT NULL,
        scheduled_time TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE workflow_runs (
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE generated_workflow_plan_cache (
        cache_key TEXT NOT NULL,
        template_id TEXT,
        platform TEXT,
        artifact_state TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL,
        workflow JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE ui_graph_learning_candidates (
        id UUID PRIMARY KEY,
        candidate_key TEXT NOT NULL,
        app_id TEXT,
        candidate_type TEXT NOT NULL,
        status TEXT NOT NULL,
        discovery_method TEXT,
        confidence DOUBLE PRECISION,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        safety_class TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        first_observed_at TIMESTAMPTZ,
        last_observed_at TIMESTAMPTZ,
        promoted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE phone_network_incidents (
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        last_detected_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE ui_graph_action_events (
        id UUID PRIMARY KEY,
        step_id TEXT,
        workflow_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        vlm_calls INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE OR REPLACE FUNCTION lifecycle_state_matches(
        resource_table REGCLASS,
        current_status TEXT,
        selector JSONB
      ) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT current_status = 'promoted'
      $$;
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS NOT NULL,
        state_column NAME NOT NULL,
        lifecycle_key TEXT NOT NULL
      );

      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, dispatchable)
      VALUES
        ('runtime_semantic_entry', 'active', TRUE),
        ('candidate_lifecycle', 'promoted', TRUE);
      INSERT INTO lifecycle_resource_bindings
        (resource_table, state_column, lifecycle_key)
      VALUES
        ('ui_graph_learning_candidates'::regclass, 'status', 'candidate_lifecycle');
      INSERT INTO runtime_semantic_entries
        (id, namespace, entry_key, lifecycle_key, status, priority, payload)
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'incident_operations',
        'daily_audit',
        'runtime_semantic_entry',
        'active',
        100,
        '{"incidentAuditPolicy":{
          "maximumRetryCount":2,
          "defaultTimezone":"Europe/Bucharest",
          "allowedTimezones":["Europe/Bucharest","UTC"],
          "defaultActor":"phone-network",
          "incidentCommander":"kraken",
          "recoveryExhausted":true,
          "eventTypes":{
            "created":"created",
            "reopened":"reopened",
            "superseded":"superseded",
            "ownershipChanged":"ownership_changed"
          }
        }}'::jsonb
      );
    `);

    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = isolated.toString();
  });

  afterAll(async () => {
    await closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("executes every audit query with its exact PostgreSQL parameter arity", async () => {
    const snapshot = await getDailyAuditSnapshot("2026-07-30", "Europe/Bucharest");

    expect(snapshot).toMatchObject({
      date: "2026-07-30",
      timezone: "Europe/Bucharest",
      findings: [],
    });
  });
});
