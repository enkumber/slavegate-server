-- Workflow Definition versioning, promotion hardening, and controlled auto-use gates.
-- These objects make policy decisions auditable. They still do not grant execution:
-- execution path and workflow cache changes remain blocked by policy.

ALTER TABLE agency_workflow_definitions
  ADD COLUMN IF NOT EXISTS parent_definition_id UUID REFERENCES agency_workflow_definitions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS telemetry_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS confidence_decay JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_hardening JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_definitions_parent
  ON agency_workflow_definitions(parent_definition_id);

CREATE TABLE IF NOT EXISTS agency_workflow_definition_version_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID REFERENCES agency_workflow_definitions(id) ON DELETE SET NULL,
  definition_key TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT NULL,
  next_status TEXT NULL,
  target_definition_id UUID REFERENCES agency_workflow_definitions(id) ON DELETE SET NULL,
  note TEXT NULL,
  actor TEXT NOT NULL,
  diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  impact_preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_definition_version_events_definition
  ON agency_workflow_definition_version_events(definition_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_definition_version_events_key
  ON agency_workflow_definition_version_events(definition_key, definition_version, created_at DESC);

CREATE TABLE IF NOT EXISTS agency_compiler_policy_gate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id TEXT NOT NULL,
  previous_state TEXT NULL,
  next_state TEXT NOT NULL,
  version INTEGER NOT NULL,
  note TEXT NULL,
  actor TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agency_workflow_definition_version_events
  ALTER COLUMN actor DROP DEFAULT;

ALTER TABLE agency_compiler_policy_gate_events
  ALTER COLUMN actor DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_compiler_policy_gate_events_gate
  ON agency_compiler_policy_gate_events(gate_id, created_at DESC);
