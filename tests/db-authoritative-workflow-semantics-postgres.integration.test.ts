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

describe("DB-authoritative AI workflow semantics migration", () => {
  beforeAll(async () => {
    if (postgresUrl === process.env.DATABASE_URL) {
      throw new Error("workflow semantics test database must not be the production DATABASE_URL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query("SELECT version()");
    if (!String(version.rows[0]?.version ?? "").includes("PostgreSQL")) {
      throw new Error("workflow semantics integration test requires real PostgreSQL");
    }
    schema = `db_authoritative_workflow_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2 });

    await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/schema.sql"), "utf8"));
    for (const migration of [
      "030_system_prompts.sql",
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
        package_name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'android',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("installs schema and generic resolvers idempotently without seeding semantics", async () => {
    const baselineCapabilities = Number((await pool.query("SELECT COUNT(*)::int AS count FROM workflow_capabilities")).rows[0].count);
    const baselinePrompts = Number((await pool.query("SELECT COUNT(*)::int AS count FROM system_prompts")).rows[0].count);
    for (const filename of [
      "099_db_authoritative_workflow_semantics.sql",
      "100_postgres_compiler_control_plane.sql",
      "122_platform_identifier_aliases.sql",
    ]) {
      const migration = fs.readFileSync(
        path.join(repoRoot, "src/db/migrations", filename),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
    }

    expect(Number((await pool.query("SELECT COUNT(*)::int AS count FROM workflow_capabilities")).rows[0].count))
      .toBe(baselineCapabilities);
    expect((await pool.query("SELECT * FROM runtime_semantic_entries")).rows).toHaveLength(0);
    expect(Number((await pool.query("SELECT COUNT(*)::int AS count FROM system_prompts")).rows[0].count))
      .toBe(baselinePrompts);

    await pool.query(
      `INSERT INTO app_runtime_profiles (app_id, app_name, package_name, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      ["sample_app", "Sample Application", "org.example.sample", JSON.stringify({
        compilerAliases: ["sample surface"],
      })],
    );
    await pool.query(
      `INSERT INTO workflow_capabilities (
         capability_key, platform, description, aliases, required_terms,
         safety_class, portability_scope, compiler_retrievable,
         min_match_score, ambiguity_margin, metadata
       )
       VALUES ($1, $2, $3, $4::text[], $5::text[], 'read_only', 'global', TRUE, 0.2, 0.05, $6::jsonb)`,
      [
        "inspect_sample_surface",
        "sample_app",
        "Inspect the sample surface",
        ["inspect sample surface"],
        ["inspect"],
        JSON.stringify({ configuredLive: true }),
      ],
    );

    const platform = await pool.query(
      `SELECT * FROM resolve_human_workflow_platform($1)`,
      ["inspect the sample surface"],
    );
    expect(platform.rows).toEqual([
      expect.objectContaining({
        app_id: "sample_app",
        package_name: "org.example.sample",
      }),
    ]);

    const resolved = await pool.query(
      `SELECT capability_key, selected, metadata
       FROM resolve_workflow_capabilities($1, $2)`,
      ["inspect sample surface", "sample_app"],
    );
    expect(resolved.rows).toEqual([
      {
        capability_key: "inspect_sample_surface",
        selected: true,
        metadata: { configuredLive: true },
      },
    ]);

    expect((await pool.query("SELECT * FROM runtime_semantic_entries")).rows).toHaveLength(0);
  });

  it("canonicalizes platform identifiers through generic PostgreSQL mappings and fails closed", async () => {
    await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", "100_postgres_compiler_control_plane.sql"), "utf8"));
    await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", "122_platform_identifier_aliases.sql"), "utf8"));

    await pool.query("TRUNCATE platform_identifier_aliases, app_runtime_profiles");
    await pool.query(
      `INSERT INTO app_runtime_profiles (app_id, app_name, package_name, metadata)
       VALUES
         ('canonical_app', 'Canonical App', 'org.example.canonical', '{}'::jsonb),
         ('other_app', 'Other App', 'org.example.other', '{}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO platform_identifier_aliases(alias, canonical_platform)
       VALUES ('friendly app', 'canonical_app')`,
    );

    await expect(pool.query(
      `INSERT INTO platform_identifier_aliases(alias, canonical_platform)
       VALUES ('FRIENDLY APP', 'canonical_app')`,
    )).rejects.toThrow();

    await expect(pool.query(
      `INSERT INTO platform_identifier_aliases(alias, canonical_platform)
       VALUES ('friendly app', 'other_app')`,
    )).rejects.toThrow();

    const byAlias = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", [" friendly APP "]);
    expect(byAlias.rows).toEqual([{ canonical_platform: "canonical_app" }]);

    const byPackage = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", ["ORG.EXAMPLE.CANONICAL"]);
    expect(byPackage.rows).toEqual([{ canonical_platform: "canonical_app" }]);

    const byCanonical = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", ["canonical_app"]);
    expect(byCanonical.rows).toEqual([{ canonical_platform: "canonical_app" }]);

    const missing = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", ["missing"]);
    expect(missing.rows).toHaveLength(0);

    await pool.query(
      `INSERT INTO platform_identifier_aliases(alias, canonical_platform)
       VALUES ('canonical_app', 'other_app')`,
    );
    const ambiguous = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", ["canonical_app"]);
    expect(ambiguous.rows).toHaveLength(0);

    await pool.query("UPDATE platform_identifier_aliases SET active = FALSE WHERE alias = 'canonical_app'");
    await pool.query("UPDATE app_runtime_profiles SET active = FALSE WHERE app_id = 'canonical_app'");
    const disabled = await pool.query("SELECT * FROM resolve_canonical_platform_identifier($1)", ["canonical_app"]);
    expect(disabled.rows).toHaveLength(0);
  });
});
