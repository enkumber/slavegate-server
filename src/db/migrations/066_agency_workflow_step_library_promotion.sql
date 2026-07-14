-- Explicit promotion controls for manually validated Step Library entries.
-- Limited reuse is review/admin visible only in this phase; compiler auto-use
-- stays disabled until a later policy-controlled compiler integration.

ALTER TABLE agency_workflow_step_candidates
  ADD COLUMN IF NOT EXISTS library_state TEXT NOT NULL DEFAULT 'review_only',
  ADD COLUMN IF NOT EXISTS promotion_scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS promotion_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_agency_workflow_step_candidates_library_state'
  ) THEN
    ALTER TABLE agency_workflow_step_candidates
      ADD CONSTRAINT chk_agency_workflow_step_candidates_library_state
      CHECK (library_state IN ('review_only', 'limited_reuse', 'revoked'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_library_state
  ON agency_workflow_step_candidates(library_state, updated_at DESC)
  WHERE candidate_state = 'validated_step';

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_promoted_at
  ON agency_workflow_step_candidates(promoted_at DESC)
  WHERE promoted_at IS NOT NULL;
