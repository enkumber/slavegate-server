-- Verified UI state-machine runtime.
--
-- The interpreter remains generic. Application states, selectors, transitions,
-- compatibility and promotion evidence are operational data.

UPDATE workflow_runtime_contracts
SET schema_version = GREATEST(schema_version, 3),
    allowed_actions = (
      SELECT jsonb_agg(value ORDER BY value)
      FROM (
        SELECT DISTINCT value
        FROM jsonb_array_elements_text(
          allowed_actions || '["observe_and_transition","run_state_machine"]'::jsonb
        ) AS actions(value)
      ) deduplicated
    ),
    limits = limits || '{
      "maxStateMachineIterations":100,
      "maxTransitionSelectors":20,
      "postconditionRequiredForTransitions":true,
      "oneTransitionPerObservation":true
    }'::jsonb,
    metadata = metadata || '{
      "verifiedTransitions":true,
      "stateMachineContract":"data_driven_fail_closed"
    }'::jsonb,
    updated_at = NOW()
WHERE contract_id = 'edge-workflow/v2';

ALTER TABLE ui_graph_learning_candidates
  ADD COLUMN IF NOT EXISTS validation_stage TEXT NOT NULL DEFAULT 'candidate';

ALTER TABLE ui_graph_learning_candidates
  DROP CONSTRAINT IF EXISTS chk_ui_graph_candidate_validation_stage;

ALTER TABLE ui_graph_learning_candidates
  ADD CONSTRAINT chk_ui_graph_candidate_validation_stage
  CHECK (validation_stage IN (
    'candidate', 'device_validated', 'cohort_validated', 'global_promoted'
  ));

UPDATE ui_graph_learning_candidates
SET validation_stage = CASE
  WHEN status = 'promoted' THEN 'global_promoted'
  WHEN status IN ('validating', 'degraded') THEN 'device_validated'
  ELSE 'candidate'
END
WHERE validation_stage = 'candidate';

ALTER TABLE ui_graph_candidate_validations
  ADD COLUMN IF NOT EXISTS android_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS app_build TEXT NULL,
  ADD COLUMN IF NOT EXISTS branch_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS initial_state_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS final_state_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS recovery_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ui_graph_state_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  ui_tree_hash TEXT NOT NULL,
  ui_tree TEXT NOT NULL,
  app_version TEXT NULL,
  android_version TEXT NULL,
  locale TEXT NULL,
  device_class TEXT NULL,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  workflow_id TEXT NULL,
  branch_key TEXT NULL,
  source TEXT NOT NULL DEFAULT 'edge_workflow'
    CHECK (source IN ('edge_workflow', 'canary', 'manual_gate', 'fixture')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, state_key, ui_tree_hash)
);

CREATE INDEX IF NOT EXISTS idx_ui_graph_state_snapshots_replay
  ON ui_graph_state_snapshots(app_id, state_key, app_version, android_version, created_at DESC);

CREATE TABLE IF NOT EXISTS ui_graph_candidate_coverage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES ui_graph_learning_candidates(id) ON DELETE CASCADE,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  app_version TEXT NULL,
  android_version TEXT NULL,
  locale TEXT NULL,
  device_class TEXT NULL,
  branch_key TEXT NOT NULL DEFAULT 'default',
  initial_state_key TEXT NULL,
  final_state_key TEXT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  recovery_count INT NOT NULL DEFAULT 0,
  state_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ui_graph_candidate_coverage_gate
  ON ui_graph_candidate_coverage(candidate_id, state_verified, branch_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ui_graph_candidate_coverage_context
  ON ui_graph_candidate_coverage(
    candidate_id,
    COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(app_version, ''),
    COALESCE(android_version, ''),
    COALESCE(device_class, ''),
    branch_key
  );

CREATE TABLE IF NOT EXISTS workflow_canary_cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'retired')),
  safety_classes JSONB NOT NULL DEFAULT '["read_only","navigation"]'::jsonb,
  required_distinct_devices INT NOT NULL DEFAULT 2 CHECK (required_distinct_devices > 0),
  required_distinct_branches INT NOT NULL DEFAULT 2 CHECK (required_distinct_branches > 0),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_canary_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id UUID NOT NULL REFERENCES workflow_canary_cohorts(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL REFERENCES generated_workflow_plan_cache(cache_key) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  workflow_id UUID NULL REFERENCES workflows(id) ON DELETE SET NULL,
  branch_key TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_count INT NOT NULL DEFAULT 0,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  UNIQUE (cohort_id, cache_key, device_id, branch_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_canary_runs_gate
  ON workflow_canary_runs(cache_key, status, postcondition_verified);

CREATE TABLE IF NOT EXISTS workflow_artifact_coverage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL REFERENCES generated_workflow_plan_cache(cache_key) ON DELETE CASCADE,
  device_id UUID NULL REFERENCES devices(id) ON DELETE SET NULL,
  branch_key TEXT NOT NULL DEFAULT 'default',
  app_version TEXT NULL,
  android_version TEXT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  recovery_count INT NOT NULL DEFAULT 0,
  postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_artifact_coverage_context
  ON workflow_artifact_coverage(
    cache_key,
    COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid),
    branch_key,
    COALESCE(app_version, ''),
    COALESCE(android_version, '')
  );

CREATE INDEX IF NOT EXISTS idx_workflow_artifact_coverage_gate
  ON workflow_artifact_coverage(cache_key, postcondition_verified, branch_key);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS root_error_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS root_error_message TEXT NULL,
  ADD COLUMN IF NOT EXISTS root_error_details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE agency_workflow_runs
  ADD COLUMN IF NOT EXISTS root_error_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS root_error_message TEXT NULL,
  ADD COLUMN IF NOT EXISTS root_error_details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tasks_root_error
  ON tasks(root_error_code, updated_at DESC)
  WHERE root_error_code IS NOT NULL;
