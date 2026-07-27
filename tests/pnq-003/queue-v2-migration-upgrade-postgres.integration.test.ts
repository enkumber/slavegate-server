import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const migrationPath = path.join(repoRoot, "src/db/migrations/082_pnq_queue_v2_contract.sql");
const postgresUrl = process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("PNQ-003 Queue v2 migration upgrade compatibility", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    await assertRealPostgres(adminPool);
    schema = `pnq003_queue_v2_upgrade_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: postgresUrl,
      max: 2,
      options: `-c search_path=${schema}`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("upgrades functions that already have legacy argument defaults and remains restart-idempotent", async () => {
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    await pool.query(migrationSql);

    await pool.query(`
      CREATE OR REPLACE FUNCTION pnq_start_execution(
        p_job_id UUID,
        p_connection_epoch BIGINT,
        p_expected_job_version BIGINT,
        p_expected_dispatch_generation BIGINT,
        p_execution_id UUID,
        p_actor TEXT DEFAULT 'legacy-dispatcher'
      ) RETURNS pnq_jobs
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RETURN NULL;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pnq_claim_next_job(
        p_node_id UUID,
        p_connection_epoch BIGINT,
        p_execution_id UUID,
        p_actor TEXT DEFAULT 'legacy-dispatcher'
      ) RETURNS pnq_jobs
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RETURN NULL;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pnq_record_result(
        p_job_id UUID,
        p_execution_id UUID,
        p_connection_epoch BIGINT,
        p_dispatch_generation BIGINT,
        p_success BOOLEAN,
        p_result_payload JSONB DEFAULT '{}'::jsonb,
        p_actor TEXT DEFAULT 'legacy-result'
      ) RETURNS pnq_jobs
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RETURN NULL;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pnq_mark_stuck(
        p_job_id UUID,
        p_reason TEXT,
        p_evidence JSONB DEFAULT '{}'::jsonb,
        p_actor TEXT DEFAULT 'legacy-recovery'
      ) RETURNS pnq_jobs
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RETURN NULL;
      END;
      $function$;
    `);

    await expect(pool.query(migrationSql)).resolves.toBeDefined();
    await expect(pool.query(migrationSql)).resolves.toBeDefined();

    const defaults = await pool.query<{ proname: string; defaults: string }>(`
      SELECT proname, pg_get_expr(proargdefaults, 0) AS defaults
      FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace
        AND proname = ANY($1::text[])
      ORDER BY proname
    `, [[
      "pnq_claim_next_job",
      "pnq_mark_stuck",
      "pnq_record_result",
      "pnq_start_execution",
    ]]);

    expect(defaults.rows).toEqual([
      { proname: "pnq_claim_next_job", defaults: "NULL::text" },
      { proname: "pnq_mark_stuck", defaults: "'{}'::jsonb, NULL::text" },
      { proname: "pnq_record_result", defaults: "'{}'::jsonb, NULL::text" },
      { proname: "pnq_start_execution", defaults: "NULL::text" },
    ]);
  });
});

function assertSafeTestDatabase(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`refusing non-local PostgreSQL test target: ${parsed.hostname}`);
  }
  if (!parsed.pathname.includes("test")) {
    throw new Error(`refusing PostgreSQL database without test marker: ${parsed.pathname}`);
  }
}

async function assertRealPostgres(poolToCheck: Pool): Promise<void> {
  const result = await poolToCheck.query<{ version: string }>("SELECT version()");
  if (!result.rows[0]?.version.includes("PostgreSQL")) {
    throw new Error("PNQ migration upgrade test requires real PostgreSQL");
  }
}
