-- Read-only workflow validation pipeline audit events.
-- These events record validation previews; they do not promote, execute, or cache definitions.

CREATE TABLE IF NOT EXISTS agency_workflow_validation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID REFERENCES agency_workflow_definitions(id) ON DELETE SET NULL,
  definition_key TEXT,
  definition_version INTEGER,
  intent TEXT,
  platform TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  static_validation JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run JSONB NOT NULL DEFAULT '{}'::jsonb,
  smoke_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  canary_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  regression_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  source TEXT NOT NULL DEFAULT 'dashboard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_validation_events_created
  ON agency_workflow_validation_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_validation_events_definition
  ON agency_workflow_validation_events (definition_key, definition_version);

CREATE INDEX IF NOT EXISTS idx_workflow_validation_events_intent_platform
  ON agency_workflow_validation_events (intent, platform);
