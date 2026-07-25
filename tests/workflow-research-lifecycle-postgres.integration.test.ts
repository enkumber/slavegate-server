import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionWorkflow } from "../src/modules/workflows/workflow-lifecycle.service";
import { transitionResearchJob } from "../src/modules/research/research-lifecycle.service";

const postgresUrl = process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const repoRoot = path.resolve(__dirname, "..");
let adminPool: Pool;
let pool: Pool;
let schema = "";

function migration(name: string): string {
  return fs.readFileSync(path.join(repoRoot, "src/db/migrations", name), "utf8");
}

describe("workflow, agency run, and research DB-authoritative lifecycle", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/(test|pnq)/i.test(parsed.pathname)) {
      throw new Error("Refusing non-test PostgreSQL target");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `workflow_research_lifecycle_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: postgresUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE tasks (id UUID PRIMARY KEY, status TEXT);
      CREATE TABLE jobs (id UUID PRIMARY KEY, status TEXT);
    `);
    await pool.query(migration("105_generic_resource_lifecycle.sql"));
    await pool.query(`
      CREATE TABLE workflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id TEXT,
        account_id UUID,
        device_id UUID,
        status TEXT DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        current_step INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER,
        checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
        hbe_params JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE agency_workflow_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status TEXT DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        task_id UUID,
        workflow_id UUID,
        output JSONB,
        token_usage JSONB,
        error TEXT,
        root_error_code TEXT,
        root_error_message TEXT,
        root_error_details JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE research_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_type TEXT NOT NULL,
        input JSONB NOT NULL,
        output JSONB,
        status TEXT DEFAULT 'pending'
          CHECK (status IN ('pending', 'scheduled', 'running', 'completed', 'failed')),
        priority INTEGER NOT NULL DEFAULT 0,
        device_id UUID,
        error TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scheduled_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(migration("106_workflow_execution_generic_lifecycle.sql"));
    await pool.query(migration("106_workflow_execution_generic_lifecycle.sql"));
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("resolves initial states from PostgreSQL and binds all resources by foreign key", async () => {
    const workflow = await pool.query(`
      INSERT INTO workflows (device_id)
      VALUES ('11111111-1111-4111-8111-111111111111')
      RETURNING lifecycle_key, status
    `);
    const run = await pool.query(`
      INSERT INTO agency_workflow_runs DEFAULT VALUES
      RETURNING lifecycle_key, status
    `);
    const research = await pool.query(`
      INSERT INTO research_jobs (job_type, input)
      VALUES ('research_profile', '{"username":"test"}'::jsonb)
      RETURNING lifecycle_key, status
    `);

    expect(workflow.rows[0]).toEqual({ lifecycle_key: "workflow_execution", status: "queued" });
    expect(run.rows[0]).toEqual({ lifecycle_key: "agency_workflow_run", status: "queued" });
    expect(research.rows[0]).toEqual({ lifecycle_key: "research_job", status: "pending" });
  });

  it("honors an operator-modified workflow transition without a code change", async () => {
    const inserted = await pool.query(`
      INSERT INTO workflows (device_id)
      VALUES ('11111111-1111-4111-8111-111111111111')
      RETURNING id
    `);
    await pool.query(`
      UPDATE lifecycle_transitions
      SET to_status = 'paused'
      WHERE lifecycle_key = 'workflow_execution'
        AND action_key = 'start'
        AND from_status = 'queued'
    `);

    const transitioned = await transitionWorkflow(inserted.rows[0].id, "start", {}, pool);
    expect(transitioned?.status).toBe("paused");

    await pool.query(migration("106_workflow_execution_generic_lifecycle.sql"));
    const preserved = await pool.query(`
      SELECT to_status
      FROM lifecycle_transitions
      WHERE lifecycle_key = 'workflow_execution'
        AND action_key = 'start'
        AND from_status = 'queued'
    `);
    expect(preserved.rows[0]?.to_status).toBe("paused");
  });

  it("uses the configured research transition and clears retry ownership", async () => {
    const inserted = await pool.query(`
      INSERT INTO research_jobs (
        job_type, input, status, device_id, scheduled_at, started_at, error
      ) VALUES (
        'research_profile', '{"username":"test"}'::jsonb, 'running',
        '11111111-1111-4111-8111-111111111111', NOW(), NOW(), 'stale'
      )
      RETURNING id
    `);
    const transitioned = await transitionResearchJob(inserted.rows[0].id, "reset_stale", {}, pool);
    expect(transitioned).toMatchObject({
      status: "pending",
      device_id: null,
      scheduled_at: null,
      started_at: null,
      error: null,
    });
  });
});
