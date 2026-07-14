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
  CONSTRAINT chk_agency_workflow_step_library_promotion_events_action
    CHECK (action IN ('promote_limited', 'revoke')),
  CONSTRAINT chk_agency_workflow_step_library_promotion_events_library_state
    CHECK (library_state IN ('limited_reuse', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_step_library_promotion_events_step_created
  ON agency_workflow_step_library_promotion_events(step_candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_step_library_promotion_events_action_created
  ON agency_workflow_step_library_promotion_events(action, created_at DESC);

INSERT INTO agency_workflow_step_library_promotion_events (
  step_candidate_id,
  action,
  library_state,
  promotion_scope,
  note,
  actor,
  metadata,
  created_at
)
SELECT
  c.id,
  'promote_limited',
  'limited_reuse',
  c.promotion_scope,
  c.promotion_note,
  COALESCE(NULLIF(c.promoted_by, ''), 'dashboard'),
  jsonb_build_object('source', 'migration_backfill', 'backfilledFrom', 'promoted_at'),
  c.promoted_at
FROM agency_workflow_step_candidates c
WHERE c.candidate_state = 'validated_step'
  AND c.promoted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agency_workflow_step_library_promotion_events e
    WHERE e.step_candidate_id = c.id
      AND e.action = 'promote_limited'
      AND e.created_at = c.promoted_at
  );

INSERT INTO agency_workflow_step_library_promotion_events (
  step_candidate_id,
  action,
  library_state,
  promotion_scope,
  note,
  actor,
  metadata,
  created_at
)
SELECT
  c.id,
  'revoke',
  'revoked',
  c.promotion_scope,
  c.promotion_note,
  COALESCE(NULLIF(c.revoked_by, ''), 'dashboard'),
  jsonb_build_object('source', 'migration_backfill', 'backfilledFrom', 'revoked_at'),
  c.revoked_at
FROM agency_workflow_step_candidates c
WHERE c.candidate_state = 'validated_step'
  AND c.revoked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agency_workflow_step_library_promotion_events e
    WHERE e.step_candidate_id = c.id
      AND e.action = 'revoke'
      AND e.created_at = c.revoked_at
  );
