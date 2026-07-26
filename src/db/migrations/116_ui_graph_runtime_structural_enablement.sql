-- Schema-only replacement for the legacy nominal UI Graph rollout mode.
-- Operators configure the boolean and feature flags directly in PostgreSQL.

ALTER TABLE ui_graph_runtime_flags
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NULL;

ALTER TABLE ui_graph_runtime_flags
  ALTER COLUMN mode DROP NOT NULL;
