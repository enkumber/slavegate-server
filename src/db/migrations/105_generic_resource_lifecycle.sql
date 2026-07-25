-- Generic, DB-authoritative lifecycle registry.
-- Forward-only and idempotent. Existing task lifecycle configuration is copied
-- before the superseded task-specific registry is removed.

CREATE TABLE IF NOT EXISTS lifecycle_state_definitions (
  lifecycle_key TEXT NOT NULL,
  status TEXT NOT NULL,
  initial BOOLEAN NOT NULL DEFAULT FALSE,
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  administrative BOOLEAN NOT NULL DEFAULT FALSE,
  dispatchable BOOLEAN NOT NULL DEFAULT FALSE,
  manual BOOLEAN NOT NULL DEFAULT FALSE,
  stale_after_ms BIGINT,
  stale_action_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lifecycle_key, status),
  CHECK (stale_after_ms IS NULL OR stale_after_ms > 0),
  CHECK (
    (stale_after_ms IS NULL AND stale_action_key IS NULL)
    OR (stale_after_ms IS NOT NULL AND NULLIF(BTRIM(stale_action_key), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lifecycle_state_initial
  ON lifecycle_state_definitions (lifecycle_key)
  WHERE initial;

CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  lifecycle_key TEXT NOT NULL,
  action_key TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  manual_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  external_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  automatic BOOLEAN NOT NULL DEFAULT FALSE,
  mark_started BOOLEAN NOT NULL DEFAULT FALSE,
  mark_completed BOOLEAN NOT NULL DEFAULT FALSE,
  clear_completed BOOLEAN NOT NULL DEFAULT FALSE,
  clear_failure BOOLEAN NOT NULL DEFAULT FALSE,
  reset_retry BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lifecycle_key, action_key, from_status),
  FOREIGN KEY (lifecycle_key, from_status)
    REFERENCES lifecycle_state_definitions(lifecycle_key, status)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (lifecycle_key, to_status)
    REFERENCES lifecycle_state_definitions(lifecycle_key, status)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Preserve operator-modified task lifecycle configuration from 3.9.265.
DO $$
BEGIN
  IF to_regclass('public.task_status_definitions') IS NOT NULL THEN
    EXECUTE $copy$
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key, status, initial, terminal, retryable, administrative,
         dispatchable, manual, sort_order, description, created_at, updated_at)
      SELECT 'task', status, initial, terminal, retryable, administrative,
             dispatchable, manual, sort_order, description, created_at, updated_at
        FROM task_status_definitions
      ON CONFLICT (lifecycle_key, status) DO NOTHING
    $copy$;
  END IF;

  IF to_regclass('public.task_status_transitions') IS NOT NULL THEN
    EXECUTE $copy$
      INSERT INTO lifecycle_transitions
        (lifecycle_key, action_key, from_status, to_status, manual_allowed,
         mark_started, mark_completed, clear_completed, clear_failure,
         reset_retry, created_at)
      SELECT 'task', action_key, from_status, to_status, manual_allowed,
             mark_started, mark_completed, clear_completed, clear_failure,
             reset_retry, created_at
        FROM task_status_transitions
      ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING
    $copy$;
  END IF;
END;
$$;

-- Bootstrap only missing rows. Re-running never overwrites operator policy.
INSERT INTO lifecycle_state_definitions
  (lifecycle_key, status, initial, terminal, retryable, administrative,
   dispatchable, manual, stale_after_ms, stale_action_key, sort_order, description)
VALUES
  ('task', 'queued', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, NULL, NULL, 10, 'Ready for task-runner dispatch.'),
  ('task', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 20, 'Claimed by a runner and actively executing.'),
  ('task', 'paused', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 30, 'Held by an operator and eligible for manual resume.'),
  ('task', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 40, 'Finished successfully.'),
  ('task', 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, NULL, NULL, 50, 'Finished unsuccessfully and may be retried while retry budget remains.'),
  ('task', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 60, 'Administratively cancelled.'),
  ('dispatcher_job', 'pending', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, 3600000, 'expire', 10, 'Accepted and waiting for device dispatch.'),
  ('dispatcher_job', 'running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 20, 'Acknowledged by the device and executing.'),
  ('dispatcher_job', 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 30, 'Finished successfully.'),
  ('dispatcher_job', 'failed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 40, 'Finished unsuccessfully.'),
  ('dispatcher_job', 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, NULL, NULL, 50, 'Administratively cancelled before completion.'),
  ('dispatcher_job', 'timeout', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, NULL, NULL, 60, 'Expired without a terminal device result.')
ON CONFLICT (lifecycle_key, status) DO NOTHING;

INSERT INTO lifecycle_transitions
  (lifecycle_key, action_key, from_status, to_status, manual_allowed,
   external_allowed, automatic, mark_started, mark_completed,
   clear_completed, clear_failure, reset_retry)
VALUES
  ('task', 'claim', 'queued', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('task', 'execute_now', 'queued', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('task', 'execute_now', 'paused', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('task', 'execute_now', 'failed', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('task', 'succeed', 'running', 'completed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('task', 'fail', 'queued', 'failed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'fail', 'paused', 'failed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'fail', 'running', 'failed', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'retry', 'failed', 'queued', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, TRUE, TRUE),
  ('task', 'manual_pause', 'queued', 'paused', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
  ('task', 'manual_resume', 'paused', 'queued', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE),
  ('task', 'administrative_cancel', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'administrative_cancel', 'paused', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'administrative_cancel', 'running', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('task', 'administrative_cancel', 'failed', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('dispatcher_job', 'claim', 'pending', 'running', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('dispatcher_job', 'device_completed', 'pending', 'completed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
  ('dispatcher_job', 'device_completed', 'running', 'completed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('dispatcher_job', 'device_failed', 'pending', 'failed', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, FALSE, FALSE),
  ('dispatcher_job', 'device_failed', 'running', 'failed', FALSE, TRUE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('dispatcher_job', 'cancel', 'pending', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('dispatcher_job', 'expire', 'pending', 'timeout', FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('dispatcher_job', 'expire', 'running', 'timeout', FALSE, FALSE, TRUE, FALSE, TRUE, FALSE, FALSE, FALSE)
ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
UPDATE tasks SET lifecycle_key = 'task' WHERE lifecycle_key IS NULL OR BTRIM(lifecycle_key) = '';
ALTER TABLE tasks ALTER COLUMN lifecycle_key SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_fkey;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_lifecycle_status_fkey;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_lifecycle_status_fkey
  FOREIGN KEY (lifecycle_key, status)
  REFERENCES lifecycle_state_definitions(lifecycle_key, status)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_lifecycle_status_fkey;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
UPDATE jobs SET lifecycle_key = 'dispatcher_job' WHERE lifecycle_key IS NULL OR BTRIM(lifecycle_key) = '';
ALTER TABLE jobs ALTER COLUMN lifecycle_key SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_lifecycle_status_fkey;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_lifecycle_status_fkey
  FOREIGN KEY (lifecycle_key, status)
  REFERENCES lifecycle_state_definitions(lifecycle_key, status)
  ON UPDATE CASCADE ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_lifecycle_status_fkey;

CREATE OR REPLACE FUNCTION set_initial_resource_lifecycle_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configured_lifecycle_key TEXT := TG_ARGV[0];
BEGIN
  IF NEW.lifecycle_key IS NULL OR BTRIM(NEW.lifecycle_key) = '' THEN
    NEW.lifecycle_key := configured_lifecycle_key;
  END IF;

  IF NEW.lifecycle_key <> configured_lifecycle_key THEN
    RAISE EXCEPTION 'invalid lifecycle key % for table %, expected %',
      NEW.lifecycle_key, TG_TABLE_NAME, configured_lifecycle_key;
  END IF;

  IF NEW.status IS NULL OR BTRIM(NEW.status) = '' THEN
    SELECT definition.status
      INTO NEW.status
      FROM lifecycle_state_definitions definition
     WHERE definition.lifecycle_key = NEW.lifecycle_key
       AND definition.initial
     ORDER BY definition.sort_order, definition.status
     LIMIT 1;

    IF NEW.status IS NULL THEN
      RAISE EXCEPTION 'lifecycle % has no initial status configured', NEW.lifecycle_key;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_initial_status ON tasks;
CREATE TRIGGER trg_tasks_initial_status
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_initial_resource_lifecycle_status('task');

DROP TRIGGER IF EXISTS trg_jobs_initial_status ON jobs;
CREATE TRIGGER trg_jobs_initial_status
BEFORE INSERT ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_initial_resource_lifecycle_status('dispatcher_job');

DROP FUNCTION IF EXISTS set_initial_task_status();
DROP TABLE IF EXISTS task_status_transitions;
DROP TABLE IF EXISTS task_status_definitions;
