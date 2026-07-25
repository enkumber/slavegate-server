-- Workflow execution lifecycle on the generic PostgreSQL registry.
-- Runtime code must resolve state properties and transitions from these tables;
-- this migration only bootstraps missing definitions and never overwrites
-- operator-modified policy.

INSERT INTO lifecycle_state_definitions
  (lifecycle_key, status, initial, terminal, retryable, administrative,
   dispatchable, manual, stale_after_ms, stale_action_key, sort_order, description, metadata)
VALUES
  ('workflow_execution', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL, 10, 'Accepted and waiting for execution.', '{"countsAsActive":true}'::jsonb),
  ('workflow_execution', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 20, 'Actively executing on a device.', '{"countsAsActive":true}'::jsonb),
  ('workflow_execution', 'paused', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 30, 'Administratively paused.', '{"countsAsActive":false}'::jsonb),
  ('workflow_execution', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 40, 'Finished successfully.', '{}'::jsonb),
  ('workflow_execution', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, NULL, NULL, 50, 'Finished unsuccessfully.', '{}'::jsonb),
  ('workflow_execution', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 60, 'Administratively cancelled.', '{}'::jsonb)
ON CONFLICT (lifecycle_key, status) DO NOTHING;

INSERT INTO lifecycle_transitions
  (lifecycle_key, action_key, from_status, to_status, manual_allowed,
   external_allowed, automatic, mark_started, mark_completed,
   clear_completed, clear_failure, reset_retry)
