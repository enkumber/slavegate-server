-- 023_task_retry.sql
-- Add retry_count column to tasks table for retry logic

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Index for finding failed tasks eligible for retry
CREATE INDEX IF NOT EXISTS idx_tasks_retry_eligible 
ON tasks(status, retry_count, updated_at) 
WHERE status = 'failed';

COMMENT ON COLUMN tasks.retry_count IS 'Number of retry attempts for failed tasks';
