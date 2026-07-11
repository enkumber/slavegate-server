DELETE FROM human_workflow_compile_jobs
WHERE request_key = 'f6d2278d499174e65251d72a'
   OR (
     result->>'source' = 'llm'
     AND result->>'requestKey' = 'f6d2278d499174e65251d72a'
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'f6d2278d499174e65251d72a'
   OR cache_key = '082ef8b6df1e22108869f8cc'
   OR (
     source_metadata->>'source' = 'dashboard_human'
     AND source_metadata->>'platform' = 'android'
     AND (
       source_metadata->>'intent' ILIKE '%chrome%'
       OR source_metadata->>'intent' ILIKE '%browser%'
       OR source_metadata->>'intent' ILIKE '%gmail%'
     )
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(workflow->'steps') AS step(value)
       WHERE step.value->>'type' = 'action'
         AND step.value->>'action' = 'open_app'
         AND step.value->'params'->>'packageName' = 'android'
     )
   );
