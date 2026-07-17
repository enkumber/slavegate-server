-- Rollback for 082_pnq_queue_v2_contract.sql.
-- Intentionally stored outside src/db/migrations because the repo migration
-- runner applies every migration file forward in filename order.

DROP FUNCTION IF EXISTS pnq_mark_stuck(UUID, TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS pnq_record_result(UUID, UUID, BIGINT, BOOLEAN, JSONB, TEXT);
DROP FUNCTION IF EXISTS pnq_claim_next_job(UUID, BIGINT, UUID, TEXT);
DROP FUNCTION IF EXISTS pnq_start_execution(UUID, BIGINT, BIGINT, BIGINT, UUID, TEXT);
DROP FUNCTION IF EXISTS pnq_enqueue_job(UUID, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, JSONB);
DROP FUNCTION IF EXISTS pnq_bump_connection_epoch(UUID, BIGINT);
DROP FUNCTION IF EXISTS pnq_register_node(UUID, TEXT, JSONB);
DROP TRIGGER IF EXISTS pnq_jobs_touch_updated_at ON pnq_jobs;
DROP TRIGGER IF EXISTS pnq_nodes_touch_updated_at ON pnq_nodes;
DROP FUNCTION IF EXISTS pnq_touch_updated_at();
DROP TRIGGER IF EXISTS pnq_resolution_audit_no_delete ON pnq_resolution_audit;
DROP TRIGGER IF EXISTS pnq_resolution_audit_no_update ON pnq_resolution_audit;
DROP FUNCTION IF EXISTS pnq_resolution_audit_append_only();
DROP TABLE IF EXISTS pnq_resolution_audit;
DROP TABLE IF EXISTS pnq_jobs;
DROP TABLE IF EXISTS pnq_nodes;
