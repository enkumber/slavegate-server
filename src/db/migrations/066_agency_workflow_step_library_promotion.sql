-- Explicit promotion controls for manually validated Step Library entries.
-- Limited reuse is review/admin visible only in this phase; compiler auto-use
-- stays disabled until a later policy-controlled compiler integration.

ALTER TABLE agency_workflow_step_candidates
  ADD COLUMN IF NOT EXISTS library_state TEXT,
  ADD COLUMN IF NOT EXISTS promotion_scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS promotion_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_library_state
  ON agency_workflow_step_candidates(library_state, candidate_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_promoted_at
  ON agency_workflow_step_candidates(promoted_at DESC)
  WHERE promoted_at IS NOT NULL;
