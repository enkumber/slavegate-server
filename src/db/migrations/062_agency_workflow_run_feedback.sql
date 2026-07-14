-- User feedback for dashboard/manual generated workflow runs.

ALTER TABLE agency_workflow_runs
  ADD COLUMN IF NOT EXISTS feedback_rating TEXT NULL,
  ADD COLUMN IF NOT EXISTS feedback_last_good_step_index INT NULL,
  ADD COLUMN IF NOT EXISTS feedback_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS feedback_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_agency_workflow_runs_feedback_rating'
  ) THEN
    ALTER TABLE agency_workflow_runs
      ADD CONSTRAINT chk_agency_workflow_runs_feedback_rating
      CHECK (feedback_rating IS NULL OR feedback_rating IN ('ok', 'not_ok', 'partial'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_agency_workflow_runs_feedback_partial_boundary'
  ) THEN
    ALTER TABLE agency_workflow_runs
      ADD CONSTRAINT chk_agency_workflow_runs_feedback_partial_boundary
      CHECK (
        feedback_rating IS NULL
        OR feedback_rating <> 'partial'
        OR feedback_last_good_step_index IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_agency_workflow_runs_feedback_last_good_nonnegative'
  ) THEN
    ALTER TABLE agency_workflow_runs
      ADD CONSTRAINT chk_agency_workflow_runs_feedback_last_good_nonnegative
      CHECK (feedback_last_good_step_index IS NULL OR feedback_last_good_step_index >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_feedback_rating
  ON agency_workflow_runs(feedback_rating)
  WHERE feedback_rating IS NOT NULL;
