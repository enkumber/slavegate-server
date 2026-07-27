import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let schema = "";

function migration(name: string): string {
  return fs.readFileSync(
    path.join(repoRoot, "src/db/migrations", name),
    "utf8",
  );
}

describe("lifecycle binding migrations across repeated server starts", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `lifecycle_binding_restart_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);

    const url = new URL(postgresUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString(), max: 2 });

    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        initial BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE restart_resources (
        id UUID PRIMARY KEY,
        lifecycle_key TEXT,
        status TEXT
      );
      CREATE TABLE restart_resources_without_lifecycle_key (
        id UUID PRIMARY KEY,
        status TEXT
      );
      INSERT INTO lifecycle_state_definitions(
        lifecycle_key,
        status,
        initial
      ) VALUES ('restart_test', 'initial_state', TRUE);
      INSERT INTO restart_resources(id, lifecycle_key, status)
      VALUES (
        '00000000-0000-4000-8000-000000000001',
        'restart_test',
        'initial_state'
      );
      CREATE OR REPLACE FUNCTION adopt_configured_lifecycle_resources()
      RETURNS TABLE(resource_table REGCLASS, lifecycle_key TEXT)
      LANGUAGE SQL
      AS $$
        SELECT NULL::REGCLASS, NULL::TEXT WHERE FALSE
      $$;
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) {
      await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await adminPool?.end();
  });

  it("survives repeated application before and after the composite key exists", async () => {
    await pool.query(migration("107_lifecycle_resource_bindings.sql"));
    await pool.query(`
      SELECT configure_lifecycle_resource_binding(
        'restart_resources'::regclass,
        'restart_test',
        'status'
      )
    `);

    const startupMigrations = [
      "109_generic_lifecycle_state_columns.sql",
      "111_multi_column_lifecycle_bindings.sql",
      "114_lifecycle_resource_policies.sql",
    ];

    for (const file of startupMigrations) {
      await pool.query(migration(file));
    }

    await pool.query(`
      SELECT configure_lifecycle_resource_binding(
        'restart_resources_without_lifecycle_key'::regclass,
        'restart_test',
        'status'
      )
    `);

    for (let startup = 0; startup < 2; startup += 1) {
      await pool.query(migration("107_lifecycle_resource_bindings.sql"));
      for (const file of startupMigrations) {
        await pool.query(migration(file));
      }
    }

    const primaryKey = await pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(constraint_definition.oid) AS definition
        FROM pg_constraint constraint_definition
       WHERE constraint_definition.conrelid =
             'lifecycle_resource_bindings'::regclass
         AND constraint_definition.contype = 'p'
    `);
    expect(primaryKey.rows).toEqual([
      { definition: "PRIMARY KEY (resource_table, state_column)" },
    ]);

    const bindings = await pool.query<{
      lifecycle_key: string;
      state_column: string;
    }>(`
      SELECT lifecycle_key, state_column::TEXT
        FROM lifecycle_resource_bindings
       WHERE resource_table IN (
         'restart_resources'::regclass,
         'restart_resources_without_lifecycle_key'::regclass
       )
       ORDER BY resource_table::TEXT
    `);
    expect(bindings.rows).toEqual([
      { lifecycle_key: "restart_test", state_column: "status" },
      { lifecycle_key: "restart_test", state_column: "status" },
    ]);

    await pool.query(`
      INSERT INTO restart_resources_without_lifecycle_key(id)
      VALUES ('00000000-0000-4000-8000-000000000002')
    `);
    const inserted = await pool.query<{ status: string }>(`
      SELECT status
        FROM restart_resources_without_lifecycle_key
       WHERE id = '00000000-0000-4000-8000-000000000002'
    `);
    expect(inserted.rows).toEqual([{ status: "initial_state" }]);
  });
});
