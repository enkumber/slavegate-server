import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const postgresUrl = process.env.PNQ001_PG_URL ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const repoRoot = path.resolve(__dirname, "..");
let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("hybrid edge learning receipt migration", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `edge_learning_hybrid_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE workflows (id UUID PRIMARY KEY);
      CREATE TABLE ui_graph_learning_candidates (id UUID PRIMARY KEY);
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("upgrades legacy receipts and deduplicates by workflow, binding and checkpoint", async () => {
    const legacy = fs.readFileSync(path.join(repoRoot, "src/db/migrations/092_edge_workflow_learning_receipts.sql"), "utf8");
    const hybrid = fs.readFileSync(path.join(repoRoot, "src/db/migrations/093_edge_workflow_learning_receipts_hybrid.sql"), "utf8");
    await pool.query(legacy);
    await pool.query(`
      INSERT INTO workflows VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO ui_graph_learning_candidates VALUES ('22222222-2222-4222-8222-222222222222');
      INSERT INTO ui_graph_edge_learning_receipts (workflow_id, candidate_id, outcome)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'success');
    `);
    await pool.query(hybrid);
    await pool.query(hybrid);

    const legacyRow = await pool.query("SELECT binding_id, checkpoint_key FROM ui_graph_edge_learning_receipts");
    expect(legacyRow.rows[0]).toEqual({
      binding_id: "22222222-2222-4222-8222-222222222222",
      checkpoint_key: "legacy",
    });

    await pool.query(`
      INSERT INTO ui_graph_edge_learning_receipts
        (workflow_id, binding_id, checkpoint_key, candidate_id, outcome)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'elb_new', '5', '22222222-2222-4222-8222-222222222222', 'success');
    `);
    await expect(pool.query(`
      INSERT INTO ui_graph_edge_learning_receipts
        (workflow_id, binding_id, checkpoint_key, candidate_id, outcome)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'elb_new', '5', '22222222-2222-4222-8222-222222222222', 'success');
    `)).rejects.toMatchObject({ code: "23505" });
  });
});
