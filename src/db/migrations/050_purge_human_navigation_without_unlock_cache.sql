DELETE FROM human_workflow_compile_jobs
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR (
     result->>'source' = 'llm'
     AND result->>'requestKey' = 'ad535072dfd1b00ec3750f25'
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR cache_key = '8264ce46d4fb9c789fad6e09'
   OR (
     source_metadata->>'source' = 'dashboard_human'
     AND (
       source_metadata->>'intent' ILIKE '%askreddit%'
       OR source_metadata->>'intent' ILIKE '%/askreddit%'
     )
     AND NOT workflow->'steps' @> '[{"type":"action","action":"unlock"}]'::jsonb
   );
