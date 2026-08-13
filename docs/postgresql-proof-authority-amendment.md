# PostgreSQL Proof Authority Amendment

This release keeps `411a52b2dc3ed123cb832fcbdf040f84df8338fc` immutable and
pre-stages only database-authoritative proof policy mechanics. Do not deploy,
restart, or mutate live data before the candidate SHA is approved.

## PostgreSQL Prestage

1. Apply the application migration containing `119_runtime_policy_resolution.sql`.
   It creates or replaces:
   - `resolve_resource_runtime_identity(target_resource, supplied_identity)`
   - `legacy_workflow_predicate_metadata_present()`
   - `resolve_postcondition_proof_eligibility(target_resource, predicates)`

2. Configure runtime policy rows through the control plane or an audited DBA
   transaction. The predicate metadata authority is exactly:

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
- composition and segment policies have `predicate_metadata_type = object`
- `agency_workflow_runs` has DB-owned identity policy for explicit replay and
  implicit fresh identities

## Rollback

Rollback is metadata-only unless a later release has already depended on this
candidate:

```sql
BEGIN;
DROP FUNCTION IF EXISTS resolve_postcondition_proof_eligibility(REGCLASS, JSONB);
DROP FUNCTION IF EXISTS legacy_workflow_predicate_metadata_present();
DROP FUNCTION IF EXISTS resolve_resource_runtime_identity(REGCLASS, TEXT);
COMMIT;
```

If policy rows were updated during prestage, restore them from the transaction
snapshot or the audited JSONB copy captured before mutation.

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
payloads bound to the named parameters. The executable SQL is versioned in
`docs/release-artifacts/p0-proof-authority-repair.sql` and is covered by the
disposable PostgreSQL repair-atomicity test; do not hand-copy or edit an
unversioned variant.

```sql
-- Bind these psql variables before inclusion:
-- composition_name, legacy_version, replacement_version,
-- replacement_composition_key, capability_key, non_dispatchable_status,
-- initial_status, platform, expected_account_id, input_schema, output_schema,
-- input_resolver, replacement_postcondition_contract, execution_policy,
-- compatibility, metadata.
\i docs/release-artifacts/p0-proof-authority-repair.sql
```

The artifact is one transaction. It binds psql variables into a transaction-local
`pg_temp.p0_proof_authority_repair_input` row before the `DO` block, so the
block never relies on psql interpolation inside `$$` quoting. It locks
`workflow_compositions`, `lifecycle_state_definitions`, and
`resource_runtime_policies`; asserts no legacy predicate metadata; asserts
exactly one canonical paired composition/segment predicate policy; asserts the
target scope has exactly one dispatchable artifact; locks exactly one
promoted/dispatchable defective target; requires exactly one admitted
replacement proof; asserts deactivation row count; inserts only after all
preconditions pass; and asserts the final replacement identity, account binding,
bindings, version, lifecycle state, schemas, execution policy, compatibility,
and single active promoted replacement before `COMMIT`. It also asserts that no
dispatchable existence-only `outputs.screenState` legacy artifact remains.

Rollback/recovery is the transaction boundary itself:

```sql
ROLLBACK;
```

After rollback, fix the rejected precondition, start a new transaction, and run
the complete artifact again. Never inspect after `COMMIT` and then manually
undo; failed invariants must raise before commit so no partial logical mutation
is persisted.
