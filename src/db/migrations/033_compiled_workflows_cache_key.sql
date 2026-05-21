-- Fix Workflow Compiler cache lookup.
-- planner.service.ts reads/writes compiled_workflows.cache_key, but older
-- installs may have created the table before that column existed.

ALTER TABLE compiled_workflows
  ADD COLUMN IF NOT EXISTS cache_key TEXT;

CREATE INDEX IF NOT EXISTS idx_compiled_workflows_cache_key
  ON compiled_workflows(cache_key);

