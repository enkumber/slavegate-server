-- Minimal control-plane run ledger for canonical generated workflow execution.

CREATE TABLE IF NOT EXISTS agency_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NULL REFERENCES clients(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  task_id UUID NULL REFERENCES tasks(id),
  workflow_id UUID NULL REFERENCES workflows(id),
  platform TEXT NOT NULL,
  intent TEXT NOT NULL,
  safety_class TEXT NOT NULL,
  request_key TEXT NULL,
  cache_key TEXT NULL,
  canonical_workflow_id TEXT NOT NULL,
  canonical_workflow_version TEXT NOT NULL,
  compiled_plan_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  recovery_requests INT NOT NULL DEFAULT 0,
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_agency_workflow_runs_cache_handle CHECK (
    (request_key IS NOT NULL AND cache_key IS NULL)
    OR (request_key IS NULL AND cache_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_client ON agency_workflow_runs(client_id);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_account ON agency_workflow_runs(account_id);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_device ON agency_workflow_runs(device_id);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_status ON agency_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_intent ON agency_workflow_runs(intent);
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_request_key ON agency_workflow_runs(request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_cache_key ON agency_workflow_runs(cache_key) WHERE cache_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_workflow_runs_task ON agency_workflow_runs(task_id) WHERE task_id IS NOT NULL;
