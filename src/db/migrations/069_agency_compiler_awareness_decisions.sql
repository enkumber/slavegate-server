-- Decision outcome for read-only Compiler Awareness audit events.
-- This is observability only and must never enable execution.

ALTER TABLE agency_compiler_awareness_events
  ADD COLUMN IF NOT EXISTS decision JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_compiler_awareness_events_decision_outcome
  ON agency_compiler_awareness_events((decision->>'outcome'), created_at DESC);
