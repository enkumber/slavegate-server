-- Purge the failed dashboard human compile/cache for Reddit contextual comments.
-- The old compiler treated user-requested comments as read-only and rejected
-- valid write actions such as type_text/vlm_generate_comment during validation.

DELETE FROM human_workflow_compile_jobs
WHERE request_key = 'd536b61d50299ecc2a839c1b'
   OR (
      platform = 'reddit'
      AND intent ILIKE '%greeceTravel%'
      AND intent ILIKE '%comentariu contextual%'
   );

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'd536b61d50299ecc2a839c1b'
   OR (
      source_metadata->>'platform' = 'reddit'
      AND source_metadata->>'intent' ILIKE '%greeceTravel%'
      AND source_metadata->>'intent' ILIKE '%comentariu contextual%'
   );
