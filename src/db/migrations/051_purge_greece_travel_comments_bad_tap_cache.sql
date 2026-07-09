DELETE FROM human_workflow_compile_jobs
WHERE request_key = '551067af31093f4f084d60fa'
   OR (
     result->>'source' = 'llm'
     AND result->>'requestKey' = '551067af31093f4f084d60fa'
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = '551067af31093f4f084d60fa'
   OR canonical_workflow_id = 'workflow_greece_travel_comments'
   OR (
     source_metadata->>'source' = 'dashboard_human'
     AND (
       source_metadata->>'intent' ILIKE '%greecetravel%'
       OR source_metadata->>'intent' ILIKE '%greece travel%'
     )
     AND (
       source_metadata->>'intent' ILIKE '%comment%'
       OR source_metadata->>'intent' ILIKE '%comentarii%'
     )
   );
