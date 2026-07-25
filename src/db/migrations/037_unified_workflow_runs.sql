-- Unified workflow run surface for natural-language Phone Network workflows.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction          TEXT NOT NULL,
  app_id               TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  status               TEXT NOT NULL,
  discovery_ran        BOOLEAN NOT NULL DEFAULT FALSE,
  app_map_version      TEXT,
  compiled_workflow_id UUID,
  result               JSONB NOT NULL DEFAULT '{}'::jsonb,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_app_id ON workflow_runs(app_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_device_id ON workflow_runs(device_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at DESC);
