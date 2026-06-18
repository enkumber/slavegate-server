UPDATE workflow_shortcuts
SET intent_patterns = '[
      {"type":"contains_all","locale":"ro","terms":["reddit","prima postare","comentarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","prima postare","comment","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","prima postare","comantarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","primul post","comentarii","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","primul post","comment","apasa"]},
      {"type":"contains_all","locale":"ro","terms":["reddit","primul post","comantarii","apasa"]},
      {"type":"contains_all","terms":["reddit","first post","comments","tap"]}
    ]'::jsonb,
    metadata = metadata || '{"migration":"039_reddit_first_post_comment_shortcut_variants"}'::jsonb,
    updated_at = NOW()
WHERE key = 'reddit_first_post_comments';
