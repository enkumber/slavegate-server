ALTER TABLE phone_network_incidents
  ADD COLUMN IF NOT EXISTS incident_commander TEXT NOT NULL DEFAULT 'kraken',
  ADD COLUMN IF NOT EXISTS remediation_owner TEXT NULL,
  ADD COLUMN IF NOT EXISTS recovery_budget INT NULL,
  ADD COLUMN IF NOT EXISTS task_retry_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_by_task_id UUID NULL REFERENCES tasks(id) ON DELETE SET NULL;

UPDATE phone_network_incidents
SET incident_commander = 'kraken',
    assigned_agent = 'kraken'
WHERE incident_commander IS DISTINCT FROM 'kraken'
   OR assigned_agent IS DISTINCT FROM 'kraken';

ALTER TABLE phone_network_incident_events
  ADD COLUMN IF NOT EXISTS event_key TEXT NULL;

ALTER TABLE phone_network_incident_events
  DROP CONSTRAINT IF EXISTS phone_network_incident_events_event_type_check;

-- Event semantics are operator data, not a release-time constraint.

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_network_incident_events_event_key
  ON phone_network_incident_events(incident_id, event_key)
  WHERE event_key IS NOT NULL;

-- Promoted artifacts must carry an explicit safety class. Backfill only when
-- every executable primitive belongs to a generic read-only/navigation set;
-- anything else is quarantined fail-closed for manual review.
WITH classified AS (
  SELECT cache.cache_key,
         CASE
           WHEN NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(cache.workflow->'steps') = 'array'
                 THEN cache.workflow->'steps' ELSE '[]'::jsonb END
             ) step
             WHERE COALESCE(step->>'action', step->>'type', '') NOT IN (
               '', 'get_screen_state', 'ui_tree_dump', 'screenshot',
               'capture_screen', 'classify_ui_tree', 'wait', 'wait_for_idle'
             )
           ) THEN 'read_only'
           WHEN NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(cache.workflow->'steps') = 'array'
                 THEN cache.workflow->'steps' ELSE '[]'::jsonb END
             ) step
             WHERE COALESCE(step->>'action', step->>'type', '') NOT IN (
               '', 'get_screen_state', 'ui_tree_dump', 'screenshot',
               'capture_screen', 'classify_ui_tree', 'wait', 'wait_for_idle',
               'screen_wake', 'unlock', 'open_app', 'intent_send', 'tap',
               'a11y_find_tap', 'swipe', 'press_key'
             )
           ) THEN 'navigation'
           ELSE NULL
         END AS inferred_safety_class
  FROM generated_workflow_plan_cache cache
  WHERE cache.artifact_state = 'promoted'
    AND COALESCE(
      cache.compiled_plan #>> '{metadata,safetyClass}',
      cache.workflow ->> 'safetyClass',
      cache.source_metadata ->> 'safetyClass'
    ) IS NULL
), safe_backfill AS (
  UPDATE generated_workflow_plan_cache cache
  SET workflow = COALESCE(cache.workflow, '{}'::jsonb)
                   || jsonb_build_object('safetyClass', classified.inferred_safety_class),
      compiled_plan = COALESCE(cache.compiled_plan, '{}'::jsonb)
                   || jsonb_build_object(
                        'metadata',
                        COALESCE(cache.compiled_plan->'metadata', '{}'::jsonb)
                          || jsonb_build_object('safetyClass', classified.inferred_safety_class)
                      ),
      source_metadata = COALESCE(cache.source_metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'safetyClass', classified.inferred_safety_class,
                        'safetyClassBackfill', 'migration_095_generic_primitive_analysis'
                      ),
      updated_at = NOW()
  FROM classified
  WHERE cache.cache_key = classified.cache_key
    AND classified.inferred_safety_class IS NOT NULL
  RETURNING cache.cache_key
)
UPDATE generated_workflow_plan_cache cache
SET artifact_state = 'quarantined',
    source_metadata = COALESCE(cache.source_metadata, '{}'::jsonb)
      || jsonb_build_object(
           'quarantineReason', 'missing_explicit_safety_class',
           'quarantinedBy', 'migration_095_fail_closed'
         ),
    updated_at = NOW()
FROM classified
WHERE cache.cache_key = classified.cache_key
  AND classified.inferred_safety_class IS NULL;
