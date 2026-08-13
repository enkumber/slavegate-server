-- Generic PostgreSQL-owned identity resolution. Policy rows remain control-plane
-- data; this migration deliberately seeds no product semantics.
CREATE OR REPLACE FUNCTION resolve_resource_runtime_identity(
  target_resource REGCLASS,
  supplied_identity TEXT
)
RETURNS TABLE(identity TEXT, admitted BOOLEAN)
LANGUAGE sql
VOLATILE
AS $$
  SELECT CASE
           WHEN supplied_identity IS NOT NULL AND supplied_identity <> ''
             AND COALESCE((policy -> 'identityPolicy' ->> 'explicitAdmitted')::boolean, false)
             THEN supplied_identity
           WHEN (supplied_identity IS NULL OR supplied_identity = '')
             AND COALESCE((policy -> 'identityPolicy' ->> 'implicitGenerated')::boolean, false)
             THEN gen_random_uuid()::text
           ELSE NULL
         END,
         CASE
           WHEN supplied_identity IS NOT NULL AND supplied_identity <> ''
             THEN COALESCE((policy -> 'identityPolicy' ->> 'explicitAdmitted')::boolean, false)
           ELSE COALESCE((policy -> 'identityPolicy' ->> 'implicitGenerated')::boolean, false)
         END
    FROM resource_runtime_policies
   WHERE resource_table = target_resource
     AND COALESCE((policy ->> 'enabled')::boolean, true)
  UNION ALL
  SELECT NULL, false
   WHERE NOT EXISTS (
     SELECT 1 FROM resource_runtime_policies
      WHERE resource_table = target_resource
        AND COALESCE((policy ->> 'enabled')::boolean, true)
   )
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_postcondition_proof_eligibility(
  target_resource REGCLASS,
  predicates JSONB
)
RETURNS TABLE(predicate_index INTEGER, operator TEXT, admitted BOOLEAN, operand_contract JSONB)
LANGUAGE sql
STABLE
AS $$
  WITH policy_row AS (
    SELECT policy
      FROM resource_runtime_policies
     WHERE resource_table = target_resource
       AND COALESCE((policy ->> 'enabled')::boolean, true)
     LIMIT 1
  ),
  candidate AS (
    SELECT (ordinality - 1)::integer AS predicate_index,
           predicate,
           predicate ->> 'operator' AS operator,
           predicate #>> '{left,path}' AS left_path,
           predicate -> 'right' AS right_operand,
           predicate #>> '{right,path}' AS right_path
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(predicates) = 'array' THEN predicates ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS item(predicate, ordinality)
  ),
  shaped AS (
    SELECT candidate.*,
           metadata,
           metadata -> 'operand' AS operand,
           jsonb_typeof(candidate.right_operand) = 'object'
             AND (
               candidate.right_operand ? 'value'
               OR COALESCE(candidate.right_path, '') <> ''
             ) AS right_present,
           CASE WHEN jsonb_typeof(candidate.right_operand) = 'object'
                  AND candidate.right_operand ? 'value'
                THEN candidate.right_operand -> 'value'
                ELSE NULL
           END AS right_literal
      FROM candidate
      CROSS JOIN policy_row
      LEFT JOIN LATERAL jsonb_each(policy_row.policy -> 'predicateMetadata') metadata_entry(key, metadata)
        ON metadata_entry.key = candidate.operator
  )
  SELECT predicate_index,
         operator,
         COALESCE((metadata ->> 'eligible')::boolean, false)
           AND COALESCE((metadata ->> 'classifying')::boolean, false)
           AND left_path ~ '^(outputs|variables)\.'
           AND jsonb_typeof(operand) = 'object'
           AND jsonb_typeof(operand -> 'required') = 'boolean'
           AND (operand ? 'type')
           AND jsonb_typeof(operand -> 'minLength') = 'number'
           AND (
             COALESCE((operand ->> 'required')::boolean, false) = false
             OR right_present
           )
           AND (
             right_present = false
             OR right_literal IS NULL
             OR operand ->> 'type' = 'any'
             OR jsonb_typeof(right_literal) = operand ->> 'type'
           )
           AND (
             right_present = false
             OR right_literal IS NULL
             OR CASE jsonb_typeof(right_literal)
                  WHEN 'string' THEN length(right_literal #>> '{}')
                  WHEN 'array' THEN jsonb_array_length(right_literal)
                  WHEN 'object' THEN (SELECT count(*) FROM jsonb_object_keys(right_literal))
                  ELSE 1
                END >= COALESCE((operand ->> 'minLength')::integer, 0)
           )
           AND (
             right_present = false
             OR right_literal IS NULL
             OR right_literal <> 'null'::jsonb
           )
           AND (
             COALESCE((operand ->> 'allowSamePath')::boolean, false)
             OR COALESCE(right_path, '') = ''
             OR right_path <> left_path
           ) AS admitted,
         operand AS operand_contract
    FROM shaped;
$$;
