import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.GENERATED_WORKFLOW_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let schema = "";
let pool: Pool;

describe("generic workflow segment PostgreSQL migration", () => {
  beforeAll(async () => {
    if (postgresUrl === process.env.DATABASE_URL) {
      throw new Error("workflow segment test database must not be the production DATABASE_URL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `workflow_segments_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/schema.sql"), "utf8"));
    for (const migration of [
      "032_generated_workflow_plan_cache.sql",
      "034_generated_workflow_request_key.sql",
      "035_generated_workflow_canonical_artifact.sql",
      "060_generated_workflow_artifact_lifecycle.sql",
      "096_workflow_capability_catalog.sql",
    ]) {
      await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", migration), "utf8"));
    }
    await pool.query(`
      CREATE TABLE app_runtime_profiles (
        app_id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        package_name TEXT NOT NULL UNIQUE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("creates only generic segment/composition lifecycle schema and is idempotent", async () => {
    const migrations = [
      "099_db_authoritative_workflow_semantics.sql",
      "100_postgres_compiler_control_plane.sql",
      "101_generic_workflow_segments.sql",
      "102_segment_builder_agent_jobs.sql",
    ].map((name) => fs.readFileSync(path.join(repoRoot, "src/db/migrations", name), "utf8"));
    for (const migration of migrations) {
      await pool.query(migration);
      await pool.query(migration);
    }

    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name LIKE 'workflow_%'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      "workflow_segments",
      "workflow_segment_versions",
      "workflow_compositions",
      "workflow_composition_nodes",
      "workflow_execution_bindings",
      "workflow_segment_coverage",
      "workflow_control_plane_events",
    ]));
    const builderTables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN (
           'segment_build_jobs',
           'segment_build_job_events',
           'segment_builder_dispatchers'
         )
       ORDER BY table_name`,
    );
    expect(builderTables.rows.map((row) => row.table_name)).toEqual([
      "segment_build_job_events",
      "segment_build_jobs",
      "segment_builder_dispatchers",
    ]);

    const migrationText = migrations.join("\n").toLowerCase();
    for (const forbidden of ["chrome", "reddit", "instagram", "google.com", "ciprianneculai"]) {
      expect(migrationText).not.toContain(forbidden);
    }
  });

  it("enforces one promoted version per segment and capability composition", async () => {
    await pool.query(
      `INSERT INTO workflow_capabilities(capability_key, platform, safety_class)
       VALUES ('fixture_capability', 'android', 'navigation')`,
    );
    await pool.query(
      `INSERT INTO workflow_segments(segment_key) VALUES ('fixture_segment')`,
    );
    const template = {
      id: "fixture",
      name: "fixture",
      platform: "android",
      description: "fixture",
      version: "1",
      steps: [{ type: "action", action: "screen_wake" }],
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 1,
    };
    const schema = { type: "object", required: [], properties: {} };
    for (const version of ["1", "2"]) {
      await pool.query(
        `INSERT INTO workflow_segment_versions
           (segment_key, version, platform, lifecycle_status, template, input_schema, fingerprint)
         VALUES ('fixture_segment',$1,'android',$2,$3::jsonb,$4::jsonb,$5)`,
        [version, version === "1" ? "promoted" : "candidate", JSON.stringify(template), JSON.stringify(schema), version.repeat(64)],
      );
    }
    await expect(pool.query(
      `UPDATE workflow_segment_versions SET lifecycle_status='promoted'
       WHERE segment_key='fixture_segment' AND version='2'`,
    )).rejects.toThrow();
  });
});
