-- 023_task_retry.sql
-- Add retry_count and updated_at columns to tasks table for retry logic

-- Add updated_at column (needed for retry backoff timing)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add retry_count column
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Update existing rows to have updated_at = created_at or NOW()
UPDATE tasks SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

-- Generic index for lifecycle-driven retry selection.
CREATE INDEX IF NOT EXISTS idx_tasks_retry_eligible 
ON tasks(status, retry_count, updated_at);

COMMENT ON COLUMN tasks.retry_count IS 'Number of retry attempts for failed tasks';
COMMENT ON COLUMN tasks.updated_at IS 'Last update timestamp for retry backoff calculation';
