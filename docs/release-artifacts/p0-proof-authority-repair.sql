BEGIN;

CREATE TEMP TABLE pg_temp.p0_proof_authority_repair_input ON COMMIT DROP AS
SELECT
  :'composition_name'::text AS composition_name,
  :'legacy_version'::text AS legacy_version,
  :'replacement_version'::text AS replacement_version,
  :'replacement_composition_key'::text AS replacement_composition_key,
  :'capability_key'::text AS capability_key,
  :'non_dispatchable_status'::text AS non_dispatchable_status,
  :'initial_status'::text AS initial_status,
  :'platform'::text AS platform,
  :'expected_account_id'::text AS expected_account_id,
  :'input_schema'::jsonb AS input_schema,
  :'output_schema'::jsonb AS output_schema,
  :'input_resolver'::jsonb AS input_resolver,
  :'replacement_postcondition_contract'::jsonb AS replacement_postcondition_contract,
  :'execution_policy'::jsonb AS execution_policy,
  :'compatibility'::jsonb AS compatibility,
  :'metadata'::jsonb AS metadata;

DO $$
DECLARE
  v_input RECORD;
  v_target_count INTEGER;
  v_admitted_count INTEGER;
  v_affected_count INTEGER;
  v_final_count INTEGER;
  v_canonical_policy_count INTEGER;
  v_active_replacement_count INTEGER;
  v_active_legacy_count INTEGER;
  v_scope_dispatchable_count INTEGER;
  v_target_ctid TID;
  v_target_ctids TID[];
