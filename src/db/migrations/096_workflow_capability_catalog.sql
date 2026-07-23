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
  safety_class TEXT NOT NULL DEFAULT 'read_only'
    CHECK (safety_class IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive', 'destructive')),
  portability_scope TEXT NOT NULL DEFAULT 'global'
    CHECK (portability_scope IN ('global', 'contextual', 'device', 'account')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'degraded', 'quarantined', 'retired')),
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
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'degraded', 'quarantined', 'retired')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (capability_key, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_capabilities_platform_status
  ON workflow_capabilities(LOWER(platform), status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_capability_artifacts_lookup
  ON workflow_capability_artifacts(capability_key, role, status, priority, updated_at DESC);

-- Backfill artifacts that already carry an explicit capability identity.
WITH source AS (
  SELECT
    cache.cache_key,
    cache.source_metadata ->> 'capabilityKey' AS capability_key,
    cache.platform,
    COALESCE(
      cache.compiled_plan #>> '{metadata,safetyClass}',
      cache.workflow ->> 'safetyClass',
      cache.source_metadata ->> 'safetyClass',
      'read_only'
    ) AS safety_class,
    COALESCE(cache.source_metadata ->> 'portabilityScope', 'global') AS portability_scope,
    ARRAY_REMOVE(ARRAY[
      cache.source_metadata ->> 'intent',
      cache.workflow ->> 'intent',
      cache.workflow ->> 'name',
      cache.workflow ->> 'description'
    ], NULL) AS aliases,
    COALESCE(cache.source_metadata ->> 'capabilityRole', 'complete') AS role
  FROM generated_workflow_plan_cache cache
  WHERE cache.source_metadata ->> 'capabilityKey' ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND cache.artifact_state IN ('candidate', 'promoted')
), inserted_capabilities AS (
  INSERT INTO workflow_capabilities (
    capability_key, platform, description, aliases, safety_class, portability_scope, status, metadata
  )
  SELECT DISTINCT ON (capability_key)
    capability_key,
    platform,
    NULL,
    aliases,
    CASE
      WHEN safety_class IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive', 'destructive')
        THEN safety_class
      ELSE 'read_only'
    END,
    CASE
      WHEN portability_scope IN ('global', 'contextual', 'device', 'account')
        THEN portability_scope
      ELSE 'global'
    END,
    'active',
    jsonb_build_object('backfilledBy', 'migration_096')
  FROM source
  ORDER BY capability_key, cache_key
  ON CONFLICT (capability_key) DO UPDATE SET
    aliases = ARRAY(
      SELECT DISTINCT value
      FROM unnest(workflow_capabilities.aliases || EXCLUDED.aliases) AS value
      WHERE value IS NOT NULL AND BTRIM(value) <> ''
    ),
    updated_at = NOW()
  RETURNING capability_key
)
INSERT INTO workflow_capability_artifacts (capability_key, cache_key, role, status, evidence)
SELECT
  source.capability_key,
  source.cache_key,
  CASE WHEN source.role IN ('complete', 'fragment') THEN source.role ELSE 'complete' END,
  'active',
  jsonb_build_object('backfilledBy', 'migration_096')
FROM source
ON CONFLICT (capability_key, cache_key) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = NOW();
