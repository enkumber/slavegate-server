import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionTask } from "../src/modules/task-lifecycle/task-lifecycle.service";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.TASK_LIFECYCLE_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
let adminPool: Pool;
let pool: Pool;
let schema = "";

function migration(name: string): string {
  return fs.readFileSync(path.join(repoRoot, "src/db/migrations", name), "utf8");
}

describe("policy-free task lifecycle on real PostgreSQL", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `task_lifecycle_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE tasks (
        id UUID PRIMARY KEY,
        status TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        retry_count INTEGER NOT NULL DEFAULT 0,
        result JSONB,
        error TEXT,
        root_error_code TEXT,
        root_error_message TEXT,
        root_error_details JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE jobs (id UUID PRIMARY KEY, status TEXT);
    `);
    await pool.query(migration("105_generic_resource_lifecycle.sql"));
    await pool.query(migration("107_lifecycle_resource_bindings.sql"));
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("installs no lifecycle semantics on a fresh database", async () => {
    const definitions = await pool.query("SELECT COUNT(*)::int AS count FROM lifecycle_state_definitions");
    const transitions = await pool.query("SELECT COUNT(*)::int AS count FROM lifecycle_transitions");
    const bindings = await pool.query("SELECT COUNT(*)::int AS count FROM lifecycle_resource_bindings");
    expect(definitions.rows[0].count).toBe(0);
    expect(transitions.rows[0].count).toBe(0);
    expect(bindings.rows[0].count).toBe(0);
  });

  it("accepts arbitrary DB-only policy and executes it without a code change", async () => {
    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order)
      VALUES
        ('test_alpha', 'cold', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 1),
        ('test_alpha', 'hot', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 2),
        ('test_alpha', 'ash', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 3);
      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, mark_started)
      VALUES ('test_alpha', 'ignite', 'cold', 'hot', TRUE);
      SELECT configure_lifecycle_resource_binding('tasks'::regclass, 'test_alpha');
    `);

    const id = "10000000-0000-4000-8000-000000000001";
    const inserted = await pool.query("INSERT INTO tasks (id) VALUES ($1) RETURNING lifecycle_key, status", [id]);
    expect(inserted.rows[0]).toEqual({ lifecycle_key: "test_alpha", status: "cold" });

    const transitioned = await transitionTask(
      id,
      { targetTerminal: false, targetDispatchable: false, transitionMarkStarted: true },
      {},
      pool,
    );
    expect(transitioned?.status).toBe("hot");
    expect(transitioned?.started_at).toBeInstanceOf(Date);
  });

  it("preserves operator policy when structural migrations rerun", async () => {
    await pool.query("UPDATE lifecycle_state_definitions SET description = 'operator-owned' WHERE lifecycle_key = 'test_alpha' AND status = 'hot'");
    await pool.query(migration("105_generic_resource_lifecycle.sql"));
    await pool.query(migration("107_lifecycle_resource_bindings.sql"));
    const row = await pool.query("SELECT description FROM lifecycle_state_definitions WHERE lifecycle_key = 'test_alpha' AND status = 'hot'");
    expect(row.rows[0].description).toBe("operator-owned");
  });
});
