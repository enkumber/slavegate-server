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
      "088_app_runtime_profiles.sql",
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

  it("stores and resolves the complete compiler control plane idempotently in PostgreSQL", async () => {
    for (const filename of [
      "099_db_authoritative_workflow_semantics.sql",
      "100_postgres_compiler_control_plane.sql",
      "101_browser_direct_intent_contract.sql",
    ]) {
      const migration = fs.readFileSync(
        path.join(repoRoot, "src/db/migrations", filename),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
    }

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
    expect(policy.rows[0].content).toContain("Never derive a Goal Contract");
    expect(policy.rows[0].content).toContain("emit exactly three action steps");
    expect(policy.rows[0].content).toContain("Do not emit open_app");

    const browserCapability = await pool.query(
      `SELECT metadata->'goalContract' AS goal_contract
       FROM workflow_capabilities
       WHERE capability_key = 'web_open_absolute_uri'`,
    );
    expect(browserCapability.rows).toHaveLength(1);
    expect(browserCapability.rows[0].goal_contract.stages).toEqual([
      expect.objectContaining({
        id: "prepare_device",
        allowedActions: ["screen_wake", "unlock"],
      }),
      expect.objectContaining({
        id: "navigate_uri",
        allowedActions: ["intent_send"],
        after: ["prepare_device"],
      }),
    ]);

    const intentSend = await pool.query(
      `SELECT payload
       FROM runtime_semantic_entries
       WHERE namespace = 'tool_catalog' AND entry_key = 'intent_send'`,
    );
    expect(intentSend.rows[0].payload.inputSchema).toMatchObject({
      required: ["action", "uri", "packageName"],
    });

    const controlPlane = await pool.query(
      `SELECT payload
       FROM runtime_semantic_entries
       WHERE namespace = 'compiler_control_plane' AND entry_key = 'human_workflow_v1'`,
    );
    expect(controlPlane.rows).toHaveLength(1);
    expect(controlPlane.rows[0].payload).toMatchObject({
      missingCapabilityPolicy: "fail_closed",
      normalizationPolicy: "strict_reject",
    });

    const platform = await pool.query(
      `SELECT * FROM resolve_human_workflow_platform($1)`,
      ["deschide browserul chrome si mergi pe google.com"],
    );
    expect(platform.rows).toEqual([
      expect.objectContaining({
        app_id: "com.android.chrome",
        package_name: "com.android.chrome",
      }),
    ]);

    const resolved = await pool.query(
      `SELECT capability_key, selected
       FROM resolve_workflow_capabilities($1, $2)`,
      ["deschide browserul chrome si mergi pe google.com", "com.android.chrome"],
    );
    expect(resolved.rows).toEqual([
      { capability_key: "web_open_absolute_uri", selected: true },
    ]);

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
      expect.objectContaining({ namespace: "compiler_control_plane" }),
    ]));
  });
});
