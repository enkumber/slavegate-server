-- Durable worker ownership fields for human workflow compile jobs.
--
-- This migration is strictly mechanical. Lease timing, retry eligibility,
-- lifecycle states, transitions, and worker policy remain PostgreSQL
-- configuration managed through generic lifecycle/runtime policy tables.

ALTER TABLE human_workflow_compile_jobs
  ADD COLUMN IF NOT EXISTS owner_token TEXT,
  ADD COLUMN IF NOT EXISTS owner_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worker_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_worker_heartbeat_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'human_workflow_compile_jobs'::regclass
       AND conname = 'human_workflow_compile_jobs_owner_generation_check'
  ) THEN
    ALTER TABLE human_workflow_compile_jobs
      ADD CONSTRAINT human_workflow_compile_jobs_owner_generation_check
      CHECK (owner_generation >= 0) NOT VALID;
  END IF;
  ALTER TABLE human_workflow_compile_jobs
    VALIDATE CONSTRAINT human_workflow_compile_jobs_owner_generation_check;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'human_workflow_compile_jobs'::regclass
       AND conname = 'human_workflow_compile_jobs_worker_attempt_count_check'
  ) THEN
    ALTER TABLE human_workflow_compile_jobs
      ADD CONSTRAINT human_workflow_compile_jobs_worker_attempt_count_check
      CHECK (worker_attempt_count >= 0) NOT VALID;
  END IF;
  ALTER TABLE human_workflow_compile_jobs
    VALIDATE CONSTRAINT human_workflow_compile_jobs_worker_attempt_count_check;
END;
$$;

CREATE INDEX IF NOT EXISTS human_workflow_compile_jobs_lease_idx
  ON human_workflow_compile_jobs(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS human_workflow_compile_job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES human_workflow_compile_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  owner_token TEXT,
  owner_generation BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS human_workflow_compile_job_events_job_idx
  ON human_workflow_compile_job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS promotion_gate_egress_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_mode TEXT NOT NULL,
  db_fingerprint TEXT NOT NULL,
  device_id UUID NOT NULL,
  boundary TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_external_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  dispatch_identity TEXT NOT NULL,
  envelope JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (capture_mode, db_fingerprint, dispatch_identity)
);

CREATE INDEX IF NOT EXISTS promotion_gate_egress_captures_operation_idx
  ON promotion_gate_egress_captures(operation_id, created_at);
