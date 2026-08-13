# PostgreSQL Proof Authority Amendment

This release keeps `411a52b2dc3ed123cb832fcbdf040f84df8338fc` immutable and
pre-stages only database-authoritative proof policy mechanics. Do not deploy,
restart, or mutate live data before the candidate SHA is approved.

## PostgreSQL Prestage

1. Apply the application migration containing `119_runtime_policy_resolution.sql`.
   It creates or replaces:
   - `resolve_resource_runtime_identity(target_resource, supplied_identity)`
   - `legacy_workflow_predicate_metadata_present()`
   - `canonical_workflow_predicate_metadata()`
   - `resolve_postcondition_proof_eligibility(target_resource, predicates)`

2. Configure runtime policy rows through the control plane or an audited DBA
   transaction. The predicate metadata authority is canonicalized from
   `workflow_compositions`; an optional `workflow_segment_versions` row must
   have exactly the same `version` and `predicateMetadata` or all proof
   admission fails closed at execution time.

```sql
SELECT resource_table::text, version, policy -> 'predicateMetadata' AS predicate_metadata
FROM resource_runtime_policies
WHERE resource_table IN (
  'workflow_compositions'::regclass,
  'workflow_segment_versions'::regclass
);
```

`runtime_semantic_entries.payload.workflowInterpreterPolicy` must not contain
`predicateMetadata`. If it does, dispatcher hydration and proof admission both
fail closed.

## Verification

Run these read-only checks after prestage and before enabling traffic:

```sql
SELECT legacy_workflow_predicate_metadata_present() AS legacy_predicate_metadata_present;

SELECT resource_table::text, version,
       jsonb_typeof(policy -> 'predicateMetadata') AS predicate_metadata_type,
       COALESCE((policy ->> 'enabled')::boolean, true) AS enabled
FROM resource_runtime_policies
WHERE resource_table IN (
  'workflow_compositions'::regclass,
  'workflow_segment_versions'::regclass,
  'agency_workflow_runs'::regclass
);
```

Expected:
- `legacy_predicate_metadata_present = false`
- composition has `predicate_metadata_type = object`; segment is either absent
  or exactly equal in `version` and `predicateMetadata`
- `agency_workflow_runs` has DB-owned identity policy for explicit replay and
  implicit fresh identities

## Rollback

Rollback is metadata-only unless a later release has already depended on this
candidate:

```sql
BEGIN;
DROP FUNCTION IF EXISTS resolve_postcondition_proof_eligibility(REGCLASS, JSONB);
DROP FUNCTION IF EXISTS canonical_workflow_predicate_metadata();
DROP FUNCTION IF EXISTS legacy_workflow_predicate_metadata_present();
DROP FUNCTION IF EXISTS resolve_resource_runtime_identity(REGCLASS, TEXT);
COMMIT;
```

If policy rows were updated during prestage, restore them inside a transaction
from the audited JSONB copy captured before mutation, then re-run the
verification query before `COMMIT`:

```sql
BEGIN;
LOCK TABLE resource_runtime_policies IN SHARE ROW EXCLUSIVE MODE;
-- INSERT ... ON CONFLICT ... exact audited policy JSONB rows captured before prestage.
SELECT legacy_workflow_predicate_metadata_present() AS legacy_predicate_metadata_present;
SELECT COUNT(*) AS admitted_canonical_rows
FROM canonical_workflow_predicate_metadata();
COMMIT;
```

## Data Repair Proposal

No live mutation is authorized by this candidate report. The exact proposed
repair is a transactional deactivation/replacement of the promoted Reddit
existence-only artifact class: any active `workflow_compositions` row whose
postcondition only proves `outputs.screenState` exists, and whose observed
failure evidence includes `screenState = 'not_target_application'`, is moved
out of the dispatchable lifecycle and replaced by a new version that must pass
`resolve_postcondition_proof_eligibility`.

Read-only identification query:

```sql
SELECT composition_name, version, composition_key, lifecycle_status, postcondition_contract
FROM workflow_compositions
WHERE platform = 'reddit'
  AND postcondition_contract @> '{"version":"1"}'::jsonb
  AND postcondition_contract -> 'all' = jsonb_build_array(
    jsonb_build_object(
      'left', jsonb_build_object('path', 'outputs.screenState'),
      'operator', 'exists'
    )
  );
```

Proposed mutation, to run only after FORGE approval with concrete replacement
payloads bound to the named parameters. The transaction locks the target and
policy authorities, proves the replacement is admitted before mutation, and
raises before `COMMIT` on every invalid state:

