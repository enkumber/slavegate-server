-- Plan cache for multi-agent orchestrator
-- Saves successful plans for reuse on similar tasks (-50% cost, -27% latency)

CREATE TABLE IF NOT EXISTS plan_cache (
  id            SERIAL PRIMARY KEY,
  task_hash     VARCHAR(64) NOT NULL,        -- SHA-256 of normalized task+platform
  task_text     TEXT NOT NULL,                -- Original task text (for debugging)
  platform      VARCHAR(32) NOT NULL,        -- "instagram", "tiktok", etc.
  steps_json    JSONB NOT NULL,              -- PlannerOutput as JSON
  complexity    VARCHAR(16),                 -- "simple" | "medium" | "complex"
  hit_count     INTEGER NOT NULL DEFAULT 0,  -- How many times this plan was reused
  success_count INTEGER NOT NULL DEFAULT 0,  -- How many times reuse succeeded
  fail_count    INTEGER NOT NULL DEFAULT 0,  -- How many times reuse failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  UNIQUE(task_hash, platform)
);

CREATE INDEX IF NOT EXISTS idx_plan_cache_lookup ON plan_cache (task_hash, platform);
