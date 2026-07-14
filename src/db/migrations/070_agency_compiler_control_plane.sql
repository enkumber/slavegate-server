-- Compiler Control Plane: versioned read-only policy gate state and dry-run audit.

CREATE TABLE IF NOT EXISTS agency_compiler_policy_gate_config (
  gate_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'blocked'
    CHECK (state IN ('blocked', 'review_ready', 'enabled')),
  version INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  risk TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL DEFAULT 'migration',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agency_compiler_policy_gate_config (gate_id, state, version, owner, risk, config)
VALUES
  ('compiler_tool_visibility', 'blocked', 1, 'engineering', 'medium', '{}'::jsonb),
  ('compiler_knowledge_application', 'blocked', 1, 'product', 'medium', '{}'::jsonb),
  ('step_compiler_eligibility', 'blocked', 1, 'qa', 'high', '{}'::jsonb),
  ('limited_reuse_scope_match', 'blocked', 1, 'qa', 'high', '{}'::jsonb),
  ('compiler_auto_use', 'blocked', 1, 'product', 'high', '{}'::jsonb),
  ('execution_path_change', 'blocked', 1, 'security', 'high', '{}'::jsonb)
ON CONFLICT (gate_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agency_compiler_control_plane_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent TEXT,
  action TEXT,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  requested_scope TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  limited_reuse_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  source TEXT NOT NULL DEFAULT 'dashboard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_compiler_control_plane_events_created
  ON agency_compiler_control_plane_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agency_compiler_control_plane_events_intent
  ON agency_compiler_control_plane_events(intent);
CREATE INDEX IF NOT EXISTS idx_agency_compiler_control_plane_events_device
  ON agency_compiler_control_plane_events(device_id);