```sql
BEGIN;
LOCK TABLE workflow_compositions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE resource_runtime_policies IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  target_keys TEXT[];
  target_count INTEGER;
  admitted_count INTEGER;
  deactivated_count INTEGER;
  inserted_count INTEGER;
  active_promoted_count INTEGER;
  canonical_count INTEGER;
BEGIN
  IF legacy_workflow_predicate_metadata_present() THEN
    RAISE EXCEPTION 'legacy workflow predicate metadata is present';
  END IF;

  SELECT COUNT(*) INTO canonical_count
  FROM canonical_workflow_predicate_metadata();

  IF canonical_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one canonical predicate metadata row, found %', canonical_count;
  END IF;

  SELECT COUNT(*) INTO admitted_count
  FROM resolve_postcondition_proof_eligibility(
    'workflow_compositions'::regclass,
    :replacement_postcondition_contract::jsonb -> 'all'
  )
  WHERE admitted;

  IF admitted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one admitted replacement proof predicate, found %', admitted_count;
  END IF;

  SELECT array_agg(composition_key), COUNT(*) INTO target_keys, target_count
  FROM (
    SELECT composition_key
    FROM workflow_compositions
    WHERE composition_name = :composition_name
      AND version = :legacy_version
      AND composition_key = :legacy_composition_key
      AND platform = 'reddit'
      AND lifecycle_status = :promoted_status
      AND lifecycle_state_matches(
            'workflow_compositions'::regclass,
            lifecycle_status,
            '{"dispatchable":true}'::jsonb,
            'lifecycle_status'
          )
      AND metadata @> :legacy_failure_evidence_filter::jsonb
      AND postcondition_contract @> '{"version":"1"}'::jsonb
      AND postcondition_contract -> 'all' = jsonb_build_array(
        jsonb_build_object(
          'left', jsonb_build_object('path', 'outputs.screenState'),
          'operator', 'exists'
        )
      )
    FOR UPDATE
  ) target;

  IF target_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one repair target, found %', target_count;
  END IF;

  UPDATE workflow_compositions
  SET lifecycle_status = :non_dispatchable_status,
      updated_at = NOW()
  WHERE composition_name = :composition_name
    AND version = :legacy_version
    AND platform = 'reddit'
    AND lifecycle_status = :promoted_status
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND composition_key = ANY(target_keys);

  GET DIAGNOSTICS deactivated_count = ROW_COUNT;
  IF deactivated_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one deactivated target, found %', deactivated_count;
  END IF;

  INSERT INTO workflow_compositions (
    composition_name, version, composition_key, capability_key, platform,
    input_schema, output_schema, input_resolver, postcondition_contract,
    execution_policy, compatibility, metadata, lifecycle_status
  )
  VALUES (
    :composition_name, :replacement_version, :replacement_composition_key,
    :capability_key, 'reddit', :input_schema::jsonb, :output_schema::jsonb,
    :input_resolver::jsonb, :replacement_postcondition_contract::jsonb,
    :execution_policy::jsonb, :compatibility::jsonb,
    jsonb_build_object(
      'replacesCompositionKey', :legacy_composition_key,
      'replacesVersion', :legacy_version,
      'proofAuthorityVersion', (
        SELECT metadata_version FROM canonical_workflow_predicate_metadata()
      ),
      'repairReason', 'reddit_not_target_application_exists_only'
    ) || COALESCE(:replacement_metadata::jsonb, '{}'::jsonb),
    :initial_status
  );

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one inserted replacement, found %', inserted_count;
  END IF;

  SELECT COUNT(*) INTO active_promoted_count
  FROM workflow_compositions
  WHERE composition_name = :composition_name
    AND platform = 'reddit'
    AND lifecycle_status = :initial_status
    AND lifecycle_state_matches(
          'workflow_compositions'::regclass,
          lifecycle_status,
          '{"dispatchable":true}'::jsonb,
          'lifecycle_status'
        )
    AND composition_key = :replacement_composition_key
    AND version = :replacement_version
    AND postcondition_contract = :replacement_postcondition_contract::jsonb;

  IF active_promoted_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one active promoted replacement, found %', active_promoted_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_compositions
    WHERE composition_key = :legacy_composition_key
      AND lifecycle_status = :promoted_status
  ) THEN
    RAISE EXCEPTION 'legacy composition key % remains promoted', :legacy_composition_key;
  END IF;
END $$;

COMMIT;
```

Every assertion raises before `COMMIT`; PostgreSQL rolls the transaction back on
any missing/duplicate target, policy drift, failed deactivation, legacy metadata,
replacement proof ineligibility, failed insert, or unexpected final active
state. There is no manual inspect-after-commit abort window.

Rollback/recovery for a failed repair attempt is automatic because no exception
is caught inside the transaction. If an operator disconnects after `BEGIN` and
before `COMMIT`, PostgreSQL aborts the session transaction. If a later approved
repair must be reversed, use the exact audited keys:

```sql
BEGIN;
LOCK TABLE workflow_compositions IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  restored_count INTEGER;
  replacement_count INTEGER;
BEGIN
  UPDATE workflow_compositions
     SET lifecycle_status = :promoted_status,
         updated_at = NOW()
   WHERE composition_key = :legacy_composition_key
     AND lifecycle_status = :non_dispatchable_status;
  GET DIAGNOSTICS restored_count = ROW_COUNT;

  UPDATE workflow_compositions
     SET lifecycle_status = :non_dispatchable_status,
         updated_at = NOW()
   WHERE composition_key = :replacement_composition_key
     AND lifecycle_status = :initial_status;
  GET DIAGNOSTICS replacement_count = ROW_COUNT;

  IF restored_count <> 1 OR replacement_count <> 1 THEN
    RAISE EXCEPTION 'rollback expected one restored legacy and one deactivated replacement, found restored %, replacement %',
      restored_count, replacement_count;
  END IF;
END $$;
COMMIT;
```
