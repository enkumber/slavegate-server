-- No-code Workflow Definition execution.
-- Allows a promoted generated workflow artifact to become the executable body
-- for a Workflow Definition without a server code change.

ALTER TABLE agency_workflow_definition_version_events
  DROP CONSTRAINT IF EXISTS agency_workflow_definition_version_events_action_check;

ALTER TABLE agency_workflow_definition_version_events
  ADD CONSTRAINT agency_workflow_definition_version_events_action_check
  CHECK (action IN (
    'create_version',
    'archive',
    'deprecate',
    'activate',
    'draft',
    'hardening_preview',
    'auto_use_enablement',
    'auto_use_execution_queued',
    'executable_artifact_promoted'
  ));

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_definition_artifact
  ON generated_workflow_plan_cache (
    (source_metadata ->> 'definitionId'),
    (source_metadata ->> 'definitionKey'),
    (source_metadata ->> 'definitionVersion'),
    artifact_state,
    updated_at DESC
  );
