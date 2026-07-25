-- DB-authoritative task lifecycle contract for 3.9.265.
-- Forward-only and idempotent: creates/reconciles metadata and allowed
-- transitions without mutating existing task/run/workflow state.

CREATE TABLE IF NOT EXISTS task_status_definitions (
  status TEXT PRIMARY KEY,
  initial BOOLEAN NOT NULL DEFAULT FALSE,
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  administrative BOOLEAN NOT NULL DEFAULT FALSE,
  dispatchable BOOLEAN NOT NULL DEFAULT FALSE,
  manual BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE task_status_definitions
  ADD COLUMN IF NOT EXISTS initial BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_status_definitions_initial
  ON task_status_definitions (initial)
  WHERE initial;

CREATE TABLE IF NOT EXISTS task_status_transitions (
  action_key TEXT NOT NULL DEFAULT 'transition',
  from_status TEXT NOT NULL REFERENCES task_status_definitions(status) ON UPDATE CASCADE ON DELETE RESTRICT,
  to_status TEXT NOT NULL REFERENCES task_status_definitions(status) ON UPDATE CASCADE ON DELETE RESTRICT,
  manual_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  mark_started BOOLEAN NOT NULL DEFAULT FALSE,
  mark_completed BOOLEAN NOT NULL DEFAULT FALSE,
  clear_completed BOOLEAN NOT NULL DEFAULT FALSE,
  clear_failure BOOLEAN NOT NULL DEFAULT FALSE,
  reset_retry BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_key, from_status)
);

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

INSERT INTO task_status_definitions
  (status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order, description)
SELECT status,
       CASE
         WHEN status = 'queued'
         THEN NOT EXISTS (SELECT 1 FROM task_status_definitions WHERE initial)
         ELSE initial
       END AS initial,
       terminal,
       retryable,
       administrative,
       dispatchable,
       manual,
       sort_order,
       description
FROM (VALUES
  ('queued', TRUE, FALSE, FALSE, FALSE, TRUE, TRUE, 10, 'Ready for task-runner dispatch.'),
  ('running', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20, 'Claimed by a runner and actively executing.'),
  ('paused', FALSE, FALSE, FALSE, TRUE, FALSE, TRUE, 30, 'Held by an operator and eligible for manual resume.'),
  ('completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 40, 'Finished successfully.'),
  ('failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 50, 'Finished unsuccessfully and may be retried while retry budget remains.'),
  ('cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 60, 'Administratively cancelled.')
) AS canonical(status, initial, terminal, retryable, administrative, dispatchable, manual, sort_order, description)
ON CONFLICT (status) DO NOTHING;

INSERT INTO task_status_transitions
  (action_key, from_status, to_status, manual_allowed, mark_started, mark_completed, clear_completed, clear_failure, reset_retry)
VALUES
  ('claim', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('execute_now', 'queued', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('execute_now', 'paused', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('execute_now', 'failed', 'running', FALSE, TRUE, FALSE, TRUE, FALSE, FALSE),
  ('succeed', 'running', 'completed', FALSE, FALSE, TRUE, FALSE, TRUE, FALSE),
  ('fail', 'queued', 'failed', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('fail', 'paused', 'failed', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('fail', 'running', 'failed', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('retry', 'failed', 'queued', FALSE, FALSE, FALSE, TRUE, TRUE, TRUE),
  ('manual_pause', 'queued', 'paused', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
  ('manual_resume', 'paused', 'queued', TRUE, FALSE, FALSE, TRUE, FALSE, FALSE),
  ('administrative_cancel', 'queued', 'cancelled', TRUE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('administrative_cancel', 'paused', 'cancelled', TRUE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('administrative_cancel', 'running', 'cancelled', TRUE, FALSE, TRUE, FALSE, FALSE, FALSE),
  ('administrative_cancel', 'failed', 'cancelled', TRUE, FALSE, TRUE, FALSE, FALSE, FALSE)
ON CONFLICT (action_key, from_status) DO NOTHING;

ALTER TABLE tasks
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_fkey;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_fkey
  FOREIGN KEY (status)
  REFERENCES task_status_definitions(status)
  ON UPDATE CASCADE
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE tasks
  VALIDATE CONSTRAINT tasks_status_fkey;

CREATE OR REPLACE FUNCTION set_initial_task_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NULL OR BTRIM(NEW.status) = '' THEN
    SELECT definition.status
      INTO NEW.status
      FROM task_status_definitions definition
     WHERE definition.initial
     ORDER BY definition.sort_order, definition.status
     LIMIT 1;

    IF NEW.status IS NULL THEN
      RAISE EXCEPTION 'task lifecycle has no initial status configured';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_initial_status ON tasks;
CREATE TRIGGER trg_tasks_initial_status
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_initial_task_status();
