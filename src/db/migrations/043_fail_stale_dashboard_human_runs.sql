-- Fail dashboard-human generated workflow runs left running after the edge
-- workflow disappeared, was cancelled, or failed before task-runner observed a
-- final status. This prevents request-key idempotency from reusing stale runs.

WITH stale_runs AS (
  SELECT
    t.id AS task_id,
    r.id AS run_id
  FROM tasks t
  JOIN agency_workflow_runs r ON r.task_id = t.id
  WHERE t.status = 'running'
    AND r.status = 'running'
    AND t.routine = 'generated_workflow'
    AND t.params ->> 'source' = 'dashboard_human'
    AND t.started_at < NOW() - INTERVAL '5 minutes'
    AND NOT EXISTS (
      SELECT 1
      FROM workflows w
      WHERE w.status IN ('queued', 'running', 'paused')
        AND (
          w.checkpoint #>> '{variables,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,agencyWorkflowRunId}' = r.id::text
        )
    )
),
failed_tasks AS (
  UPDATE tasks t
  SET status = 'failed',
      completed_at = NOW(),
      updated_at = NOW(),
      error = 'Stale dashboard human workflow run after edge dispatch without acknowledgement',
      retry_count = COALESCE(t.retry_count, 0) + 1
  FROM stale_runs s
  WHERE t.id = s.task_id
  RETURNING t.id
)
UPDATE agency_workflow_runs r
SET status = 'failed',
    completed_at = NOW(),
    updated_at = NOW(),
    error = 'Stale dashboard human workflow run after edge dispatch without acknowledgement'
FROM stale_runs s
WHERE r.id = s.run_id;
