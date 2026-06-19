UPDATE workflow_shortcuts
SET workflow_template = jsonb_set(
      jsonb_set(workflow_template, '{version}', '"1.1.0"'::jsonb),
      '{steps}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN step->>'id' = 'tap_first_post_comments' THEN
              jsonb_build_object(
                'id', 'tap_first_post_comments',
                'type', 'action',
                'action', 'semantic_tap',
                'params', jsonb_build_object(
                  'target', 'reddit.first_visible_post.open_comments',
                  'waitMs', 2000
                )
              )
            ELSE step
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(workflow_template->'steps') WITH ORDINALITY AS steps(step, ord)
      )
    ),
    metadata = metadata || '{"migration":"045_reddit_first_post_comments_semantic_tap"}'::jsonb,
    updated_at = NOW()
WHERE key = 'reddit_first_post_comments';

DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'a72b2ed5edde9bc384738b5b'
   OR canonical_workflow_id = 'dashboard_human_reddit_first_post_comments_v1'
   OR template_id = 'dashboard_human_reddit_first_post_comments_v1'
   OR source_metadata ->> 'shortcut' = 'reddit_first_post_comments';
