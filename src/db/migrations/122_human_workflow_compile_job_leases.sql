-- Mechanical lease metadata for durable human workflow compile-job workers.
-- Lifecycle/status/retry semantics remain configured in PostgreSQL control-plane rows.

ALTER TABLE human_workflow_compile_jobs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_attempt_id UUID;

CREATE INDEX IF NOT EXISTS human_workflow_compile_jobs_lease_claim_idx
  ON human_workflow_compile_jobs(status, lease_expires_at, created_at)
  WHERE completed_at IS NULL;
