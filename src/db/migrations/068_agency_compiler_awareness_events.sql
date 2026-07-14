-- Append-only audit trail for read-only Compiler Awareness checks.
-- These events are observability only; they do not enable compiler reuse.

CREATE TABLE IF NOT EXISTS agency_compiler_awareness_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent TEXT NULL,
  action TEXT NULL,
  terms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidates JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL DEFAULT 'dashboard',
  source TEXT NOT NULL DEFAULT 'dashboard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agency_compiler_awareness_events_source
    CHECK (source IN ('dashboard', 'api', 'system')),
  CONSTRAINT chk_agency_compiler_awareness_events_policy_read_only
    CHECK (COALESCE((policy->>'readOnly')::boolean, false) = true),
  CONSTRAINT chk_agency_compiler_awareness_events_auto_use_disabled
    CHECK (COALESCE((policy->>'autoUseEnabled')::boolean, false) = false),
  CONSTRAINT chk_agency_compiler_awareness_events_execution_unchanged
    CHECK (COALESCE((policy->>'executionChanging')::boolean, true) = false)
);

CREATE INDEX IF NOT EXISTS idx_compiler_awareness_events_created
  ON agency_compiler_awareness_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compiler_awareness_events_action_created
  ON agency_compiler_awareness_events(action, created_at DESC);
