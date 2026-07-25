-- Phase 1A generated workflow artifact lifecycle.

ALTER TABLE generated_workflow_plan_cache
  ADD COLUMN IF NOT EXISTS artifact_state TEXT;

-- Existing rows predate artifact lifecycle gates, so keep them conservative.
-- A separate audited allowlist/promotion step should mark known-good artifacts promoted.

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_state_request
  ON generated_workflow_plan_cache(artifact_state, request_key, updated_at DESC)
  WHERE request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_state_cache
  ON generated_workflow_plan_cache(artifact_state, cache_key);
