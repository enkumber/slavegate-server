-- Generic capability retrieval mechanism.
--
-- Detailed human intents contain execution parameters and verification prose,
-- so query-length-sensitive F1 alone can reject an operator-configured alias
-- even when every alias token is present. Keep the existing F1 signal and add
-- descriptor coverage. PostgreSQL capability thresholds, required terms,
-- forbidden terms and ambiguity margins remain the sole selection policy.

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
    WHERE capability.compiler_retrievable IS TRUE
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
          ELSE GREATEST(
            shared / GREATEST(cardinality(descriptor_tokens), 1),
            2
            * (shared / GREATEST(cardinality(query_tokens), 1))
            * (shared / GREATEST(cardinality(descriptor_tokens), 1))
            / NULLIF(
                (shared / GREATEST(cardinality(query_tokens), 1))
                + (shared / GREATEST(cardinality(descriptor_tokens), 1)),
                0
              )
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
