UPDATE workflow_shortcuts
SET workflow_template = jsonb_set(
      workflow_template,
      '{steps}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN step->>'id' = 'tap_first_post_comments' THEN
              jsonb_build_object(
                'id', 'tap_first_post_comments',
                'type', 'action',
                'action', 'a11y_find_tap',
                'params', jsonb_build_object(
                  'resourceId', 'com.reddit.frontpage:id/comments_stub',
                  'partialMatch', false
                )
              )
            ELSE step
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(workflow_template->'steps') WITH ORDINALITY AS steps(step, ord)
      )
    ),
    metadata = metadata || '{"migration":"041_reddit_first_post_comments_edge_tap"}'::jsonb,
    updated_at = NOW()
WHERE key = 'reddit_first_post_comments';
