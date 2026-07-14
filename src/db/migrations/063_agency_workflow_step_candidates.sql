-- Step candidates nominated from Partial dashboard feedback.
-- These are review inbox entries, not reusable Step Library records.

CREATE TABLE IF NOT EXISTS agency_workflow_step_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agency_workflow_runs(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  step_id TEXT NULL,
  label TEXT NOT NULL,
  action TEXT NULL,
  type TEXT NULL,
  step_status TEXT NULL,
  candidate_state TEXT NOT NULL DEFAULT 'step_candidate',
  request_key TEXT NULL,
  cache_key TEXT NULL,
  canonical_workflow_id TEXT NULL,
  canonical_workflow_version TEXT NULL,
  last_good_step_index INT NOT NULL,
  step_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agency_workflow_step_candidates_state
    CHECK (candidate_state IN ('step_candidate', 'validated_step', 'rejected')),
  CONSTRAINT chk_agency_workflow_step_candidates_step_index
    CHECK (step_index >= 0),
  CONSTRAINT chk_agency_workflow_step_candidates_last_good
    CHECK (last_good_step_index >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_run_step
  ON agency_workflow_step_candidates(run_id, step_index);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_state
  ON agency_workflow_step_candidates(candidate_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_run
  ON agency_workflow_step_candidates(run_id, step_index);
