-- Schema-only replacement for the legacy nominal UI Graph rollout mode.
-- Operators configure the boolean and feature flags directly in PostgreSQL.

ALTER TABLE ui_graph_runtime_flags
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NULL;

ALTER TABLE ui_graph_runtime_flags
  ALTER COLUMN mode DROP NOT NULL;

-- Runtime semantic entries participate in the generic lifecycle registry.
-- The column carries only operator-configured binding identity; no lifecycle
-- key, state, transition, or policy is packaged by this migration.
ALTER TABLE runtime_semantic_entries
  ADD COLUMN IF NOT EXISTS lifecycle_key TEXT NULL;
