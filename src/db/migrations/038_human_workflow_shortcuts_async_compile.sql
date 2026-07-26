-- Generic persistence for operator-managed workflow shortcuts and asynchronous
-- compile jobs. Product shortcuts, lifecycle states, action keys, and policy
-- are configured separately in PostgreSQL and are never packaged in a release.

CREATE TABLE IF NOT EXISTS workflow_shortcuts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  intent_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  match_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_template JSONB NOT NULL,
  compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_shortcuts_platform_status_idx
  ON workflow_shortcuts(platform, status, priority);

CREATE TABLE IF NOT EXISTS human_workflow_compile_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL,
  account_id UUID NOT NULL,
  intent TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  cache_key TEXT,
  source TEXT,
  shortcut_id UUID REFERENCES workflow_shortcuts(id),
  error TEXT,
  result JSONB,
  llm_started_at TIMESTAMPTZ,
  llm_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS human_workflow_compile_jobs_status_idx
  ON human_workflow_compile_jobs(status, created_at);
