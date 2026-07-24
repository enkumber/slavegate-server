-- Generic PostgreSQL compiler lookup primitives only. Product capabilities,
-- prompts, profiles, policies and workflows are managed live through the
-- control plane and are never inserted or updated by release migrations.

CREATE OR REPLACE FUNCTION compiler_tokens(value TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT token
      FROM unnest(regexp_split_to_array(lower(value), '[^[:alnum:]_]+')) AS token
      WHERE length(token) >= 2
      ORDER BY token
    ),
    ARRAY[]::TEXT[]
  )
$$;

CREATE OR REPLACE FUNCTION resolve_human_workflow_platform(p_intent TEXT)
RETURNS TABLE (
  app_id TEXT,
  package_name TEXT,
  app_name TEXT,
  match_score INTEGER
)
LANGUAGE sql
STABLE
AS $$
  WITH candidates AS (
    SELECT
      profile.app_id,
      profile.package_name,
      profile.app_name,
      GREATEST(
        CASE WHEN position(lower(profile.app_id) IN lower(p_intent)) > 0 THEN length(profile.app_id) ELSE 0 END,
        CASE WHEN position(lower(profile.package_name) IN lower(p_intent)) > 0 THEN length(profile.package_name) ELSE 0 END,
        CASE WHEN position(lower(profile.app_name) IN lower(p_intent)) > 0 THEN length(profile.app_name) ELSE 0 END,
        COALESCE((
          SELECT max(length(alias))
          FROM jsonb_array_elements_text(COALESCE(profile.metadata->'compilerAliases', '[]'::jsonb)) alias
          WHERE position(lower(alias) IN lower(p_intent)) > 0
        ), 0)
      )::INTEGER AS match_score
    FROM app_runtime_profiles profile
    WHERE profile.active = TRUE
  )
  SELECT candidates.app_id, candidates.package_name, candidates.app_name, candidates.match_score
  FROM candidates
  WHERE candidates.match_score > 0
  ORDER BY candidates.match_score DESC, candidates.app_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION resolve_workflow_capabilities(
  p_intent TEXT,
  p_platform TEXT
)
RETURNS TABLE (
  capability_key TEXT,
  platform TEXT,
  description TEXT,
  aliases TEXT[],
  required_terms TEXT[],
  forbidden_terms TEXT[],
  safety_class TEXT,
  portability_scope TEXT,
  min_match_score DOUBLE PRECISION,
  ambiguity_margin DOUBLE PRECISION,
  metadata JSONB,
  updated_at TIMESTAMPTZ,
  score DOUBLE PRECISION,
  selected BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH input AS (
    SELECT compiler_tokens(p_intent) AS tokens
  ),
  descriptors AS (
    SELECT
      capability.*,
      descriptor.value AS descriptor,
      compiler_tokens(descriptor.value) AS descriptor_tokens,
      input.tokens AS query_tokens
    FROM workflow_capabilities capability
    CROSS JOIN input
    CROSS JOIN LATERAL unnest(
      ARRAY[capability.capability_key, COALESCE(capability.description, '')] || capability.aliases
    ) descriptor(value)
    WHERE capability.status = 'active'
      AND capability.portability_scope = 'global'
      AND (lower(capability.platform) = lower(p_platform) OR lower(capability.platform) = 'android')
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(capability.required_terms) term
        WHERE NOT compiler_tokens(term) <@ input.tokens
      )
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(capability.forbidden_terms) term
        WHERE compiler_tokens(term) <@ input.tokens
      )
  ),
  scored_descriptors AS (
    SELECT
      descriptors.*,
      (
        SELECT count(*)::DOUBLE PRECISION
        FROM unnest(descriptors.query_tokens) token
        WHERE token = ANY(descriptors.descriptor_tokens)
      ) AS shared
    FROM descriptors
  ),
  ranked AS (
    SELECT
      scored_descriptors.capability_key,
      scored_descriptors.platform,
      scored_descriptors.description,
      scored_descriptors.aliases,
      scored_descriptors.required_terms,
      scored_descriptors.forbidden_terms,
      scored_descriptors.safety_class,
      scored_descriptors.portability_scope,
      scored_descriptors.min_match_score,
      scored_descriptors.ambiguity_margin,
      scored_descriptors.metadata,
      scored_descriptors.updated_at,
      max(
        CASE
          WHEN shared < 2 THEN 0
          ELSE
            2
            * (shared / GREATEST(cardinality(query_tokens), 1))
            * (shared / GREATEST(cardinality(descriptor_tokens), 1))
            / NULLIF(
                (shared / GREATEST(cardinality(query_tokens), 1))
                + (shared / GREATEST(cardinality(descriptor_tokens), 1)),
                0
              )
        END
      ) AS score
    FROM scored_descriptors
    GROUP BY
      scored_descriptors.capability_key,
      scored_descriptors.platform,
      scored_descriptors.description,
      scored_descriptors.aliases,
      scored_descriptors.required_terms,
      scored_descriptors.forbidden_terms,
      scored_descriptors.safety_class,
      scored_descriptors.portability_scope,
      scored_descriptors.min_match_score,
      scored_descriptors.ambiguity_margin,
      scored_descriptors.metadata,
      scored_descriptors.updated_at
  ),
  accepted AS (
    SELECT *
    FROM ranked
    WHERE ranked.score >= ranked.min_match_score
  ),
  ordered AS (
    SELECT
      accepted.*,
      row_number() OVER (ORDER BY accepted.score DESC, accepted.updated_at DESC) AS position,
      lead(accepted.score) OVER (ORDER BY accepted.score DESC, accepted.updated_at DESC) AS runner_up_score
    FROM accepted
  )
  SELECT
    ordered.capability_key,
    ordered.platform,
    ordered.description,
    ordered.aliases,
    ordered.required_terms,
    ordered.forbidden_terms,
    ordered.safety_class,
    ordered.portability_scope,
    ordered.min_match_score,
    ordered.ambiguity_margin,
    ordered.metadata,
    ordered.updated_at,
    ordered.score,
    (
      ordered.position = 1
      AND (
        ordered.runner_up_score IS NULL
        OR ordered.score - ordered.runner_up_score >= ordered.ambiguity_margin
      )
    ) AS selected
  FROM ordered
  ORDER BY ordered.position
$$;
