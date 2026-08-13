import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const postgresUrl = process.env.PN_AGENCY_CHAIN_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

let admin: Pool;
let pool: Pool;
let schema = "";

function scopedUrl(url: string, schemaName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schemaName}`);
  return parsed.toString();
}

function assertSafeTestDatabase(connectionString: string): void {
  const dbName = new URL(connectionString).pathname.replace(/^\//, "");
  if (!/(pnq.*test|test.*pnq|pnq001|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to use PostgreSQL database "${dbName}". Use a disposable PNQ/test database.`);
  }
}

const existsOnly = JSON.stringify({
  version: "1",
  all: [{ left: { path: "outputs.screenState" }, operator: "exists" }],
});
const replacementContract = JSON.stringify({
  version: "1",
  all: [{ left: { path: "outputs.screenState" }, operator: "truthy" }],
});
const failureEvidence = JSON.stringify({
  failureEvidence: { outputs: { screenState: "not_target_application" } },
});

async function installSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE workflow_compositions (
      composition_name TEXT NOT NULL,
      version TEXT NOT NULL,
      composition_key TEXT NOT NULL,
      capability_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL,
      input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      input_resolver JSONB NOT NULL DEFAULT '{}'::jsonb,
      postcondition_contract JSONB NOT NULL,
      execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE workflow_segment_versions(id UUID);
    CREATE TABLE lifecycle_state_definitions (
      lifecycle_key TEXT NOT NULL,
      status TEXT NOT NULL,
      dispatchable BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE lifecycle_resource_bindings (
      resource_table REGCLASS PRIMARY KEY,
      lifecycle_key TEXT NOT NULL,
      state_column NAME NOT NULL DEFAULT 'status'
    );
    CREATE TABLE runtime_semantic_entries (
      lifecycle_key TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL
    );
    CREATE TABLE resource_runtime_policies (
      resource_table REGCLASS PRIMARY KEY,
      policy JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION lifecycle_state_matches(
      target_table REGCLASS,
      state_value TEXT,
      selector JSONB DEFAULT '{}'::jsonb,
      target_state_column NAME DEFAULT 'status'
    )
    RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    AS $$
      SELECT COALESCE((
        SELECT (NOT (selector ? 'dispatchable') OR definition.dispatchable = (selector->>'dispatchable')::boolean)
        FROM lifecycle_resource_bindings binding
        JOIN lifecycle_state_definitions definition
          ON definition.lifecycle_key = binding.lifecycle_key
        WHERE binding.resource_table = target_table
          AND binding.state_column = target_state_column
          AND definition.status = state_value
      ), FALSE);
    $$;
  `);
  await pool.query(readFileSync("src/db/migrations/119_runtime_policy_resolution.sql", "utf8"));
}

async function seedLifecycle(): Promise<void> {
  await pool.query(
    `INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
     VALUES ('workflow_compositions'::regclass, 'composition_repair_fixture', 'lifecycle_status')`,
  );
  await pool.query(
    `INSERT INTO lifecycle_state_definitions(lifecycle_key, status, dispatchable)
     VALUES
       ('composition_repair_fixture', 'promoted', TRUE),
       ('composition_repair_fixture', 'repaired_legacy', FALSE)`,
  );
}

async function seedPolicy(classifying = true): Promise<void> {
  await pool.query(
    `INSERT INTO resource_runtime_policies(resource_table, policy, version)
     VALUES ('workflow_compositions'::regclass, $1::jsonb, 7)`,
    [JSON.stringify({
      predicateMetadata: {
        exists: { eligible: true, classifying: false, operand: { required: false, type: "any", minLength: 0 } },
        truthy: { eligible: true, classifying, operand: { required: false, type: "any", minLength: 0 } },
      },
    })],
  );
}

async function seedLegacyTarget(key = "legacy_key"): Promise<void> {
  await pool.query(
    `INSERT INTO workflow_compositions
       (composition_name, version, composition_key, capability_key, platform,
        lifecycle_status, postcondition_contract, metadata)
     VALUES
       ('reddit_health', 'legacy_v1', $1, 'reddit_health', 'reddit',
        'promoted', $2::jsonb, $3::jsonb)`,
    [key, existsOnly, failureEvidence],
  );
}

async function runRepair(): Promise<void> {
  await pool.query(`
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
        '${replacementContract}'::jsonb -> 'all'
      )
      WHERE admitted;

      IF admitted_count <> 1 THEN
        RAISE EXCEPTION 'expected exactly one admitted replacement proof predicate, found %', admitted_count;
      END IF;

      SELECT array_agg(composition_key), COUNT(*) INTO target_keys, target_count
      FROM (
        SELECT composition_key
        FROM workflow_compositions
        WHERE composition_name = 'reddit_health'
          AND version = 'legacy_v1'
          AND composition_key = 'legacy_key'
          AND platform = 'reddit'
          AND lifecycle_status = 'promoted'
          AND lifecycle_state_matches(
                'workflow_compositions'::regclass,
                lifecycle_status,
                '{"dispatchable":true}'::jsonb,
                'lifecycle_status'
              )
          AND metadata @> '${failureEvidence}'::jsonb
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
      SET lifecycle_status = 'repaired_legacy',
          updated_at = NOW()
      WHERE composition_name = 'reddit_health'
        AND version = 'legacy_v1'
        AND platform = 'reddit'
        AND lifecycle_status = 'promoted'
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
        'reddit_health', 'replacement_v2', 'replacement_key', 'reddit_health', 'reddit',
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '${replacementContract}'::jsonb,
        '{}'::jsonb, '{}'::jsonb,
        jsonb_build_object(
          'replacesCompositionKey', 'legacy_key',
          'replacesVersion', 'legacy_v1',
          'proofAuthorityVersion', (
            SELECT metadata_version FROM canonical_workflow_predicate_metadata()
          ),
          'repairReason', 'reddit_not_target_application_exists_only'
        ),
        'promoted'
      );

      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count <> 1 THEN
        RAISE EXCEPTION 'expected exactly one inserted replacement, found %', inserted_count;
      END IF;

      SELECT COUNT(*) INTO active_promoted_count
      FROM workflow_compositions
      WHERE composition_name = 'reddit_health'
        AND platform = 'reddit'
        AND lifecycle_status = 'promoted'
        AND lifecycle_state_matches(
              'workflow_compositions'::regclass,
              lifecycle_status,
              '{"dispatchable":true}'::jsonb,
              'lifecycle_status'
            )
        AND composition_key = 'replacement_key'
        AND version = 'replacement_v2'
        AND postcondition_contract = '${replacementContract}'::jsonb;

      IF active_promoted_count <> 1 THEN
        RAISE EXCEPTION 'expected exactly one active promoted replacement, found %', active_promoted_count;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM workflow_compositions
        WHERE composition_key = 'legacy_key'
          AND lifecycle_status = 'promoted'
      ) THEN
        RAISE EXCEPTION 'legacy composition key % remains promoted', 'legacy_key';
      END IF;
    END $$;

    COMMIT;
  `);
}

async function expectRollback(
  message: RegExp,
  expectedRows = [{ composition_key: "legacy_key", lifecycle_status: "promoted" }],
): Promise<void> {
  await expect(runRepair()).rejects.toThrow(message);
  await pool.query("ROLLBACK").catch(() => undefined);
  const rows = await pool.query(
    `SELECT composition_key, lifecycle_status
       FROM workflow_compositions
      ORDER BY composition_key, lifecycle_status`,
  );
  expect(rows.rows).toEqual(expectedRows);
}

describe("PostgreSQL proof authority repair transaction", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    admin = new Pool({ connectionString: postgresUrl });
    schema = `proof_repair_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: scopedUrl(postgresUrl, schema) });
    await installSchema();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE workflow_compositions, resource_runtime_policies, runtime_semantic_entries, lifecycle_state_definitions, lifecycle_resource_bindings");
    await seedLifecycle();
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("atomically deactivates the legacy target and activates the admitted replacement", async () => {
    await seedPolicy();
    await seedLegacyTarget();

    await runRepair();

    const rows = await pool.query(
      `SELECT composition_key, lifecycle_status, metadata
         FROM workflow_compositions
        ORDER BY composition_key`,
    );
    expect(rows.rows).toMatchObject([
      { composition_key: "legacy_key", lifecycle_status: "repaired_legacy" },
      {
        composition_key: "replacement_key",
        lifecycle_status: "promoted",
        metadata: {
          replacesCompositionKey: "legacy_key",
          replacesVersion: "legacy_v1",
          proofAuthorityVersion: 7,
          repairReason: "reddit_not_target_application_exists_only",
        },
      },
    ]);
  });

  it("rolls back without partial mutation for zero target, multiple target, proof refusal, and legacy metadata", async () => {
    await seedPolicy();
    await expect(runRepair()).rejects.toThrow(/expected exactly one repair target, found 0/);
    await pool.query("ROLLBACK").catch(() => undefined);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM workflow_compositions")).rows[0].count).toBe(0);

    await seedLegacyTarget();
    await seedLegacyTarget();
    await expectRollback(/expected exactly one repair target, found 2/, [
      { composition_key: "legacy_key", lifecycle_status: "promoted" },
      { composition_key: "legacy_key", lifecycle_status: "promoted" },
    ]);

    await pool.query("TRUNCATE workflow_compositions, resource_runtime_policies, runtime_semantic_entries, lifecycle_state_definitions, lifecycle_resource_bindings");
    await seedLifecycle();
    await seedPolicy(false);
    await seedLegacyTarget();
    await expectRollback(/expected exactly one admitted replacement proof predicate, found 0/);

    await pool.query("TRUNCATE workflow_compositions, resource_runtime_policies, runtime_semantic_entries, lifecycle_state_definitions, lifecycle_resource_bindings");
    await seedLifecycle();
    await seedPolicy();
    await seedLegacyTarget();
    await pool.query("INSERT INTO lifecycle_state_definitions VALUES ('legacy', 'active', TRUE)");
    await pool.query(
      `INSERT INTO runtime_semantic_entries VALUES
       ('legacy', 'active', '{"workflowInterpreterPolicy":{"predicateMetadata":{"truthy":{}}}}'::jsonb)`,
    );
    await expectRollback(/legacy workflow predicate metadata is present/);

    await pool.query("TRUNCATE workflow_compositions, resource_runtime_policies, runtime_semantic_entries, lifecycle_state_definitions, lifecycle_resource_bindings");
    await seedLifecycle();
    await seedPolicy();
    await seedLegacyTarget();
    await pool.query(
      `INSERT INTO workflow_compositions
         (composition_name, version, composition_key, capability_key, platform,
          lifecycle_status, postcondition_contract, metadata)
       VALUES
         ('reddit_health', 'replacement_v2', 'replacement_key', 'reddit_health', 'reddit',
          'promoted', $1::jsonb, '{}'::jsonb)`,
      [replacementContract],
    );
    await expectRollback(/expected exactly one active promoted replacement, found 2/, [
      { composition_key: "legacy_key", lifecycle_status: "promoted" },
      { composition_key: "replacement_key", lifecycle_status: "promoted" },
    ]);
  });
});
