import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const postgresUrl = process.env.PNQ001_PG_URL ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const repoRoot = path.resolve(__dirname, "..");
let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("Phone Network incident and audit migration", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `phone_network_incidents_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE devices (id UUID PRIMARY KEY);
      CREATE TABLE tasks (id UUID PRIMARY KEY);
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("applies idempotently and keeps one incident per terminal source", async () => {
    const sql = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/094_phone_network_incidents_and_audits.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    await pool.query(`
      INSERT INTO devices VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO tasks VALUES ('22222222-2222-4222-8222-222222222222');
      INSERT INTO phone_network_incidents (
        incident_key, source_type, source_id, task_id, device_id, summary
      ) VALUES (
        'task:22222222-2222-4222-8222-222222222222', 'task',
        '22222222-2222-4222-8222-222222222222',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', 'terminal failure'
      );
    `);
    await expect(pool.query(`
      INSERT INTO phone_network_incidents (incident_key, source_type, source_id, summary)
      VALUES ('task:22222222-2222-4222-8222-222222222222', 'task', 'duplicate', 'duplicate')
    `)).rejects.toMatchObject({ code: "23505" });

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'phone_network_%'
      ORDER BY table_name
    `, [schema]);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "phone_network_audit_findings",
      "phone_network_audit_runs",
      "phone_network_incident_events",
      "phone_network_incidents",
    ]);
  });
});
