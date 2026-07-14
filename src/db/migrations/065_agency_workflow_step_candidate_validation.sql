-- Manual validation metadata for step candidates promoted to validated_step.
-- Validation is still not automatic reuse; downstream Step Library reuse remains
-- a separate controlled phase.

ALTER TABLE agency_workflow_step_candidates
  ADD COLUMN IF NOT EXISTS validation_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS validation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS validated_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_step_candidates_validated_at
  ON agency_workflow_step_candidates(validated_at DESC)
  WHERE validated_at IS NOT NULL;
