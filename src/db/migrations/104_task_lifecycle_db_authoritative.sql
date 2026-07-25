-- Historical task-specific lifecycle registry retired.
-- Lifecycle schema and bindings are installed by the generic migrations.
-- This migration deliberately contains no lifecycle key, state, transition,
-- action, initial state, terminality, retry, or dispatch policy.

DROP TRIGGER IF EXISTS trg_tasks_initial_status ON tasks;
DROP FUNCTION IF EXISTS set_initial_task_status();
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_fkey;
DROP TABLE IF EXISTS task_status_transitions;
DROP TABLE IF EXISTS task_status_definitions;
