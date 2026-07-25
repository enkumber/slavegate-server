-- Generic, data-only workflow segment/composition control plane.
-- This migration intentionally contains no application, selector, URL,
-- capability, prompt, or workflow behavior.

CREATE TABLE IF NOT EXISTS workflow_segments (
  segment_key TEXT PRIMARY KEY
    CHECK (segment_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  description TEXT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_segment_versions (
  segment_key TEXT NOT NULL REFERENCES workflow_segments(segment_key) ON DELETE CASCADE,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  template JSONB NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NULL,
  postcondition_contract JSONB NULL,
  compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_key, version)
);

CREATE TABLE IF NOT EXISTS workflow_compositions (
  composition_name TEXT NOT NULL
    CHECK (composition_name ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  version TEXT NOT NULL,
  composition_key TEXT NOT NULL UNIQUE
    CHECK (composition_key ~ '^[a-f0-9]{24}$'),
  capability_key TEXT NOT NULL REFERENCES workflow_capabilities(capability_key) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  input_resolver JSONB NOT NULL,
  postcondition_contract JSONB NOT NULL,
  execution_policy JSONB NOT NULL,
  compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (composition_name, version)
);

CREATE TABLE IF NOT EXISTS workflow_composition_nodes (
  composition_name TEXT NOT NULL,
  composition_version TEXT NOT NULL,
  node_key TEXT NOT NULL
    CHECK (node_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  segment_key TEXT NOT NULL,
  segment_version TEXT NOT NULL,
  input_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
  depends_on TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (composition_name, composition_version, node_key),
  UNIQUE (composition_name, composition_version, ordinal),
  FOREIGN KEY (composition_name, composition_version)
    REFERENCES workflow_compositions(composition_name, version) ON DELETE CASCADE,
  FOREIGN KEY (segment_key, segment_version)
    REFERENCES workflow_segment_versions(segment_key, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS workflow_execution_bindings (
  request_key TEXT PRIMARY KEY CHECK (request_key ~ '^[a-f0-9]{24}$'),
  execution_key TEXT NOT NULL CHECK (execution_key ~ '^[a-f0-9]{24}$'),
  composition_name TEXT NOT NULL,
  composition_version TEXT NOT NULL,
  composition_key TEXT NOT NULL,
  segment_refs JSONB NOT NULL,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id UUID NULL,
  intent TEXT NOT NULL,
  runtime_inputs JSONB NOT NULL,
  status TEXT NOT NULL,
  postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
  result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (composition_name, composition_version)
    REFERENCES workflow_compositions(composition_name, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_workflow_execution_bindings_lookup
  ON workflow_execution_bindings(device_id, account_id, composition_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_execution_bindings_execution
  ON workflow_execution_bindings(execution_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_segment_coverage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_key TEXT NOT NULL,
  segment_version TEXT NOT NULL,
  device_id UUID NULL,
  app_version TEXT NOT NULL DEFAULT '',
  android_version TEXT NOT NULL DEFAULT '',
  input_class TEXT NOT NULL DEFAULT '',
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (segment_key, segment_version)
    REFERENCES workflow_segment_versions(segment_key, version) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_segment_coverage_scope
  ON workflow_segment_coverage(
    segment_key,
    segment_version,
    device_id,
    app_version,
    android_version,
    input_class
  ) NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS workflow_control_plane_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('segment', 'composition')),
  entity_key TEXT NOT NULL,
  entity_version TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'validate', 'canary', 'promote', 'degrade', 'quarantine', 'rollback', 'retire')),
  from_status TEXT NULL,
  to_status TEXT NULL,
  actor TEXT NULL,
  reason TEXT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_control_plane_events_entity
  ON workflow_control_plane_events(entity_type, entity_key, entity_version, created_at DESC);
