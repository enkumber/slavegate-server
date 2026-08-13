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

CREATE OR REPLACE FUNCTION resolve_human_workflow_platform_binding(
  p_intent TEXT,
  p_account_platform TEXT
)
RETURNS TABLE(canonical_platform TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH workflow_platform AS (
    SELECT app_id
      FROM resolve_human_workflow_platform(p_intent)
  ),
  workflow_canonical AS (
    SELECT resolved.canonical_platform
      FROM workflow_platform
      JOIN LATERAL resolve_canonical_platform_identifier(workflow_platform.app_id) resolved
        ON TRUE
  ),
  account_canonical AS (
    SELECT canonical_platform
      FROM resolve_canonical_platform_identifier(p_account_platform)
  ),
  binding AS (
    SELECT account_canonical.canonical_platform
      FROM workflow_canonical
      JOIN account_canonical
        ON account_canonical.canonical_platform = workflow_canonical.canonical_platform
  )
  SELECT canonical_platform
    FROM binding
   WHERE (SELECT COUNT(*) FROM workflow_platform) = 1
     AND (SELECT COUNT(*) FROM workflow_canonical) = 1
     AND (SELECT COUNT(*) FROM account_canonical) = 1
     AND (SELECT COUNT(*) FROM binding) = 1;
$$;

CREATE OR REPLACE FUNCTION resolve_human_workflow_bound_target(
  p_device_id UUID,
  p_account_id UUID,
  p_intent TEXT
)
RETURNS TABLE(
  device_id UUID,
  device_model TEXT,
  device_name TEXT,
  account_id UUID,
  account_username TEXT,
  account_platform TEXT,
  account_device_id UUID,
  client_id UUID,
  canonical_account_platform TEXT,
  canonical_workflow_platform TEXT,
  platform_bound BOOLEAN,
  account_device_bound BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH target AS (
    SELECT
      d.id AS device_id,
      d.model AS device_model,
      d.friendly_name AS device_name,
      a.id AS account_id,
      a.username AS account_username,
      a.platform AS account_platform,
      a.device_id AS account_device_id,
      a.client_id AS client_id
    FROM devices d
    JOIN accounts a
      ON a.id = p_account_id
    WHERE d.id = p_device_id
  ),
  workflow_platform AS (
    SELECT app_id
      FROM resolve_human_workflow_platform(p_intent)
  ),
  workflow_canonical AS (
    SELECT resolved.canonical_platform
      FROM workflow_platform
      JOIN LATERAL resolve_canonical_platform_identifier(workflow_platform.app_id) resolved
        ON TRUE
  ),
  account_canonical AS (
    SELECT resolved.canonical_platform
      FROM target
      JOIN LATERAL resolve_canonical_platform_identifier(target.account_platform) resolved
        ON TRUE
  ),
  binding AS (
    SELECT
      target.*,
      account_canonical.canonical_platform AS canonical_account_platform,
      workflow_canonical.canonical_platform AS canonical_workflow_platform,
      account_canonical.canonical_platform = workflow_canonical.canonical_platform AS platform_bound,
      target.account_device_id = target.device_id AS account_device_bound
    FROM target
    CROSS JOIN account_canonical
    CROSS JOIN workflow_canonical
  )
  SELECT
    binding.device_id,
    binding.device_model,
    binding.device_name,
    binding.account_id,
    binding.account_username,
    binding.account_platform,
    binding.account_device_id,
    binding.client_id,
    binding.canonical_account_platform,
    binding.canonical_workflow_platform,
    binding.platform_bound,
    binding.account_device_bound
  FROM binding
  WHERE (SELECT COUNT(*) FROM target) = 1
    AND (SELECT COUNT(*) FROM workflow_platform) = 1
    AND (SELECT COUNT(*) FROM workflow_canonical) = 1
    AND (SELECT COUNT(*) FROM account_canonical) = 1
    AND (SELECT COUNT(*) FROM binding) = 1;
$$;