BEGIN
  SELECT * INTO STRICT v_input FROM pg_temp.p0_proof_authority_repair_input;

  LOCK TABLE workflow_compositions IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE lifecycle_state_definitions IN SHARE MODE;
  LOCK TABLE resource_runtime_policies IN SHARE MODE;

  IF legacy_workflow_predicate_metadata_present() THEN
    RAISE EXCEPTION 'legacy workflow predicate metadata is still present';
  END IF;

  SELECT COUNT(*)
    INTO v_canonical_policy_count
    FROM canonical_workflow_predicate_metadata();
  IF v_canonical_policy_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one canonical workflow predicate policy, found %', v_canonical_policy_count;
  END IF;

  SELECT COUNT(*)
    INTO v_scope_dispatchable_count
    FROM workflow_compositions c
    JOIN lifecycle_state_definitions active_state
      ON active_state.lifecycle_key = 'workflow_compositions'
     AND active_state.status = c.lifecycle_status
     AND active_state.dispatchable
   WHERE c.composition_name = v_input.composition_name
     AND c.platform = v_input.platform;
  IF v_scope_dispatchable_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one dispatchable artifact in target scope before repair, found %', v_scope_dispatchable_count;
  END IF;

  WITH locked_target AS (
    SELECT c.ctid
      FROM workflow_compositions c
      JOIN lifecycle_state_definitions active_state
        ON active_state.lifecycle_key = 'workflow_compositions'
       AND active_state.status = c.lifecycle_status
       AND active_state.dispatchable
      JOIN lifecycle_state_definitions retired_state
        ON retired_state.lifecycle_key = 'workflow_compositions'
       AND retired_state.status = v_input.non_dispatchable_status
       AND NOT retired_state.dispatchable
      JOIN lifecycle_state_definitions replacement_state
        ON replacement_state.lifecycle_key = 'workflow_compositions'
       AND replacement_state.status = v_input.initial_status
       AND replacement_state.dispatchable
     WHERE c.composition_name = v_input.composition_name
       AND c.version = v_input.legacy_version
       AND c.platform = v_input.platform
       AND COALESCE(c.metadata ->> 'accountId', '') = COALESCE(v_input.expected_account_id, '')
       AND c.postcondition_contract @> '{"version":"1"}'::jsonb
       AND c.postcondition_contract -> 'all' = jsonb_build_array(
         jsonb_build_object(
           'left', jsonb_build_object('path', 'outputs.screenState'),
           'operator', 'exists'
         )
       )
     FOR UPDATE OF c
  )
  SELECT COUNT(*), array_agg(ctid)
    INTO v_target_count, v_target_ctids
    FROM locked_target;
  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one defective promoted target, found %', v_target_count;
  END IF;
  v_target_ctid := v_target_ctids[1];

  SELECT COUNT(*)
    INTO v_admitted_count
    FROM resolve_postcondition_proof_eligibility(
      'workflow_compositions'::regclass,
      v_input.replacement_postcondition_contract -> 'all'
    )
   WHERE admitted;
  IF v_admitted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one admitted replacement proof, found %', v_admitted_count;
  END IF;

  UPDATE workflow_compositions c
     SET lifecycle_status = v_input.non_dispatchable_status,
         updated_at = NOW()
   WHERE c.ctid = v_target_ctid;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;
  IF v_affected_count <> 1 THEN
    RAISE EXCEPTION 'expected to deactivate exactly one target, affected %', v_affected_count;
  END IF;

  INSERT INTO workflow_compositions (
    composition_name, version, composition_key, capability_key, platform,
    input_schema, output_schema, input_resolver, postcondition_contract,
    execution_policy, compatibility, lifecycle_status, metadata
  )
  VALUES (
    v_input.composition_name, v_input.replacement_version, v_input.replacement_composition_key,
    v_input.capability_key, v_input.platform, v_input.input_schema, v_input.output_schema,
    v_input.input_resolver, v_input.replacement_postcondition_contract, v_input.execution_policy,
    v_input.compatibility, v_input.initial_status, v_input.metadata
  );

  SELECT COUNT(*)
    INTO v_final_count
    FROM workflow_compositions c
    JOIN lifecycle_state_definitions state
      ON state.lifecycle_key = 'workflow_compositions'
     AND state.status = c.lifecycle_status
     AND state.dispatchable
   WHERE c.composition_name = v_input.composition_name
     AND c.version = v_input.replacement_version
     AND c.composition_key = v_input.replacement_composition_key
     AND c.capability_key = v_input.capability_key
     AND c.platform = v_input.platform
     AND c.lifecycle_status = v_input.initial_status
     AND COALESCE(c.metadata ->> 'accountId', '') = COALESCE(v_input.expected_account_id, '')
     AND c.input_schema = v_input.input_schema
     AND c.output_schema = v_input.output_schema
     AND c.input_resolver = v_input.input_resolver
     AND c.postcondition_contract = v_input.replacement_postcondition_contract
     AND c.execution_policy = v_input.execution_policy
     AND c.compatibility = v_input.compatibility;
  IF v_final_count <> 1 THEN
    RAISE EXCEPTION 'replacement final promoted state assertion failed, found %', v_final_count;
  END IF;

  SELECT COUNT(*)
    INTO v_active_replacement_count
    FROM workflow_compositions c
    JOIN lifecycle_state_definitions state
      ON state.lifecycle_key = 'workflow_compositions'
     AND state.status = c.lifecycle_status
     AND state.dispatchable
   WHERE c.composition_name = v_input.composition_name
     AND c.version = v_input.replacement_version
     AND c.platform = v_input.platform;
  IF v_active_replacement_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one active promoted replacement identity, found %', v_active_replacement_count;
  END IF;

  SELECT COUNT(*)
    INTO v_scope_dispatchable_count
    FROM workflow_compositions c
    JOIN lifecycle_state_definitions state
      ON state.lifecycle_key = 'workflow_compositions'
     AND state.status = c.lifecycle_status
     AND state.dispatchable
   WHERE c.composition_name = v_input.composition_name
     AND c.platform = v_input.platform;
  IF v_scope_dispatchable_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one dispatchable artifact in target scope after repair, found %', v_scope_dispatchable_count;
  END IF;

  SELECT COUNT(*)
    INTO v_active_legacy_count
    FROM workflow_compositions c
    JOIN lifecycle_state_definitions state
      ON state.lifecycle_key = 'workflow_compositions'
     AND state.status = c.lifecycle_status
     AND state.dispatchable
   WHERE c.composition_name = v_input.composition_name
     AND c.platform = v_input.platform
     AND c.postcondition_contract @> '{"version":"1"}'::jsonb
     AND c.postcondition_contract -> 'all' = jsonb_build_array(
       jsonb_build_object(
         'left', jsonb_build_object('path', 'outputs.screenState'),
         'operator', 'exists'
       )
     );
  IF v_active_legacy_count <> 0 THEN
    RAISE EXCEPTION 'expected no dispatchable existence-only legacy artifact, found %', v_active_legacy_count;
  END IF;
END $$;

COMMIT;
