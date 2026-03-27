-- 022_task_runner_columns.sql
-- Add result and error columns to tasks table for Task Runner

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error TEXT;

-- Index for finding failed tasks by error pattern
CREATE INDEX IF NOT EXISTS idx_tasks_error ON tasks(error) WHERE error IS NOT NULL;

COMMENT ON COLUMN tasks.result IS 'Task execution result (steps completed, token usage, duration)';
COMMENT ON COLUMN tasks.error IS 'Error message if task failed';
