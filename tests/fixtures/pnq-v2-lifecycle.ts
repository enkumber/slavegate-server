import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

export async function configurePnqV2LifecycleFixture(pool: Pool, repoRoot: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT
    );
  `);

  for (const relativePath of [
    "src/db/migrations/105_generic_resource_lifecycle.sql",
    "src/db/migrations/107_lifecycle_resource_bindings.sql",
    "src/db/migrations/110_generic_lifecycle_queries.sql",
    "src/db/migrations/111_multi_column_lifecycle_bindings.sql",
  ]) {
    await pool.query(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
  }

  await pool.query(`
    INSERT INTO pnq_resolution_policies (
      epoch_mismatch, cas_miss, payload_mismatch, idempotent_replay,
      stale_result, late_result, terminalized_for_recovery,
      event_type, decision
    ) VALUES
      (TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'epoch_rejected', 'rejected'),
      (FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 'cas_lost', 'ignored'),
      (FALSE, FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 'payload_conflict', 'rejected'),
      (FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE, 'enqueue_idempotent_replay', 'ignored'),
      (FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, 'stale_result', 'rejected'),
      (FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 'late_result', 'ignored'),
      (FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 'marked_stuck', 'stuck');

    INSERT INTO lifecycle_state_definitions
      (lifecycle_key, status, initial, terminal, retryable, administrative,
       dispatchable, manual, sort_order)
    VALUES
      ('pnq_v2_node_fixture', 'READY', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 10),
      ('pnq_v2_job_fixture', 'PENDING', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, 10),
      ('pnq_v2_job_fixture', 'DISPATCHING', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
      ('pnq_v2_job_fixture', 'RUNNING', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 30),
      ('pnq_v2_job_fixture', 'DONE', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 40),
      ('pnq_v2_job_fixture', 'FAILED', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 50),
      ('pnq_v2_job_fixture', 'STUCK', FALSE, TRUE, TRUE, TRUE, FALSE, TRUE, 60);

    INSERT INTO lifecycle_transitions
      (lifecycle_key, action_key, from_status, to_status, automatic,
       mark_started, mark_completed)
    VALUES
      ('pnq_v2_job_fixture', 'claim_fixture', 'PENDING', 'DISPATCHING', TRUE, FALSE, FALSE),
      ('pnq_v2_job_fixture', 'start_fixture', 'DISPATCHING', 'RUNNING', FALSE, TRUE, FALSE),
      ('pnq_v2_job_fixture', 'complete_fixture', 'RUNNING', 'DONE', FALSE, FALSE, TRUE),
      ('pnq_v2_job_fixture', 'fail_fixture', 'RUNNING', 'FAILED', FALSE, FALSE, TRUE),
      ('pnq_v2_job_fixture', 'stuck_pending_fixture', 'PENDING', 'STUCK', FALSE, FALSE, FALSE),
      ('pnq_v2_job_fixture', 'stuck_dispatch_fixture', 'DISPATCHING', 'STUCK', FALSE, FALSE, FALSE),
      ('pnq_v2_job_fixture', 'stuck_running_fixture', 'RUNNING', 'STUCK', FALSE, FALSE, FALSE);

    SELECT configure_lifecycle_resource_binding('pnq_nodes'::regclass, 'pnq_v2_node_fixture');
    SELECT configure_lifecycle_resource_binding('pnq_jobs'::regclass, 'pnq_v2_job_fixture');
  `);
}
