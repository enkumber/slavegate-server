-- The task lifecycle is DB-authoritative as of 3.9.265. Keep this historical
-- migration idempotent without reinstalling a status-list CHECK constraint.

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;
