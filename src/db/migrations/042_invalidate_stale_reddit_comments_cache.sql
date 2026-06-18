DELETE FROM generated_workflow_plan_cache
WHERE request_key = 'a72b2ed5edde9bc384738b5b'
   OR (
        canonical_workflow_id = 'dashboard_human_reddit_first_post_comments_v1'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(workflow->'steps') AS steps(step)
          WHERE step->>'id' = 'tap_first_post_comments'
            AND (
              step->>'action' = 'tap'
              OR step->>'target' = 'post.comments'
              OR step->'params'->>'selectorName' = 'post.comments'
            )
        )
      );
