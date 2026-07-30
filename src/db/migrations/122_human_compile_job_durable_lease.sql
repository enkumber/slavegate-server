-- Mechanical persistence for durable compile-job ownership.
-- Lifecycle and worker policy values remain operator-managed PostgreSQL data.

ALTER TABLE human_workflow_compile_jobs
  ADD COLUMN IF NOT EXISTS request_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_attempt_id UUID;

CREATE INDEX IF NOT EXISTS human_workflow_compile_jobs_reconcile_idx
  ON human_workflow_compile_jobs(lease_expires_at, created_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS human_workflow_compile_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES human_workflow_compile_jobs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  lease_owner TEXT,
  lease_generation BIGINT,
  policy_version BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS human_workflow_compile_job_events_job_idx
  ON human_workflow_compile_job_events(job_id, created_at, id);
