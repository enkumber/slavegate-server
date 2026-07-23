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
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("stores domain contracts and compiler policy idempotently in PostgreSQL", async () => {
    const migration = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/099_db_authoritative_workflow_semantics.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);

    const capabilities = await pool.query(
      `SELECT capability_key, platform, safety_class, metadata->'goalContract' AS goal_contract
       FROM workflow_capabilities
       WHERE capability_key = ANY($1::text[])
       ORDER BY capability_key`,
      [["device_unlock", "reddit_account_health_scan"]],
    );
    expect(capabilities.rows).toHaveLength(2);
    expect(capabilities.rows.every((row) => row.goal_contract?.version === "1")).toBe(true);

    const policy = await pool.query(
      `SELECT content FROM system_prompts WHERE key = 'human_workflow_compiler_policy'`,
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0].content).toContain("supplied from PostgreSQL");
    expect(policy.rows[0].content).toContain("Never infer an application package");

    const semanticEntries = await pool.query(
      `SELECT namespace, COUNT(*)::int AS count
       FROM runtime_semantic_entries
       GROUP BY namespace
       ORDER BY namespace`,
    );
    expect(semanticEntries.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: "account_detection_rule" }),
      expect.objectContaining({ namespace: "incident_routing_rule" }),
      expect.objectContaining({ namespace: "tool_catalog" }),
      expect.objectContaining({ namespace: "vision_prompt" }),
    ]));
  });
});
