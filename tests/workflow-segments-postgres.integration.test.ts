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
    // Reproduce the table shape installed by the earlier revision of migration
    // 101. The current migration must evolve it rather than assuming a fresh
    // schema created from the latest file.
    await pool.query(`
      CREATE TABLE workflow_segments (
        segment_key TEXT PRIMARY KEY,
        description TEXT NULL,
        status TEXT NOT NULL DEFAULT 'legacy_initial'
          CHECK (status IN ('legacy_initial', 'legacy_retired')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE workflow_segment_versions (
        segment_key TEXT NOT NULL REFERENCES workflow_segments(segment_key) ON DELETE CASCADE,
        version TEXT NOT NULL,
        platform TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'legacy_candidate'
          CHECK (lifecycle_status IN ('legacy_candidate', 'legacy_selected')),
        template JSONB NOT NULL,
        input_schema JSONB NOT NULL,
        output_schema JSONB NULL,
        postcondition_contract JSONB NULL,
        compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
        fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (segment_key, version)
      );
      CREATE UNIQUE INDEX legacy_segment_resolution_policy
        ON workflow_segment_versions(segment_key, platform)
        WHERE lifecycle_status = 'legacy_selected';
    `);

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
    const upgradedColumn = await pool.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'workflow_segment_versions'
          AND column_name = 'active_for_resolution'`,
    );
    expect(upgradedColumn.rows).toHaveLength(1);
    expect(upgradedColumn.rows[0].is_nullable).toBe("NO");
    const legacyPolicy = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'legacy_segment_resolution_policy'`,
    );
    expect(legacyPolicy.rows[0].count).toBe(0);
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
      `INSERT INTO workflow_capabilities(
         capability_key, platform, safety_class, portability_scope, compiler_retrievable,
         min_match_score, ambiguity_margin
       )
       VALUES ('fixture_capability', 'android', 'navigation', 'global', TRUE, 0.8, 0.1)`,
    );
    await pool.query(
      `INSERT INTO workflow_segments(segment_key, status)
       VALUES ('fixture_segment', 'fixture_available')`,
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
           (segment_key, version, platform, lifecycle_status, active_for_resolution,
            template, input_schema, fingerprint)
         VALUES ('fixture_segment',$1,'android',$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [
          version,
          version === "1" ? "fixture_selected" : "fixture_candidate",
          version === "1",
          JSON.stringify(template),
          JSON.stringify(schema),
          version.repeat(64),
        ],
      );
    }
    await expect(pool.query(
      `UPDATE workflow_segment_versions SET active_for_resolution=TRUE
       WHERE segment_key='fixture_segment' AND version='2'`,
    )).rejects.toThrow();
  });
});
