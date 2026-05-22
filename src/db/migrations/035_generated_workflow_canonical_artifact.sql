-- Canonical artifact metadata for generated workflow plan cache.
-- This makes cache-first execution auditable: a requestKey/cacheKey maps to
-- a stable canonical workflow artifact, compiled plan hash, and source metadata.

ALTER TABLE generated_workflow_plan_cache
  ADD COLUMN IF NOT EXISTS canonical_workflow_id TEXT,
  ADD COLUMN IF NOT EXISTS canonical_workflow_version TEXT,
  ADD COLUMN IF NOT EXISTS compiled_plan_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE generated_workflow_plan_cache
SET
  canonical_workflow_id = COALESCE(canonical_workflow_id, template_id),
  canonical_workflow_version = COALESCE(canonical_workflow_version, template_version),
  compiled_plan_hash = COALESCE(compiled_plan_hash, cache_key),
  source_metadata = COALESCE(source_metadata, '{}'::jsonb);

ALTER TABLE generated_workflow_plan_cache
  ALTER COLUMN canonical_workflow_id SET NOT NULL,
  ALTER COLUMN canonical_workflow_version SET NOT NULL,
  ALTER COLUMN compiled_plan_hash SET NOT NULL,
  ALTER COLUMN source_metadata SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_canonical
  ON generated_workflow_plan_cache(canonical_workflow_id, canonical_workflow_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_request_canonical
  ON generated_workflow_plan_cache(request_key, canonical_workflow_id, canonical_workflow_version)
  WHERE request_key IS NOT NULL;
