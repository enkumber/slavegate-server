-- Generic PostgreSQL authority for platform identifier canonicalization.
-- Release migrations create only schema/functions. Product alias rows are
-- operator/config data and must be managed outside semantic seeds.

CREATE TABLE IF NOT EXISTS platform_identifier_aliases (
  alias TEXT NOT NULL,
  canonical_platform TEXT NOT NULL REFERENCES app_runtime_profiles(app_id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(alias) <> ''),
  CHECK (btrim(canonical_platform) <> ''),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_identifier_aliases_active_alias
  ON platform_identifier_aliases (lower(btrim(alias)))
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_platform_identifier_aliases_canonical
  ON platform_identifier_aliases (canonical_platform)
  WHERE active;

CREATE OR REPLACE FUNCTION resolve_canonical_platform_identifier(p_identifier TEXT)
RETURNS TABLE(canonical_platform TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH input AS (
    SELECT lower(btrim(p_identifier)) AS identifier
  ),
  candidates AS (
    SELECT profile.app_id AS canonical_platform
      FROM app_runtime_profiles profile, input
     WHERE input.identifier <> ''
       AND profile.active
       AND lower(profile.app_id) = input.identifier
    UNION ALL
    SELECT profile.app_id AS canonical_platform
      FROM app_runtime_profiles profile, input
     WHERE input.identifier <> ''
       AND profile.active
       AND lower(profile.package_name) = input.identifier
    UNION ALL
    SELECT profile.app_id AS canonical_platform
      FROM platform_identifier_aliases alias
      JOIN app_runtime_profiles profile
        ON profile.app_id = alias.canonical_platform
       AND profile.active
      CROSS JOIN input
     WHERE input.identifier <> ''
       AND alias.active
       AND lower(btrim(alias.alias)) = input.identifier
  ),
  distinct_candidates AS (
    SELECT DISTINCT canonical_platform
      FROM candidates
  )
  SELECT canonical_platform
    FROM distinct_candidates
   WHERE (SELECT COUNT(*) FROM distinct_candidates) = 1;
$$;
