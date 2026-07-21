-- State-matching exceptions are application data owned by PostgreSQL, not
-- runtime conditionals. Search entry is a parent/precursor surface whose
-- generic toolbar anchors remain present inside the richer search results
-- surface, so the richer surface anchors must exclude the entry state.

UPDATE app_runtime_profiles
SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{stateDetectionOverrides}',
      COALESCE(metadata->'stateDetectionOverrides', '{}'::jsonb)
        || '{
          "reddit_search_entry": {
            "forbiddenAnchors": [
              "resourceId:search_bar",
              "resourceId:search_bar_top_app_bar"
            ]
          }
        }'::jsonb,
      TRUE
    ),
    profile_version = GREATEST(profile_version, 2),
    updated_at = NOW()
WHERE app_id = 'com.reddit.frontpage';
