-- Append-only audit trail for explicit administrative reconciliation of
-- agency workflow runs. The run reference is intentionally not a foreign key:
-- audit evidence must survive later cleanup of failed workflow-run rows.

CREATE TABLE IF NOT EXISTS agency_workflow_run_admin_events (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL,
  task_id         UUID,
  workflow_ids    UUID[] NOT NULL DEFAULT '{}',
  action          TEXT NOT NULL CHECK (action IN ('admin_close')),
  actor_type      TEXT NOT NULL,
  actor_id        TEXT,
  reason          TEXT NOT NULL,
  previous_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  resulting_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_run_admin_events_run
  ON agency_workflow_run_admin_events(run_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION agency_workflow_run_admin_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'agency_workflow_run_admin_events is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agency_workflow_run_admin_events_no_update ON agency_workflow_run_admin_events;
CREATE TRIGGER agency_workflow_run_admin_events_no_update
  BEFORE UPDATE ON agency_workflow_run_admin_events
  FOR EACH ROW EXECUTE FUNCTION agency_workflow_run_admin_events_append_only();

DROP TRIGGER IF EXISTS agency_workflow_run_admin_events_no_delete ON agency_workflow_run_admin_events;
CREATE TRIGGER agency_workflow_run_admin_events_no_delete
  BEFORE DELETE ON agency_workflow_run_admin_events
  FOR EACH ROW EXECUTE FUNCTION agency_workflow_run_admin_events_append_only();
