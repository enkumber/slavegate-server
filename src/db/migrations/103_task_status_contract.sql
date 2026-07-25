-- Keep the persisted task status contract aligned with PATCH /api/tasks/:id.
-- Migration 011 predated administrative cancellation and omitted "cancelled",
-- so a request accepted by the API failed at the PostgreSQL constraint.

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'paused', 'cancelled'));

