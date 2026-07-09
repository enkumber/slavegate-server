DELETE FROM human_workflow_compile_jobs
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR (
     result->>'source' = 'llm'
     AND result->>'requestKey' = 'ad535072dfd1b00ec3750f25'
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR cache_key = 'e2c7ea35d2b29c46b598834d'
   OR (
     source_metadata->>'source' = 'dashboard_human'
     AND workflow->'steps' @> '[{"type":"action","action":"open_app"}]'::jsonb
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(workflow->'steps') AS step(value)
       WHERE step.value->>'type' = 'action'
         AND step.value->>'action' = 'open_app'
         AND step.value->'params' ? 'uri'
     )
   );
