-- Structural adoption of the generic lifecycle registry.
-- This migration deliberately contains no lifecycle keys, statuses, actions,
-- transitions, deadlines, or policy. Configuration belongs in PostgreSQL data.

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
ALTER TABLE workflows ALTER COLUMN status DROP DEFAULT;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_status_check;

ALTER TABLE agency_workflow_runs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
ALTER TABLE agency_workflow_runs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE agency_workflow_runs DROP CONSTRAINT IF EXISTS agency_workflow_runs_status_check;

ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
ALTER TABLE research_jobs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_status_check;

DROP INDEX IF EXISTS idx_research_jobs_type_input;
DROP INDEX IF EXISTS idx_research_jobs_pending_priority;
DROP INDEX IF EXISTS idx_research_jobs_device;
DROP INDEX IF EXISTS idx_research_jobs_expires;

CREATE INDEX IF NOT EXISTS idx_research_jobs_lifecycle_type_input
  ON research_jobs(lifecycle_key, status, job_type, input);
CREATE INDEX IF NOT EXISTS idx_research_jobs_lifecycle_priority
  ON research_jobs(lifecycle_key, status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_research_jobs_lifecycle_device
  ON research_jobs(lifecycle_key, status, device_id);
CREATE INDEX IF NOT EXISTS idx_research_jobs_lifecycle_expires
  ON research_jobs(lifecycle_key, status, expires_at);
