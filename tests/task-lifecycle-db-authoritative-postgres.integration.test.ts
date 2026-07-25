import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  retryConfiguredTasks,
  transitionTask,
} from "../src/modules/task-lifecycle/task-lifecycle.service";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.TASK_LIFECYCLE_PG_URL
  ?? "postgresql://postgres@127.0.0.1:55432/postgres";

let adminPool: Pool;
let schema = "";
let pool: Pool;

function lifecycleMigration(): string {
  return fs.readFileSync(
    path.join(repoRoot, "src/db/migrations/104_task_lifecycle_db_authoritative.sql"),
    "utf8",
  );
}

async function createBaseTaskTable(): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS task_status_transitions CASCADE;
    DROP TABLE IF EXISTS task_status_definitions CASCADE;
    DROP FUNCTION IF EXISTS set_initial_task_status() CASCADE;

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
    )
  `);
}

describe("DB-authoritative task lifecycle", () => {
  beforeAll(async () => {
    if (postgresUrl === process.env.DATABASE_URL) {
      throw new Error("task lifecycle test database must not be the production DATABASE_URL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    const version = await adminPool.query("SELECT version()");
    if (!String(version.rows[0]?.version ?? "").includes("PostgreSQL")) {
      throw new Error("task lifecycle integration test requires real PostgreSQL");
    }
    schema = `task_lifecycle_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2 });
  });

  beforeEach(async () => {
    await createBaseTaskTable();
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("installs idempotently and resolves initial state from DB", async () => {
    const migration = lifecycleMigration();
    await pool.query(migration);
    await pool.query(migration);

    const id = "10000000-0000-4000-8000-000000000001";
    const inserted = await pool.query(
      `INSERT INTO tasks (id) VALUES ($1) RETURNING status`,
      [id],
    );
    const initial = await pool.query(
      `SELECT status FROM task_status_definitions WHERE initial`,
    );
    expect(inserted.rows[0].status).toBe(initial.rows[0].status);

    await expect(
      pool.query(
        `INSERT INTO tasks (id, status) VALUES ($1, $2)`,
        ["10000000-0000-4000-8000-000000000002", "not_configured"],
      ),
    ).rejects.toThrow();
  });

  it("preserves customized lifecycle metadata and transitions on migration rerun", async () => {
    const migration = lifecycleMigration();
    await pool.query(migration);
    await pool.query(
      `UPDATE task_status_definitions
          SET terminal = TRUE,
              retryable = FALSE,
              dispatchable = FALSE,
              manual = FALSE,
              description = 'operator configured queued',
              sort_order = 999
        WHERE status = 'queued'`,
    );
    await pool.query(
      `UPDATE task_status_transitions
          SET to_status = 'cancelled',
              mark_started = FALSE,
              mark_completed = TRUE,
              clear_completed = FALSE,
              clear_failure = TRUE,
              reset_retry = TRUE
        WHERE action_key = 'claim'
          AND from_status = 'queued'`,
    );

    await pool.query(migration);

    const definition = await pool.query(
      `SELECT terminal, retryable, dispatchable, manual, description, sort_order
         FROM task_status_definitions
        WHERE status = 'queued'`,
    );
    expect(definition.rows[0]).toMatchObject({
      terminal: true,
      retryable: false,
      dispatchable: false,
      manual: false,
      description: "operator configured queued",
      sort_order: 999,
    });
    const transition = await pool.query(
      `SELECT to_status, mark_started, mark_completed, clear_completed, clear_failure, reset_retry
         FROM task_status_transitions
        WHERE action_key = 'claim'
          AND from_status = 'queued'`,
    );
    expect(transition.rows[0]).toMatchObject({
      to_status: "cancelled",
      mark_started: false,
      mark_completed: true,
      clear_completed: false,
      clear_failure: true,
      reset_retry: true,
    });
  });

  it("reconciles missing canonical rows without replacing an operator initial status", async () => {
    await pool.query(`
      CREATE TABLE task_status_definitions (
        status TEXT PRIMARY KEY,
        initial BOOLEAN NOT NULL DEFAULT FALSE,
        terminal BOOLEAN NOT NULL DEFAULT FALSE,
        retryable BOOLEAN NOT NULL DEFAULT FALSE,
        administrative BOOLEAN NOT NULL DEFAULT FALSE,
        dispatchable BOOLEAN NOT NULL DEFAULT FALSE,
        manual BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX uq_task_status_definitions_initial
        ON task_status_definitions (initial)
        WHERE initial;
      INSERT INTO task_status_definitions
        (status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order, description)
      VALUES
        ('operator_ready', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, 1, 'operator-owned initial');
    `);

    await pool.query(lifecycleMigration());

    const rows = await pool.query(
      `SELECT status, initial
         FROM task_status_definitions
        WHERE status IN ('operator_ready', 'queued')
        ORDER BY status`,
    );
    expect(rows.rows).toEqual([
      { status: "operator_ready", initial: true },
      { status: "queued", initial: false },
    ]);
  });

  it("accepts a DB-only status and transition without a code change", async () => {
    await pool.query(lifecycleMigration());
    const id = "10000000-0000-4000-8000-000000000001";
    await pool.query(`INSERT INTO tasks (id) VALUES ($1)`, [id]);
    await pool.query(
      `INSERT INTO task_status_definitions
         (status, terminal, retryable, administrative, dispatchable, manual, sort_order)
       VALUES ($1, FALSE, FALSE, TRUE, FALSE, TRUE, 35)`,
      ["holding"],
    );
    const initial = await pool.query(
      `SELECT status FROM task_status_definitions WHERE initial`,
    );
    await pool.query(
      `INSERT INTO task_status_transitions
         (action_key, from_status, to_status, manual_allowed)
       VALUES ($1, $2, $3, TRUE)`,
      ["manual_hold", initial.rows[0].status, "holding"],
    );

    const changed = await transitionTask(
      id,
      "manual_hold",
      {},
      pool,
    );
    expect(changed?.status).toBe("holding");
  });

  it("returns null for invalid transitions and retries configured tasks through real PostgreSQL", async () => {
    await pool.query(lifecycleMigration());
    const id = "10000000-0000-4000-8000-000000000001";
    await pool.query(`INSERT INTO tasks (id) VALUES ($1)`, [id]);
    const invalid = await transitionTask(
      id,
      "succeed",
      {},
      pool,
    );
    expect(invalid).toBeNull();

    await pool.query(`
      INSERT INTO tasks (id, status, completed_at, retry_count, error, root_error_code, root_error_message, root_error_details)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        'failed',
        NOW(),
        4,
        'failed once',
        'ROOTED',
        'root message',
        '{"reason":"test"}'::jsonb
      )
    `);
    const count = await retryConfiguredTasks("retry", pool);
    expect(count).toBe(1);
    const retried = await pool.query(
      `SELECT status, completed_at, retry_count, error, root_error_code, root_error_message, root_error_details
         FROM tasks
        WHERE id = '10000000-0000-4000-8000-000000000003'`,
    );
    expect(retried.rows[0]).toMatchObject({
      status: "queued",
      completed_at: null,
      retry_count: 0,
      error: null,
      root_error_code: null,
      root_error_message: null,
      root_error_details: {},
    });
  });
});
