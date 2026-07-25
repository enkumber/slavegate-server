import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionWorkflow } from "../src/modules/workflows/workflow-lifecycle.service";
import { transitionAgencyWorkflowRun } from "../src/modules/workflows/agency-workflow-run-lifecycle.service";
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

describe("policy-free workflow and research lifecycle on real PostgreSQL", () => {
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
      CREATE TABLE tasks (id UUID PRIMARY KEY, status TEXT);
      CREATE TABLE jobs (id UUID PRIMARY KEY, status TEXT);
    `);
    await pool.query(migration("105_generic_resource_lifecycle.sql"));
    await pool.query(`
      CREATE TABLE workflows (
        id UUID PRIMARY KEY,
        status TEXT,
        current_step INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER,
        checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error TEXT
      );
      CREATE TABLE agency_workflow_runs (
        id UUID PRIMARY KEY,
        status TEXT,
        task_id UUID,
        workflow_id UUID,
        output JSONB,
        token_usage JSONB,
        recovery_requests INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        root_error_code TEXT,
        root_error_message TEXT,
        root_error_details JSONB,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE research_jobs (
        id UUID PRIMARY KEY,
        job_type TEXT NOT NULL,
        input JSONB NOT NULL,
        output JSONB,
        status TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        device_id UUID,
        error TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scheduled_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
    `);
    await pool.query(migration("106_workflow_execution_generic_lifecycle.sql"));
    await pool.query(migration("107_lifecycle_resource_bindings.sql"));
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("contains no packaged workflow or research policy", async () => {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM lifecycle_state_definitions");
    expect(result.rows[0].count).toBe(0);
  });

  it("binds arbitrary policies and executes selectors from DB properties", async () => {
    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order)
      VALUES
        ('wf_alpha', 'seed', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 1),
        ('wf_alpha', 'fruit', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 2),
        ('run_beta', 'seed', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 1),
        ('run_beta', 'fruit', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 2),
        ('research_gamma', 'seed', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 1),
        ('research_gamma', 'fruit', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 2);
      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, mark_completed, clear_failure)
      VALUES
        ('wf_alpha', 'ripen', 'seed', 'fruit', TRUE, TRUE),
        ('run_beta', 'ripen', 'seed', 'fruit', TRUE, TRUE),
        ('research_gamma', 'ripen', 'seed', 'fruit', TRUE, TRUE);
      SELECT configure_lifecycle_resource_binding('workflows'::regclass, 'wf_alpha');
      SELECT configure_lifecycle_resource_binding('agency_workflow_runs'::regclass, 'run_beta');
      SELECT configure_lifecycle_resource_binding('research_jobs'::regclass, 'research_gamma');
    `);

    const workflowId = "20000000-0000-4000-8000-000000000001";
    const runId = "20000000-0000-4000-8000-000000000002";
    const researchId = "20000000-0000-4000-8000-000000000003";
    await pool.query("INSERT INTO workflows (id) VALUES ($1)", [workflowId]);
    await pool.query("INSERT INTO agency_workflow_runs (id) VALUES ($1)", [runId]);
    await pool.query("INSERT INTO research_jobs (id, job_type, input) VALUES ($1, 'arbitrary', '{}'::jsonb)", [researchId]);

    const selector = {
      targetTerminal: true,
      targetRetryable: false,
      targetAdministrative: false,
      transitionMarkCompleted: true,
      transitionClearFailure: true,
    };
    expect((await transitionWorkflow(workflowId, selector, {}, pool))?.status).toBe("fruit");
    expect((await transitionAgencyWorkflowRun(runId, selector, {}, pool))?.status).toBe("fruit");
    expect((await transitionResearchJob(researchId, selector, {}, pool))?.status).toBe("fruit");
  });

  it("changes transition behavior through PostgreSQL only", async () => {
    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, terminal, retryable, administrative, dispatchable, manual, sort_order)
      VALUES ('wf_alpha', 'orchard', TRUE, FALSE, FALSE, FALSE, FALSE, 3);
      UPDATE lifecycle_transitions
         SET to_status = 'orchard'
       WHERE lifecycle_key = 'wf_alpha'
         AND action_key = 'ripen'
         AND from_status = 'seed';
    `);
    await pool.query(migration("105_generic_resource_lifecycle.sql"));
    await pool.query(migration("106_workflow_execution_generic_lifecycle.sql"));
    await pool.query(migration("107_lifecycle_resource_bindings.sql"));
    const id = "20000000-0000-4000-8000-000000000004";
    await pool.query("INSERT INTO workflows (id) VALUES ($1)", [id]);
    const changed = await transitionWorkflow(id, {
      targetTerminal: true,
      targetRetryable: false,
      targetAdministrative: false,
      transitionMarkCompleted: true,
      transitionClearFailure: true,
    }, {}, pool);
    expect(changed?.status).toBe("orchard");
  });
});
