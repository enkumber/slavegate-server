-- Purge failed generated workflow artifacts from the executable surfaces.
--
-- Run history cleanup is handled by the explicit admin endpoint so operators can
-- preview and report how many failed runs are removed. This migration only
-- clears failed/cancelled compile state and generated cache artifacts tied to
-- failed runs or explicit failed/quarantined artifact states.

WITH failed_handles AS (
  SELECT request_key, cache_key
  FROM human_workflow_compile_jobs
  WHERE status IN ('failed', 'cancelled')

  UNION

  SELECT r.request_key, r.cache_key
  FROM agency_workflow_runs r
  LEFT JOIN tasks t ON t.id = r.task_id
  WHERE r.status = 'failed'
     OR t.status = 'failed'
)
DELETE FROM generated_workflow_plan_cache c
USING failed_handles h
WHERE (h.request_key IS NOT NULL AND c.request_key = h.request_key)
   OR (h.cache_key IS NOT NULL AND c.cache_key = h.cache_key);

DELETE FROM generated_workflow_plan_cache
WHERE artifact_state IN ('failed', 'quarantined');

DELETE FROM human_workflow_compile_jobs
WHERE status IN ('failed', 'cancelled');
