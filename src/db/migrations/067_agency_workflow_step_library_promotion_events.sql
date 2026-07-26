-- Append-only audit trail for Step Library promotion decisions.
-- This is dashboard/audit visibility only; it does not enable compiler reuse.

CREATE TABLE IF NOT EXISTS agency_workflow_step_library_promotion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_candidate_id UUID NOT NULL REFERENCES agency_workflow_step_candidates(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  library_state TEXT NOT NULL,
  promotion_scope TEXT NULL,
  note TEXT NULL,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agency_workflow_step_library_promotion_events_action_present
    CHECK (NULLIF(BTRIM(action), '') IS NOT NULL),
  CONSTRAINT chk_agency_workflow_step_library_promotion_events_library_state_present
    CHECK (NULLIF(BTRIM(library_state), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_step_library_promotion_events_step_created
  ON agency_workflow_step_library_promotion_events(step_candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_step_library_promotion_events_action_created
  ON agency_workflow_step_library_promotion_events(action, created_at DESC);
