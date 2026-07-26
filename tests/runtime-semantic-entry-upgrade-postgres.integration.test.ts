import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFailClosedMigration } from "../src/db/migrate";

const postgresUrl = process.env.GENERATED_WORKFLOW_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const describePostgres = process.env.GENERATED_WORKFLOW_PG_URL || process.env.PNQ001_PG_URL
  ? describe.sequential
  : describe.skip;

describePostgres("runtime semantic entry upgrade compatibility", () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("runtime semantic integration tests require local PostgreSQL");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `runtime_semantic_upgrade_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      options: `-c search_path=${schema}`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool && schema) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("removes an unknown legacy status constraint without seeding semantic data", async () => {
    await pool.query(`
      CREATE TABLE runtime_semantic_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '*',
        status TEXT NOT NULL DEFAULT 'legacy_enabled'
          CHECK (status IN ('legacy_enabled', 'legacy_disabled')),
        priority INTEGER NOT NULL DEFAULT 0,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (namespace, entry_key)
      )
    `);
    const migration = fs.readFileSync(
      path.join(process.cwd(), "src/db/migrations/117_runtime_semantic_entry_lifecycle_compatibility.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);

    const checks = await pool.query(
      `SELECT 1
         FROM pg_constraint
        WHERE conrelid = 'runtime_semantic_entries'::regclass
          AND contype = 'c'`,
    );
    const defaultValue = await pool.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'runtime_semantic_entries'
          AND column_name = 'status'`,
    );
    expect(checks.rows).toHaveLength(0);
    expect(defaultValue.rows[0]?.column_default).toBeNull();
    expect((await pool.query("SELECT * FROM runtime_semantic_entries")).rows).toHaveLength(0);
    expect(isFailClosedMigration("117_runtime_semantic_entry_lifecycle_compatibility.sql")).toBe(true);
  });
});
