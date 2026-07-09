DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR (
     source_metadata->>'source' = 'dashboard_human'
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(workflow->'steps') AS step(value)
       WHERE step.value->>'type' = 'action'
         AND step.value->>'action' = 'semantic_tap'
         AND NULLIF(BTRIM(COALESCE(step.value #>> '{params,target}', '')), '') IS NULL
     )
   );
