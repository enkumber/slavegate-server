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

describe("workflow capability catalog PostgreSQL migration", () => {
  beforeAll(async () => {
    if (postgresUrl === process.env.DATABASE_URL) {
      throw new Error("capability catalog test database must not be the production DATABASE_URL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query("SELECT version()");
    if (!String(version.rows[0]?.version ?? "").includes("PostgreSQL")) {
      throw new Error("capability catalog integration test requires real PostgreSQL");
    }
    schema = `workflow_capability_catalog_${process.pid}_${Date.now()}`;
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
      "088_app_runtime_profiles.sql",
    ]) {
      await pool.query(fs.readFileSync(path.join(repoRoot, "src/db/migrations", migration), "utf8"));
    }
    await pool.query(
      `INSERT INTO generated_workflow_plan_cache (
         cache_key, request_key, canonical_workflow_id, canonical_workflow_version,
         compiled_plan_hash, artifact_state, source_metadata, template_id,
         platform, template_version, workflow, compiled_plan
       ) VALUES ($1, $2, $3, '1.0.0', $4, 'promoted', $5::jsonb, $3, 'android', '1.0.0', $6::jsonb, $7::jsonb)`,
      [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "remote_support_enable_screen_share_v1",
        "c".repeat(64),
        JSON.stringify({
          capabilityKey: "remote_support_enable_screen_share",
          capabilityAliases: ["pornește screen share"],
          portable: true,
          portabilityScope: "global",
          safetyClass: "standard",
          intent: "enable remote support screen share",
        }),
        JSON.stringify({
          id: "remote_support_enable_screen_share_v1",
          name: "Enable remote support screen sharing",
          description: "Verified portable trace",
          platform: "android",
          version: "1.0.0",
          safetyClass: "standard",
          steps: [],
        }),
        JSON.stringify({
          metadata: { safetyClass: "standard" },
          llmBudget: { happyPathRequests: 0 },
          steps: [],
        }),
      ],
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("creates an idempotent operator-managed capability catalog", async () => {
    const migration = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/096_workflow_capability_catalog.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
    await pool.query(`
      INSERT INTO workflow_capabilities (
        capability_key, platform, description, aliases, required_terms,
        forbidden_terms, safety_class, portability_scope, compiler_retrievable,
        status, min_match_score, ambiguity_margin
      ) VALUES (
        'remote_support_enable_screen_share', 'android',
        'Enable remote support screen sharing',
        ARRAY['enable remote support screen share', 'Enable remote support screen sharing'],
        ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'standard', 'global', TRUE,
        'active', 0.62, 0.12
      );
      INSERT INTO workflow_capability_artifacts (
        capability_key, cache_key, role, priority, status
      ) VALUES (
        'remote_support_enable_screen_share',
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'complete',
        100,
        'active'
      );
    `);

    const capability = await pool.query(
      `SELECT capability_key, platform, safety_class, portability_scope, aliases
       FROM workflow_capabilities
       WHERE capability_key = 'remote_support_enable_screen_share'`,
    );
    expect(capability.rows).toHaveLength(1);
    expect(capability.rows[0]).toMatchObject({
      platform: "android",
      safety_class: "standard",
      portability_scope: "global",
    });
    expect(capability.rows[0].aliases).toEqual(expect.arrayContaining([
      "enable remote support screen share",
      "Enable remote support screen sharing",
    ]));

    const binding = await pool.query(
      `SELECT capability_key, cache_key, role, status
       FROM workflow_capability_artifacts
       WHERE capability_key = 'remote_support_enable_screen_share'`,
    );
    expect(binding.rows).toEqual([{
      capability_key: "remote_support_enable_screen_share",
      cache_key: "aaaaaaaaaaaaaaaaaaaaaaaa",
      role: "complete",
      status: "active",
    }]);
  });

  it("matches a configured alias inside a detailed intent without bypassing PostgreSQL thresholds", async () => {
    await pool.query(fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/100_postgres_compiler_control_plane.sql"),
      "utf8",
    ));
    await pool.query(fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/121_capability_descriptor_coverage.sql"),
      "utf8",
    ));
    await pool.query(
      `UPDATE workflow_capabilities
          SET aliases = ARRAY['remote support screen share'],
              required_terms = ARRAY['remote support'],
              min_match_score = 0.62,
              ambiguity_margin = 0.12,
              compiler_retrievable = TRUE
        WHERE capability_key = 'remote_support_enable_screen_share'`,
    );

    const resolved = await pool.query(
      `SELECT capability_key, score, selected
         FROM resolve_workflow_capabilities($1, $2)`,
      [
        "Please enable remote support screen share on the connected device, verify the ready state, and keep the session private and reversible.",
        "android",
      ],
    );

    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]).toMatchObject({
      capability_key: "remote_support_enable_screen_share",
      selected: true,
    });
    expect(Number(resolved.rows[0].score)).toBe(1);
  });
});
