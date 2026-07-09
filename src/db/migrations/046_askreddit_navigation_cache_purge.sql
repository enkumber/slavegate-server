UPDATE workflow_shortcuts
SET match_config = jsonb_set(
      match_config,
      '{rejectTerms}',
      (
        SELECT jsonb_agg(DISTINCT term ORDER BY term)
        FROM jsonb_array_elements_text(
          COALESCE(match_config->'rejectTerms', '[]'::jsonb) ||
          '["go to","mergi pe","/askreddit","askreddit","r/askreddit"]'::jsonb
        ) AS terms(term)
      )
    ),
    metadata = metadata || '{"migration":"046_askreddit_navigation_cache_purge"}'::jsonb,
    updated_at = NOW()
WHERE key = 'reddit_open_app';

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'ad535072dfd1b00ec3750f25'
   OR (
     canonical_workflow_id = 'dashboard_human_reddit_open_app_v1'
     AND platform = 'reddit'
     AND lower(COALESCE(source_metadata->>'intent', '')) LIKE '%askreddit%'
   );
