BEGIN;

CREATE TEMP TABLE pg_temp.p0_proof_authority_repair_input ON COMMIT DROP AS
SELECT
  :'composition_name'::text AS composition_name,
  :'legacy_version'::text AS legacy_version,
  :'legacy_composition_key'::text AS legacy_composition_key,
  :'replacement_version'::text AS replacement_version,
  :'replacement_composition_key'::text AS replacement_composition_key,
  :'capability_key'::text AS capability_key,
  :'non_dispatchable_status'::text AS non_dispatchable_status,
  :'initial_status'::text AS initial_status,
  :'promoted_status'::text AS promoted_status,
  :'platform'::text AS platform,
  :'input_schema'::jsonb AS input_schema,
  :'output_schema'::jsonb AS output_schema,
  :'input_resolver'::jsonb AS input_resolver,
  :'replacement_postcondition_contract'::jsonb AS replacement_postcondition_contract,
  :'execution_policy'::jsonb AS execution_policy,
  :'compatibility'::jsonb AS compatibility,
  :'legacy_failure_evidence_filter'::jsonb AS legacy_failure_evidence_filter,
  :'replacement_metadata'::jsonb AS replacement_metadata;

LOCK TABLE workflow_compositions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE resource_runtime_policies IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_input RECORD;
  v_target_keys TEXT[];
  v_target_count INTEGER;
  v_admitted_count INTEGER;
  v_deactivated_count INTEGER;
  v_inserted_count INTEGER;
  v_active_promoted_count INTEGER;
  v_active_classifying_dispatchable_count INTEGER;
  v_exact_replacement_count INTEGER;
  v_legacy_survivor_count INTEGER;
  v_canonical_count INTEGER;
BEGIN
  SELECT * INTO STRICT v_input FROM pg_temp.p0_proof_authority_repair_input;

  IF legacy_workflow_predicate_metadata_present() THEN
    RAISE EXCEPTION 'legacy workflow predicate metadata is present';
  END IF;

  SELECT COUNT(*) INTO v_canonical_count
  FROM canonical_workflow_predicate_metadata();

  IF v_canonical_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one canonical predicate metadata row, found %', v_canonical_count;
  END IF;

  SELECT COUNT(*) INTO v_admitted_count
  FROM resolve_postcondition_proof_eligibility(
    'workflow_compositions'::regclass,
    v_input.replacement_postcondition_contract -> 'all'
  )
  WHERE admitted;

  IF v_admitted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one admitted replacement proof predicate, found %', v_admitted_count;
  END IF;

  SELECT array_agg(composition_key), COUNT(*) INTO v_target_keys, v_target_count
  FROM (
    SELECT composition_key
    FROM workflow_compositions
    WHERE composition_name = v_input.composition_name
      AND version = v_input.legacy_version
      AND composition_key = v_input.legacy_composition_key
      AND platform = v_input.platform
      AND lifecycle_status = v_input.promoted_status
      AND lifecycle_state_matches(
            'workflow_compositions'::regclass,
            lifecycle_status,
            '{"dispatchable":true}'::jsonb,
            'lifecycle_status'
          )
      AND metadata @> v_input.legacy_failure_evidence_filter
      AND postcondition_contract @> '{"version":"1"}'::jsonb
      AND postcondition_contract -> 'all' = jsonb_build_array(
        jsonb_build_object(
          'left', jsonb_build_object('path', 'outputs.screenState'),
          'operator', 'exists'
        )
      )
    FOR UPDATE
  ) target;

  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one repair target, found %', v_target_count;
  END IF;

  UPDATE workflow_compositions
  SET lifecycle_status = v_input.non_dispatchable_status,
      updated_at = NOW()
  WHERE composition_name = v_input.composition_name
    AND version = v_input.legacy_version
    AND platform = v_input.platform
    AND lifecycle_status = v_input.promoted_status
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND composition_key = ANY(v_target_keys);

  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;
  IF v_deactivated_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one deactivated target, found %', v_deactivated_count;
  END IF;

  INSERT INTO workflow_compositions (
    composition_name, version, composition_key, capability_key, platform,
    input_schema, output_schema, input_resolver, postcondition_contract,
    execution_policy, compatibility, metadata, lifecycle_status
  )
  VALUES (
    v_input.composition_name, v_input.replacement_version, v_input.replacement_composition_key,
    v_input.capability_key, v_input.platform, v_input.input_schema, v_input.output_schema,
    v_input.input_resolver, v_input.replacement_postcondition_contract,
    v_input.execution_policy, v_input.compatibility,
    jsonb_build_object(
      'replacesCompositionKey', v_input.legacy_composition_key,
      'replacesVersion', v_input.legacy_version,
      'proofAuthorityVersion', (
        SELECT metadata_version FROM canonical_workflow_predicate_metadata()
      ),
      'repairReason', 'reddit_not_target_application_exists_only'
    ) || COALESCE(v_input.replacement_metadata, '{}'::jsonb),
    v_input.initial_status
  );

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
  IF v_inserted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one inserted replacement, found %', v_inserted_count;
  END IF;

  SELECT COUNT(*) INTO v_active_promoted_count
  FROM workflow_compositions
  WHERE composition_name = v_input.composition_name
    AND platform = v_input.platform
    AND lifecycle_status = v_input.initial_status
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND composition_key = v_input.replacement_composition_key
    AND version = v_input.replacement_version
    AND postcondition_contract = v_input.replacement_postcondition_contract;

  IF v_active_promoted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one active promoted replacement, found %', v_active_promoted_count;
  END IF;

  SELECT COUNT(*) INTO v_active_classifying_dispatchable_count
  FROM workflow_compositions c
  WHERE c.composition_name = v_input.composition_name
    AND c.platform = v_input.platform
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          c.lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND EXISTS (
      SELECT 1
      FROM resolve_postcondition_proof_eligibility(
        'workflow_compositions'::regclass,
        c.postcondition_contract -> 'all'
      ) proof
      WHERE proof.admitted
    );

  IF v_active_classifying_dispatchable_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one classifying dispatchable artifact in scope, found %', v_active_classifying_dispatchable_count;
  END IF;

  SELECT COUNT(*) INTO v_exact_replacement_count
  FROM workflow_compositions
  WHERE composition_name = v_input.composition_name
    AND platform = v_input.platform
    AND lifecycle_status = v_input.initial_status
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND composition_key = v_input.replacement_composition_key
    AND version = v_input.replacement_version
    AND capability_key = v_input.capability_key
    AND input_schema = v_input.input_schema
    AND output_schema = v_input.output_schema
    AND input_resolver = v_input.input_resolver
    AND postcondition_contract = v_input.replacement_postcondition_contract
    AND execution_policy = v_input.execution_policy
    AND compatibility = v_input.compatibility;

  IF v_exact_replacement_count <> 1 THEN
    RAISE EXCEPTION 'sole dispatchable classifying artifact is not the expected replacement, found %', v_exact_replacement_count;
  END IF;

  SELECT COUNT(*) INTO v_legacy_survivor_count
  FROM workflow_compositions
  WHERE composition_key = v_input.legacy_composition_key
    AND lifecycle_status = v_input.promoted_status;

  IF v_legacy_survivor_count <> 0 THEN
    RAISE EXCEPTION 'legacy composition key % remains promoted', v_input.legacy_composition_key;
  END IF;
END $$;

COMMIT;
