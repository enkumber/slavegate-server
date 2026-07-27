-- Controlled workflow definition promotion metadata.
-- This is manual/audited only; promoted definitions are still not compiler-visible
-- and do not change workflow cache or execution paths.

ALTER TABLE agency_workflow_definitions
  ADD COLUMN IF NOT EXISTS promotion_state TEXT,
  ADD COLUMN IF NOT EXISTS promotion_scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS promotion_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_promotion_state
  ON agency_workflow_definitions(promotion_state);

CREATE TABLE IF NOT EXISTS agency_workflow_definition_promotion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES agency_workflow_definitions(id) ON DELETE CASCADE,
  definition_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  previous_state TEXT NULL,
  next_state TEXT NOT NULL,
  promotion_scope TEXT NULL,
  note TEXT NULL,
  actor TEXT NOT NULL,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agency_workflow_definition_promotion_events
  ALTER COLUMN actor DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definition_promotion_events_definition
  ON agency_workflow_definition_promotion_events(definition_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definition_promotion_events_action
  ON agency_workflow_definition_promotion_events(action, created_at DESC);
