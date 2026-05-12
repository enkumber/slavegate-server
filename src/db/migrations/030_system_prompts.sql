-- 030_system_prompts.sql
-- System prompts table: allows runtime editing of agent prompts without rebuild.
-- Seeded with hardcoded defaults via application code on startup (ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS system_prompts (
  id          SERIAL      PRIMARY KEY,
  key         TEXT        NOT NULL UNIQUE,
  content     TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_prompts_key ON system_prompts(key);
