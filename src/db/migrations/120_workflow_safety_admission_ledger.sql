-- Generic workflow-safety admission ledger. Safety classes, approval rules,
-- scope composition, limits and budgets are runtime semantic data in
-- PostgreSQL; this migration introduces no product policy or lifecycle data.

CREATE TABLE IF NOT EXISTS workflow_safety_admission_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  safety_class TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  consumed_units NUMERIC NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (safety_class, scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_safety_admission_window
  ON workflow_safety_admission_ledger (safety_class, scope_key, created_at DESC);

ALTER TABLE agency_workflow_runs
  ADD COLUMN IF NOT EXISTS safety_admission_id UUID NULL
    REFERENCES workflow_safety_admission_ledger(id),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_workflow_runs_idempotency
  ON agency_workflow_runs (client_id, account_id, device_id, idempotency_key)
  NULLS NOT DISTINCT
  WHERE idempotency_key IS NOT NULL;
