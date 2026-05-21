-- Cache compiled plans for dynamically generated workflow templates.
-- The cache key is generated from validated template fields that affect
-- deterministic execution. Agents can reuse the cached plan for identical
-- goals/context instead of calling an LLM again.

CREATE TABLE IF NOT EXISTS generated_workflow_plan_cache (
  cache_key        TEXT PRIMARY KEY,
  template_id      TEXT NOT NULL,
  platform         TEXT NOT NULL,
  template_version TEXT NOT NULL,
  workflow         JSONB NOT NULL,
  compiled_plan    JSONB NOT NULL,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_template
  ON generated_workflow_plan_cache(template_id);

CREATE INDEX IF NOT EXISTS idx_generated_workflow_plan_cache_platform
  ON generated_workflow_plan_cache(platform);

