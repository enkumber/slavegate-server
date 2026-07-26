-- Canonical UI graph runtime, selector-first observations, and controlled learning.
-- Existing app_maps remain authoritative during shadow rollout; these tables are
-- additive and support reversible, scoped promotion into the deterministic path.

CREATE TABLE IF NOT EXISTS ui_graph_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'screen'
    CHECK (kind IN ('screen', 'overlay', 'system', 'unknown')),
  safety_class TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, state_key)
);

CREATE TABLE IF NOT EXISTS ui_graph_state_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES ui_graph_states(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  signature_hash TEXT NULL,
  required_anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  optional_anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_version_pattern TEXT NULL,
  locale_pattern TEXT NULL,
  device_class TEXT NULL,
  confidence_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.72
    CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, variant_key)
);

CREATE TABLE IF NOT EXISTS ui_graph_selectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID NOT NULL REFERENCES ui_graph_states(id) ON DELETE CASCADE,
  element_key TEXT NOT NULL,
  strategy TEXT NOT NULL
    CHECK (strategy IN ('resource_id', 'content_description', 'semantic_id', 'text', 'text_contains', 'structural', 'normalized_coords')),
  selector JSONB NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  dynamic BOOLEAN NOT NULL DEFAULT FALSE,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT,
  app_version_pattern TEXT NULL,
  device_class TEXT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  last_validated_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (state_id, element_key, strategy, selector)
);

CREATE TABLE IF NOT EXISTS ui_graph_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  source_state_id UUID NOT NULL REFERENCES ui_graph_states(id) ON DELETE CASCADE,
  target_state_id UUID NOT NULL REFERENCES ui_graph_states(id) ON DELETE CASCADE,
  element_key TEXT NULL,
  action JSONB NOT NULL,
  preconditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  postconditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (cost > 0),
  safety_class TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, transition_key)
);

CREATE TABLE IF NOT EXISTS ui_graph_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  workflow_id TEXT NULL,
  step_id TEXT NULL,
  resolved_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  resolved_variant_id UUID NULL REFERENCES ui_graph_state_variants(id) ON DELETE SET NULL,
  resolution_method TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  fingerprint TEXT NULL,
  ui_tree_hash TEXT NULL,
  screenshot_artifact_id TEXT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ui_graph_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  workflow_id TEXT NULL,
  step_id TEXT NULL,
  source_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  target_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  state_resolution_method TEXT NOT NULL DEFAULT 'unknown',
  target_resolution_method TEXT NOT NULL DEFAULT 'unknown',
  outcome TEXT NOT NULL,
  latency_ms INT NOT NULL DEFAULT 0,
  llm_calls INT NOT NULL DEFAULT 0,
  vlm_calls INT NOT NULL DEFAULT 0,
  retry_count INT NOT NULL DEFAULT 0,
  reason TEXT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ui_graph_learning_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_key TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  candidate_type TEXT NOT NULL,
  status TEXT,
  source_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  target_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  contexts JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovery_method TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  distinct_context_count INT NOT NULL DEFAULT 0,
  safety_class TEXT NOT NULL,
  promoted_entity_id UUID NULL,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ NULL,
  quarantined_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ui_graph_candidate_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES ui_graph_learning_candidates(id) ON DELETE CASCADE,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  app_version TEXT NULL,
  locale TEXT NULL,
  device_class TEXT NULL,
  success BOOLEAN NOT NULL,
  state_verified BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ui_graph_promotion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES ui_graph_learning_candidates(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ui_graph_runtime_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL DEFAULT '*',
  mode TEXT NOT NULL,
  selector_first BOOLEAN NOT NULL DEFAULT TRUE,
  graph_runtime BOOLEAN NOT NULL DEFAULT TRUE,
  ai_recovery BOOLEAN NOT NULL DEFAULT TRUE,
  candidate_learning BOOLEAN NOT NULL DEFAULT TRUE,
  auto_promotion BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_type, scope_value)
);

CREATE TABLE IF NOT EXISTS ui_graph_runtime_checkpoints (
  workflow_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  target_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  current_state_id UUID NULL REFERENCES ui_graph_states(id) ON DELETE SET NULL,
  checkpoint JSONB NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ui_graph_variants_state ON ui_graph_state_variants(state_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_ui_graph_selectors_lookup ON ui_graph_selectors(state_id, element_key, status, priority);
CREATE INDEX IF NOT EXISTS idx_ui_graph_transitions_source ON ui_graph_transitions(source_state_id, status);
CREATE INDEX IF NOT EXISTS idx_ui_graph_observations_app_created ON ui_graph_observations(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_graph_action_events_app_created ON ui_graph_action_events(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_graph_candidates_status ON ui_graph_learning_candidates(status, candidate_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_graph_validations_candidate ON ui_graph_candidate_validations(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_graph_runtime_checkpoints_device ON ui_graph_runtime_checkpoints(device_id, updated_at DESC);
