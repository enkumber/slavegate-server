-- A server-mode dashboard workflow cannot continue after an app update when
-- its BullMQ execution has stopped producing child-job events.  Leaving the
-- task/run rows as running makes request-key idempotency return the dead run
-- forever and prevents a real retry.
--
-- Edge workflows are deliberately excluded: they may legitimately continue
-- on the Android agent while the server is restarting.

WITH stale_runs AS (
  SELECT DISTINCT
    t.id AS task_id,
    r.id AS run_id
  FROM tasks t
  JOIN agency_workflow_runs r ON r.task_id = t.id
  WHERE t.status = 'running'
    AND r.status = 'running'
    AND t.routine = 'generated_workflow'
    AND t.params ->> 'source' = 'dashboard_human'
    AND t.started_at < NOW() - INTERVAL '5 minutes'
    AND EXISTS (
      SELECT 1
      FROM workflows w
      WHERE w.status IN ('queued', 'running', 'paused')
        AND w.checkpoint #>> '{executionStats,mode}' = 'server'
        AND (
          w.checkpoint #>> '{variables,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,agencyWorkflowRunId}' = r.id::text
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflows w
      JOIN job_execution_events e ON e.workflow_id = w.id
      WHERE w.status IN ('queued', 'running', 'paused')
        AND w.checkpoint #>> '{executionStats,mode}' = 'server'
        AND e.created_at > NOW() - INTERVAL '2 minutes'
        AND (
          w.checkpoint #>> '{variables,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,taskId}' = t.id::text
          OR w.checkpoint #>> '{variables,controlPlaneContext,agencyWorkflowRunId}' = r.id::text
        )
    )
),
failed_workflows AS (
  UPDATE workflows w
  SET status = 'failed',
      completed_at = NOW(),
      error = 'Stale dashboard human server workflow after app restart without recent execution events'
  FROM stale_runs s
  WHERE w.status IN ('queued', 'running', 'paused')
    AND w.checkpoint #>> '{executionStats,mode}' = 'server'
    AND (
      w.checkpoint #>> '{variables,taskId}' = s.task_id::text
      OR w.checkpoint #>> '{variables,controlPlaneContext,taskId}' = s.task_id::text
      OR w.checkpoint #>> '{variables,controlPlaneContext,agencyWorkflowRunId}' = s.run_id::text
    )
  RETURNING w.id
),
failed_tasks AS (
  UPDATE tasks t
  SET status = 'failed',
      completed_at = NOW(),
      updated_at = NOW(),
      error = 'Stale dashboard human server workflow after app restart without recent execution events',
      retry_count = COALESCE(t.retry_count, 0) + 1
  FROM stale_runs s
  WHERE t.id = s.task_id
  RETURNING t.id
)
UPDATE agency_workflow_runs r
SET status = 'failed',
    completed_at = NOW(),
    updated_at = NOW(),
    error = 'Stale dashboard human server workflow after app restart without recent execution events'
FROM stale_runs s
WHERE r.id = s.run_id;
