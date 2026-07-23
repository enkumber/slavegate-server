-- Goal contracts are mutable capability data. The compiler/runtime understand
-- only the generic schema; application vocabulary and output requirements live
-- in PostgreSQL and can be changed without another release.

INSERT INTO workflow_capabilities (
  capability_key,
  platform,
  description,
  aliases,
  safety_class,
  portability_scope,
  status,
  metadata
)
VALUES (
  'reddit_find_content',
  'android',
  'Find content related to a requested topic, open the selected entity, and return catalog-defined outputs.',
  ARRAY[
    'cauta un articol legat de un subiect',
    'caută un articol legat de un subiect',
    'cauta un articol legat de romania',
    'caută un articol legat de românia',
    'find an article related to a topic',
    'search content about a topic',
    'find reddit content'
  ]::TEXT[],
  'read_only',
  'global',
  'active',
  jsonb_build_object(
    'configuredBy', 'migration_098',
    'appId', 'reddit',
    'goalContract', jsonb_build_object(
      'version', '1',
      'allowedEffects', jsonb_build_array('none', 'observation', 'navigation', 'ui_input'),
      'requiredOutputs', jsonb_build_array('title', 'author', 'score'),
      'stages', jsonb_build_array(
        jsonb_build_object(
          'id', 'open_surface',
          'allowedActions', jsonb_build_array('open_app', 'a11y_find_tap', 'observe_and_transition'),
          'allowedEffects', jsonb_build_array('navigation')
        ),
        jsonb_build_object(
          'id', 'focus_input',
          'allowedActions', jsonb_build_array('a11y_find_tap', 'observe_and_transition'),
          'allowedEffects', jsonb_build_array('navigation'),
          'after', jsonb_build_array('open_surface')
        ),
        jsonb_build_object(
          'id', 'enter_input',
          'allowedActions', jsonb_build_array('type_text', 'set_focused_text'),
          'allowedEffects', jsonb_build_array('ui_input'),
          'after', jsonb_build_array('focus_input')
        ),
        jsonb_build_object(
          'id', 'submit_input',
          'allowedActions', jsonb_build_array('press_key', 'a11y_find_tap', 'observe_and_transition'),
          'allowedEffects', jsonb_build_array('ui_input', 'navigation'),
          'after', jsonb_build_array('enter_input')
        ),
        jsonb_build_object(
          'id', 'observe_candidates',
          'allowedActions', jsonb_build_array('classify_ui_tree'),
          'allowedEffects', jsonb_build_array('observation'),
          'after', jsonb_build_array('submit_input'),
          'produces', jsonb_build_array('candidateTitle')
        ),
        jsonb_build_object(
          'id', 'select_candidate',
          'allowedActions', jsonb_build_array('a11y_find_tap', 'observe_and_transition'),
          'allowedEffects', jsonb_build_array('navigation'),
          'after', jsonb_build_array('observe_candidates'),
          'consumes', jsonb_build_array('candidateTitle')
        ),
        jsonb_build_object(
          'id', 'extract_outputs',
          'allowedActions', jsonb_build_array('classify_ui_tree'),
          'allowedEffects', jsonb_build_array('observation'),
          'after', jsonb_build_array('select_candidate'),
          'produces', jsonb_build_array('title', 'author', 'score')
        )
      )
    )
  )
)
ON CONFLICT (capability_key) DO UPDATE SET
  platform = EXCLUDED.platform,
  description = EXCLUDED.description,
  aliases = ARRAY(
    SELECT DISTINCT value
    FROM unnest(workflow_capabilities.aliases || EXCLUDED.aliases) AS value
    WHERE value IS NOT NULL AND BTRIM(value) <> ''
  ),
  safety_class = EXCLUDED.safety_class,
  portability_scope = EXCLUDED.portability_scope,
  status = EXCLUDED.status,
  metadata = workflow_capabilities.metadata || EXCLUDED.metadata,
  updated_at = NOW();
