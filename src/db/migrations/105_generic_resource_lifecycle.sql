-- Generic, DB-authoritative lifecycle registry.
-- Forward-only and idempotent. This migration creates mechanism only and does
-- not seed lifecycle keys, states, transitions, actions, or policy.

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

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_fkey;
DROP TRIGGER IF EXISTS trg_tasks_initial_status ON tasks;
DROP FUNCTION IF EXISTS set_initial_task_status();
DROP TABLE IF EXISTS task_status_transitions;
DROP TABLE IF EXISTS task_status_definitions;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lifecycle_key TEXT;
ALTER TABLE jobs ALTER COLUMN status DROP DEFAULT;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
