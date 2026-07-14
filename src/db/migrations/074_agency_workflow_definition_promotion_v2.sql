-- Controlled workflow definition promotion v2.
-- Adds manual-only readiness, confidence, scope, and rollback preview metadata.
-- These fields are explanatory and audited; they do not make definitions compiler-visible
-- and do not change workflow cache or execution paths.

ALTER TABLE agency_workflow_definitions
  ADD COLUMN IF NOT EXISTS promotion_confidence NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_scope_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_definition_id UUID NULL,
  ADD COLUMN IF NOT EXISTS rollback_preview JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_rollback_definition
  ON agency_workflow_definitions(rollback_definition_id);

ALTER TABLE agency_workflow_definition_promotion_events
  ADD COLUMN IF NOT EXISTS promotion_confidence NUMERIC(5, 2) NULL,
  ADD COLUMN IF NOT EXISTS promotion_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_scope_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_preview JSONB NOT NULL DEFAULT '{}'::jsonb;
