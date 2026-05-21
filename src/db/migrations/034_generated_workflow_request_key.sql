-- Goal/context-level cache key for generated workflows.
-- Unlike compiledPlan.cacheKey, request_key is known before calling an LLM,
-- so agents can check for an existing validated plan first.

ALTER TABLE generated_workflow_plan_cache
  ADD COLUMN IF NOT EXISTS request_key TEXT;

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_request_key
  ON generated_workflow_plan_cache(request_key);

