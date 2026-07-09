-- Purge Reddit contextual-comment human workflow artifacts generated before
-- semantic_tap targeted the real comments button and comment generation used
-- the configured server LLM instead of the unavailable OpenClaw CLI.

DELETE FROM human_workflow_compile_jobs
WHERE request_key = 'd536b61d50299ecc2a839c1b'
   OR (
      platform = 'reddit'
      AND intent ILIKE '%greeceTravel%'
      AND (
        intent ILIKE '%comentariu contextual%'
        OR intent ILIKE '%comentariu%'
        OR intent ILIKE '%comment%'
      )
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'd536b61d50299ecc2a839c1b'
   OR canonical_workflow_id = 'reddit_greece_travel_comment_workflow'
   OR (
      source_metadata->>'platform' = 'reddit'
      AND source_metadata->>'intent' ILIKE '%greeceTravel%'
      AND (
        source_metadata->>'intent' ILIKE '%comentariu contextual%'
        OR source_metadata->>'intent' ILIKE '%comentariu%'
        OR source_metadata->>'intent' ILIKE '%comment%'
      )
   );