VALUES
  ('workflow_execution', 'start', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('workflow_execution', 'start', 'paused', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('workflow_execution', 'checkpoint', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('workflow_execution', 'checkpoint', 'running', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE, TRUE, FALSE),
  ('workflow_execution', 'checkpoint', 'paused', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('workflow_execution', 'pause', 'running', 'paused', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'succeed', 'queued', 'completed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
  ('workflow_execution', 'succeed', 'running', 'completed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('workflow_execution', 'succeed', 'paused', 'completed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('workflow_execution', 'fail', 'queued', 'failed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'fail', 'running', 'failed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'fail', 'paused', 'failed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'cancel', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'administrative_cancel', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'administrative_cancel', 'running', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('workflow_execution', 'administrative_cancel', 'paused', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE)
ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING;

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
UPDATE workflows
   SET lifecycle_key = 'workflow_execution'
 WHERE lifecycle_key IS NULL OR BTRIM(lifecycle_key) = '';
ALTER TABLE workflows ALTER COLUMN lifecycle_key SET NOT NULL;
ALTER TABLE workflows ALTER COLUMN status DROP DEFAULT;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_status_check;
ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_lifecycle_status_fkey;
ALTER TABLE workflows
  ADD CONSTRAINT workflows_lifecycle_status_fkey
  FOREIGN KEY (lifecycle_key, status)
  REFERENCES lifecycle_state_definitions(lifecycle_key, status)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE workflows VALIDATE CONSTRAINT workflows_lifecycle_status_fkey;

DROP TRIGGER IF EXISTS trg_workflows_initial_status ON workflows;
CREATE TRIGGER trg_workflows_initial_status
BEFORE INSERT ON workflows
FOR EACH ROW
EXECUTE FUNCTION set_initial_resource_lifecycle_status('workflow_execution');

INSERT INTO lifecycle_state_definitions
  (lifecycle_key, status, initial, terminal, retryable, administrative,
   dispatchable, manual, stale_after_ms, stale_action_key, sort_order, description, metadata)
VALUES
  ('agency_workflow_run', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL, 10, 'Queued through the agency control plane.', '{"countsAsActive":true}'::jsonb),
  ('agency_workflow_run', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 20, 'The linked task is executing.', '{"countsAsActive":true}'::jsonb),
  ('agency_workflow_run', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 30, 'Run completed successfully.', '{}'::jsonb),
  ('agency_workflow_run', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, NULL, NULL, 40, 'Run failed.', '{}'::jsonb),
  ('agency_workflow_run', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 50, 'Run was administratively cancelled.', '{}'::jsonb)
ON CONFLICT (lifecycle_key, status) DO NOTHING;

INSERT INTO lifecycle_transitions
  (lifecycle_key, action_key, from_status, to_status, manual_allowed,
   external_allowed, automatic, mark_started, mark_completed,
   clear_completed, clear_failure, reset_retry)
VALUES
  ('agency_workflow_run', 'start', 'queued', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('agency_workflow_run', 'succeed', 'queued', 'completed', FALSE, FALSE, FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
  ('agency_workflow_run', 'succeed', 'running', 'completed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('agency_workflow_run', 'fail', 'queued', 'failed', FALSE, FALSE, FALSE, TRUE, TRUE, FALSE, FALSE, FALSE),
  ('agency_workflow_run', 'fail', 'running', 'failed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('agency_workflow_run', 'administrative_cancel', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('agency_workflow_run', 'administrative_cancel', 'running', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE)
ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING;

ALTER TABLE agency_workflow_runs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
UPDATE agency_workflow_runs
   SET lifecycle_key = 'agency_workflow_run'
 WHERE lifecycle_key IS NULL OR BTRIM(lifecycle_key) = '';
ALTER TABLE agency_workflow_runs ALTER COLUMN lifecycle_key SET NOT NULL;
ALTER TABLE agency_workflow_runs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE agency_workflow_runs DROP CONSTRAINT IF EXISTS agency_workflow_runs_status_check;
ALTER TABLE agency_workflow_runs DROP CONSTRAINT IF EXISTS agency_workflow_runs_lifecycle_status_fkey;
ALTER TABLE agency_workflow_runs
  ADD CONSTRAINT agency_workflow_runs_lifecycle_status_fkey
  FOREIGN KEY (lifecycle_key, status)
  REFERENCES lifecycle_state_definitions(lifecycle_key, status)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE agency_workflow_runs VALIDATE CONSTRAINT agency_workflow_runs_lifecycle_status_fkey;

DROP TRIGGER IF EXISTS trg_agency_workflow_runs_initial_status ON agency_workflow_runs;
CREATE TRIGGER trg_agency_workflow_runs_initial_status
BEFORE INSERT ON agency_workflow_runs
FOR EACH ROW
EXECUTE FUNCTION set_initial_resource_lifecycle_status('agency_workflow_run');

INSERT INTO lifecycle_state_definitions
  (lifecycle_key, status, initial, terminal, retryable, administrative,
   dispatchable, manual, stale_after_ms, stale_action_key, sort_order, description, metadata)
VALUES
  ('research_job', 'pending', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL, 10, 'Waiting for a scheduler.', '{"dedupeActive":true,"queuePending":true}'::jsonb),
  ('research_job', 'scheduled', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 3600000, 'reset_stale', 20, 'Assigned to a device.', '{"dedupeActive":true}'::jsonb),
  ('research_job', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 3600000, 'reset_stale', 30, 'Research is executing.', '{"dedupeActive":true}'::jsonb),
  ('research_job', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 40, 'Cached research result is available.', '{"cacheReadable":true}'::jsonb),
  ('research_job', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, NULL, NULL, 50, 'Research failed.', '{}'::jsonb)
ON CONFLICT (lifecycle_key, status) DO NOTHING;

INSERT INTO lifecycle_transitions
  (lifecycle_key, action_key, from_status, to_status, manual_allowed,
   external_allowed, automatic, mark_started, mark_completed,
   clear_completed, clear_failure, reset_retry)
VALUES
  ('research_job', 'schedule', 'pending', 'scheduled', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE),
  ('research_job', 'start', 'scheduled', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE, TRUE, FALSE),
  ('research_job', 'succeed', 'pending', 'completed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
  ('research_job', 'succeed', 'scheduled', 'completed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
  ('research_job', 'succeed', 'running', 'completed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('research_job', 'fail', 'scheduled', 'failed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('research_job', 'fail', 'running', 'failed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('research_job', 'reset_stale', 'scheduled', 'pending', FALSE, FALSE, TRUE, FALSE, FALSE, TRUE, TRUE, TRUE),
  ('research_job', 'reset_stale', 'running', 'pending', FALSE, FALSE, TRUE, FALSE, FALSE, TRUE, TRUE, TRUE)
ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING;

ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
UPDATE research_jobs
   SET lifecycle_key = 'research_job'
 WHERE lifecycle_key IS NULL OR BTRIM(lifecycle_key) = '';
ALTER TABLE research_jobs ALTER COLUMN lifecycle_key SET NOT NULL;
ALTER TABLE research_jobs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_status_check;
ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_lifecycle_status_fkey;
ALTER TABLE research_jobs
  ADD CONSTRAINT research_jobs_lifecycle_status_fkey
  FOREIGN KEY (lifecycle_key, status)
  REFERENCES lifecycle_state_definitions(lifecycle_key, status)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE research_jobs VALIDATE CONSTRAINT research_jobs_lifecycle_status_fkey;

DROP TRIGGER IF EXISTS trg_research_jobs_initial_status ON research_jobs;
CREATE TRIGGER trg_research_jobs_initial_status
BEFORE INSERT ON research_jobs
FOR EACH ROW
EXECUTE FUNCTION set_initial_resource_lifecycle_status('research_job');

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
