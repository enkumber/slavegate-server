-- Workflow Definition Registry: declarative, versioned workflow definitions.
-- This migration creates mechanism only. Definitions are operator-managed data.

CREATE TABLE IF NOT EXISTS agency_workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  platform TEXT NOT NULL,
  intent TEXT NOT NULL,
  goal TEXT NOT NULL,
  source TEXT NOT NULL,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (definition_key, version)
);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_status
  ON agency_workflow_definitions(status);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_platform
  ON agency_workflow_definitions(platform);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_intent
  ON agency_workflow_definitions(intent);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_key
  ON agency_workflow_definitions(definition_key);
