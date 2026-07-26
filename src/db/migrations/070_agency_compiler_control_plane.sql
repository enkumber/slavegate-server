-- Compiler Control Plane: versioned read-only policy gate state and dry-run audit.

CREATE TABLE IF NOT EXISTS agency_compiler_policy_gate_config (
  gate_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  risk TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL DEFAULT 'migration',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
