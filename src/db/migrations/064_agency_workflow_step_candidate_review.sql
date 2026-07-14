-- Manual review metadata for step candidates.
-- Phase 3B allows keeping candidates in review or rejecting them; it does not
-- promote anything to validated_step.

ALTER TABLE agency_workflow_step_candidates
  ADD COLUMN IF NOT EXISTS review_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_reviewed_at
  ON agency_workflow_step_candidates(reviewed_at DESC)
  WHERE reviewed_at IS NOT NULL;
