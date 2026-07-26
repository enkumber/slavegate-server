-- Data-driven capability catalog for retrieval-before-LLM compilation.
-- Mutable capability identity, aliases, thresholds, and artifact bindings live
-- in PostgreSQL. Runtime safety enforcement remains in server code.

CREATE TABLE IF NOT EXISTS workflow_capabilities (
  capability_key TEXT PRIMARY KEY
    CHECK (capability_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  platform TEXT NOT NULL,
  description TEXT NULL,
  aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_terms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  forbidden_terms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  safety_class TEXT NOT NULL,
  portability_scope TEXT NOT NULL,
  compiler_retrievable BOOLEAN NOT NULL,
  status TEXT,
  min_match_score DOUBLE PRECISION NOT NULL DEFAULT 0.62
    CHECK (min_match_score >= 0 AND min_match_score <= 1),
  ambiguity_margin DOUBLE PRECISION NOT NULL DEFAULT 0.12
    CHECK (ambiguity_margin >= 0 AND ambiguity_margin <= 1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_capability_artifacts (
  capability_key TEXT NOT NULL REFERENCES workflow_capabilities(capability_key) ON DELETE CASCADE,
  cache_key TEXT NOT NULL REFERENCES generated_workflow_plan_cache(cache_key) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'complete'
    CHECK (role IN ('complete', 'fragment')),
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INT NOT NULL DEFAULT 100,
  status TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (capability_key, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_capabilities_platform_status
  ON workflow_capabilities(LOWER(platform), status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_capability_artifacts_lookup
  ON workflow_capability_artifacts(capability_key, role, status, priority, updated_at DESC);
