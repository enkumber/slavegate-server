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

CREATE OR REPLACE FUNCTION legacy_workflow_predicate_metadata_present()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  present BOOLEAN := false;
BEGIN
  IF to_regclass('runtime_semantic_entries') IS NULL
     OR to_regclass('lifecycle_state_definitions') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
        FROM runtime_semantic_entries entry
        JOIN lifecycle_state_definitions definition
          ON definition.lifecycle_key = entry.lifecycle_key
         AND definition.status = entry.status
       WHERE definition.dispatchable
         AND entry.payload ? 'workflowInterpreterPolicy'
         AND entry.payload -> 'workflowInterpreterPolicy' ? 'predicateMetadata'
    )
  $query$ INTO present;
  RETURN COALESCE(present, false);
END;
$$;

CREATE OR REPLACE FUNCTION canonical_workflow_predicate_metadata()
RETURNS TABLE(metadata_source REGCLASS, metadata_version BIGINT, predicate_metadata JSONB)
LANGUAGE sql
STABLE
AS $$
  WITH raw_policy AS (
    SELECT resource_table, version, policy
      FROM resource_runtime_policies
     WHERE resource_table IN (
       'workflow_compositions'::regclass,
       'workflow_segment_versions'::regclass
     )
  ),
  valid_policy AS (
    SELECT resource_table, version, policy -> 'predicateMetadata' AS predicate_metadata
      FROM raw_policy
     WHERE resource_table IN (
       'workflow_compositions'::regclass,
       'workflow_segment_versions'::regclass
     )
       AND COALESCE((policy ->> 'enabled')::boolean, true)
       AND jsonb_typeof(policy -> 'predicateMetadata') = 'object'
       AND EXISTS (
         SELECT 1
           FROM jsonb_object_keys(policy -> 'predicateMetadata')
       )
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_each(policy -> 'predicateMetadata') AS metadata_entry(key, value)
          WHERE jsonb_typeof(metadata_entry.value) <> 'object'
             OR jsonb_typeof(metadata_entry.value -> 'eligible') <> 'boolean'
             OR jsonb_typeof(metadata_entry.value -> 'classifying') <> 'boolean'
             OR jsonb_typeof(metadata_entry.value -> 'operand') <> 'object'
             OR jsonb_typeof(metadata_entry.value -> 'operand' -> 'required') <> 'boolean'
             OR jsonb_typeof(metadata_entry.value -> 'operand' -> 'type') <> 'string'
             OR jsonb_typeof(metadata_entry.value -> 'operand' -> 'minLength') <> 'number'
             OR (
               metadata_entry.value -> 'operand' ? 'allowSamePath'
               AND jsonb_typeof(metadata_entry.value -> 'operand' -> 'allowSamePath') <> 'boolean'
             )
       )
  ),
  canonical AS (
    SELECT *
      FROM valid_policy
     WHERE resource_table = 'workflow_compositions'::regclass
  ),
  segment_policy AS (
    SELECT *
      FROM valid_policy
     WHERE resource_table = 'workflow_segment_versions'::regclass
  )
  SELECT canonical.resource_table, canonical.version, canonical.predicate_metadata
    FROM canonical
    JOIN segment_policy
      ON segment_policy.version = canonical.version
     AND segment_policy.predicate_metadata = canonical.predicate_metadata
   WHERE NOT legacy_workflow_predicate_metadata_present()
     AND (
       SELECT COUNT(*)
         FROM raw_policy
        WHERE resource_table = 'workflow_compositions'::regclass
     ) = 1
     AND (
       SELECT COUNT(*)
         FROM raw_policy
        WHERE resource_table = 'workflow_segment_versions'::regclass
     ) = 1
     AND (
       SELECT COUNT(*)
         FROM valid_policy
        WHERE resource_table = 'workflow_compositions'::regclass
     ) = 1
     AND (
       SELECT COUNT(*)
         FROM valid_policy
        WHERE resource_table = 'workflow_segment_versions'::regclass
     ) = 1;
$$;

CREATE OR REPLACE FUNCTION resolve_postcondition_proof_eligibility(
  target_resource REGCLASS,
  predicates JSONB
)
RETURNS TABLE(
  predicate_index INTEGER,
  operator TEXT,
  admitted BOOLEAN,
  operand_contract JSONB,
  metadata_source REGCLASS,
  metadata_version BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH policy_row AS (
    SELECT target_resource AS resource_table,
           predicate_metadata,
           metadata_source,
           metadata_version
      FROM canonical_workflow_predicate_metadata()
     WHERE target_resource IN (
       'workflow_compositions'::regclass,
       'workflow_segment_versions'::regclass
     )
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
           policy_row.metadata_source,
           policy_row.metadata_version,
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
      LEFT JOIN LATERAL jsonb_each(policy_row.predicate_metadata) metadata_entry(key, metadata)
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
             OR (
               right_literal <> 'null'::jsonb
               AND NOT (
                 jsonb_typeof(right_literal) = 'string'
                 AND length(right_literal #>> '{}') = 0
               )
               AND NOT (
                 jsonb_typeof(right_literal) = 'array'
                 AND jsonb_array_length(right_literal) = 0
               )
               AND NOT (
                 jsonb_typeof(right_literal) = 'object'
                 AND (SELECT count(*) FROM jsonb_object_keys(right_literal)) = 0
               )
             )
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
             COALESCE((operand ->> 'allowSamePath')::boolean, false)
             OR COALESCE(right_path, '') = ''
             OR right_path <> left_path
           ) AS admitted,
         operand AS operand_contract,
         metadata_source,
         metadata_version
    FROM shaped;
$$;
