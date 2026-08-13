import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveHumanWorkflowRunIdentity } from "../src/modules/human-workflow/run-identity.service";
import { evaluatePostconditionContract, postconditionContractHasClassifyingPredicate } from "../src/modules/workflow-segments/postcondition";

const postgresUrl = process.env.PN_AGENCY_CHAIN_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
let admin: Pool;
let pool: Pool;
let schema = "";

const operand = (
  required: boolean,
  type: "any" | "string" | "number" | "boolean" | "array" | "object" = "any",
  minLength = 0,
) => ({ required, type, minLength, allowSamePath: false });

function scopedUrl(url: string, schemaName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schemaName}`);
  return parsed.toString();
}

async function upsertWorkflowPredicatePolicies(
  policy: Record<string, unknown>,
  version = 1,
  segmentPolicy: Record<string, unknown> = policy,
  segmentVersion = version,
): Promise<void> {
  await pool.query(
    `INSERT INTO resource_runtime_policies(resource_table, policy, version)
     VALUES
       ('workflow_compositions'::regclass, $1::jsonb, $2),
       ('workflow_segment_versions'::regclass, $3::jsonb, $4)
     ON CONFLICT (resource_table) DO UPDATE
       SET policy = EXCLUDED.policy,
           version = EXCLUDED.version`,
    [JSON.stringify(policy), version, JSON.stringify(segmentPolicy), segmentVersion],
  );
}

describe("human workflow PostgreSQL policy", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    schema = `human_policy_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: scopedUrl(postgresUrl, schema) });
    await pool.query("CREATE TABLE agency_workflow_runs(id uuid)");
    await pool.query("CREATE TABLE workflow_compositions(id uuid)");
    await pool.query("CREATE TABLE workflow_segment_versions(id uuid)");
    await pool.query(
      `CREATE TABLE lifecycle_state_definitions (
         lifecycle_key TEXT NOT NULL,
         status TEXT NOT NULL,
         dispatchable BOOLEAN NOT NULL DEFAULT FALSE
       )`,
    );
    await pool.query(
      `CREATE TABLE runtime_semantic_entries (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         lifecycle_key TEXT NOT NULL,
         status TEXT NOT NULL,
         payload JSONB NOT NULL,
         priority INTEGER NOT NULL DEFAULT 0
       )`,
    );
    await pool.query(
      `CREATE TABLE resource_runtime_policies (
         resource_table REGCLASS PRIMARY KEY,
         policy JSONB NOT NULL,
         version BIGINT NOT NULL DEFAULT 1,
         updated_by TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await pool.query(readFileSync("src/db/migrations/119_runtime_policy_resolution.sql", "utf8"));
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE resource_runtime_policies, runtime_semantic_entries, lifecycle_state_definitions");
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'resource_runtime_policies_pkey'
            AND conrelid = 'resource_runtime_policies'::regclass
        ) THEN
          ALTER TABLE resource_runtime_policies
            ADD CONSTRAINT resource_runtime_policies_pkey PRIMARY KEY (resource_table);
        END IF;
      END $$;
    `);
  });

  it("lets PostgreSQL select fresh, replay and refusal identity behavior", async () => {
    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy)
       VALUES ('agency_workflow_runs'::regclass,
         '{"identityPolicy":{"explicitAdmitted":true,"implicitGenerated":true}}'::jsonb)`,
    );
    const first = await resolveHumanWorkflowRunIdentity(undefined, pool);
    const second = await resolveHumanWorkflowRunIdentity(undefined, pool);
    expect(first).not.toBe(second);
    expect(await resolveHumanWorkflowRunIdentity("replay-key", pool)).toBe("replay-key");
    await pool.query(
      `UPDATE resource_runtime_policies
          SET policy = '{"identityPolicy":{"explicitAdmitted":true,"implicitGenerated":false}}'::jsonb
        WHERE resource_table = 'agency_workflow_runs'::regclass`,
    );
    await expect(resolveHumanWorkflowRunIdentity(undefined, pool)).rejects.toMatchObject({
      code: "WORKFLOW_RUN_NOT_ADMITTED",
      status: 409,
    });
  });

  it("classifies postconditions only through PostgreSQL operator metadata", async () => {
    await upsertWorkflowPredicatePolicies({
      predicateMetadata: {
        exists: { eligible: true, classifying: false, operand: operand(false) },
        truthy: { eligible: true, classifying: true, operand: operand(false) },
        equals: { eligible: true, classifying: true, operand: operand(true, "any", 1) },
        contains: { eligible: true, classifying: true, operand: operand(true, "string", 1) },
        contains_ci: { eligible: true, classifying: true, operand: operand(true, "string", 1) },
        matches: { eligible: true, classifying: true, operand: operand(true, "string", 1) },
      },
    });
    const contract = (operator: string) => ({
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator }],
    });
    expect(await postconditionContractHasClassifyingPredicate(
      contract("exists") as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(
      contract("truthy") as never,
      "workflow_compositions",
      pool,
    )).toBe(true);
    expect(await postconditionContractHasClassifyingPredicate(
      contract("truthy") as never,
      "workflow_segment_versions",
      pool,
    )).toBe(true);
    for (const [operator, operatorOpcode] of [["contains", 4], ["contains_ci", 5], ["matches", 10]] as const) {
      for (const right of [undefined, { value: null }, { value: "" }]) {
        const candidate = {
          version: "1" as const,
          all: [{
            left: { path: "outputs.result" },
            operator,
            operatorOpcode,
            operandContract: operand(true, "string", 1),
            ...(right === undefined ? {} : { right }),
          }],
        };
        expect(await postconditionContractHasClassifyingPredicate(candidate, "workflow_compositions", pool)).toBe(false);
        expect(evaluatePostconditionContract(candidate, { outputs: { result: "anything" } }).ok).toBe(false);
      }
    }
    const binaryContract = (right?: unknown) => ({
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator: "equals", ...(right === undefined ? {} : { right }) }],
    });
    for (const right of [undefined, { value: null }, { value: "" }, { value: [] }, { value: {} }, { path: "outputs.result" }]) {
      expect(await postconditionContractHasClassifyingPredicate(
        binaryContract(right) as never,
        "workflow_compositions",
        pool,
      )).toBe(false);
    }
    expect(await postconditionContractHasClassifyingPredicate(
      binaryContract({ value: "verified" }) as never,
      "workflow_compositions",
      pool,
    )).toBe(true);
    await upsertWorkflowPredicatePolicies({
      predicateMetadata: {
        exists: { eligible: true, classifying: true, operand: operand(false) },
        truthy: { eligible: true, classifying: false, operand: operand(false) },
      },
    }, 2);
    expect(await postconditionContractHasClassifyingPredicate(
      contract("exists") as never,
      "workflow_compositions",
      pool,
    )).toBe(true);
    expect(await postconditionContractHasClassifyingPredicate(
      contract("truthy") as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
  });

  it("fails closed when segment and composition predicate metadata drift", async () => {
    const contract = {
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator: "truthy" }],
    };
    const canonicalPolicy = {
      predicateMetadata: {
        truthy: { eligible: true, classifying: true, operand: operand(false) },
      },
    };
    await upsertWorkflowPredicatePolicies(canonicalPolicy, 10, canonicalPolicy, 11);
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_segment_versions",
      pool,
    )).toBe(false);

    await pool.query(
      `UPDATE resource_runtime_policies
          SET version = 10
        WHERE resource_table = 'workflow_segment_versions'::regclass`,
    );
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_segment_versions",
      pool,
    )).toBe(true);

    await pool.query(
      `UPDATE resource_runtime_policies
          SET policy = $1::jsonb
        WHERE resource_table = 'workflow_segment_versions'::regclass`,
      [JSON.stringify({
        predicateMetadata: {
          truthy: { eligible: true, classifying: false, operand: operand(false) },
        },
      })],
    );
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
    await pool.query("DELETE FROM resource_runtime_policies WHERE resource_table = 'workflow_segment_versions'::regclass");
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
  });

  it("fails closed when either canonical predicate metadata row is missing, disabled, or malformed", async () => {
    const contract = {
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator: "truthy" }],
    };
    const policy = {
      predicateMetadata: {
        truthy: { eligible: true, classifying: true, operand: operand(false) },
      },
    };

    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy, version)
       VALUES ('workflow_compositions'::regclass, $1::jsonb, 1)`,
      [JSON.stringify(policy)],
    );
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await pool.query("DELETE FROM resource_runtime_policies");
    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy, version)
       VALUES ('workflow_segment_versions'::regclass, $1::jsonb, 1)`,
      [JSON.stringify(policy)],
    );
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await upsertWorkflowPredicatePolicies(policy, 1, { ...policy, enabled: false }, 1);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await upsertWorkflowPredicatePolicies(policy, 1, { predicateMetadata: [] }, 1);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await upsertWorkflowPredicatePolicies({ ...policy, enabled: false }, 1, policy, 1);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await upsertWorkflowPredicatePolicies({ predicateMetadata: [] }, 1, policy, 1);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);
  });

  it("fails closed when duplicate canonical predicate metadata rows exist", async () => {
    const contract = {
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator: "truthy" }],
    };
    const policy = {
      predicateMetadata: {
        truthy: { eligible: true, classifying: true, operand: operand(false) },
      },
    };

    await pool.query("ALTER TABLE resource_runtime_policies DROP CONSTRAINT resource_runtime_policies_pkey");
    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy, version)
       VALUES
         ('workflow_compositions'::regclass, $1::jsonb, 1),
         ('workflow_compositions'::regclass, $1::jsonb, 1),
         ('workflow_segment_versions'::regclass, $1::jsonb, 1)`,
      [JSON.stringify(policy)],
    );
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);

    await pool.query("TRUNCATE resource_runtime_policies");
    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy, version)
       VALUES
         ('workflow_compositions'::regclass, $1::jsonb, 1),
         ('workflow_segment_versions'::regclass, $1::jsonb, 1),
         ('workflow_segment_versions'::regclass, $1::jsonb, 1)`,
      [JSON.stringify(policy)],
    );
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_compositions", pool)).toBe(false);
    expect(await postconditionContractHasClassifyingPredicate(contract as never, "workflow_segment_versions", pool)).toBe(false);
  });

  it("fails closed when canonical predicate metadata is missing or split across legacy interpreter policy", async () => {
    const contract = {
      version: "1" as const,
      all: [{ left: { path: "outputs.result" }, operator: "truthy" }],
    };
    await upsertWorkflowPredicatePolicies({ identityPolicy: { explicitAdmitted: true, implicitGenerated: true } });
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(false);

    await upsertWorkflowPredicatePolicies({ predicateMetadata: { truthy: {
      eligible: true, classifying: true, operand: operand(false),
    } } });
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(true);

    await pool.query(
      `INSERT INTO lifecycle_state_definitions(lifecycle_key, status, dispatchable)
       VALUES ('legacy_interpreter', 'active', TRUE)`,
    );
    await pool.query(
      `INSERT INTO runtime_semantic_entries(lifecycle_key, status, payload)
       VALUES ('legacy_interpreter', 'active', $1::jsonb)`,
      [JSON.stringify({ workflowInterpreterPolicy: { predicateMetadata: { truthy: {} } } })],
    );
    expect(await postconditionContractHasClassifyingPredicate(
      contract as never,
      "workflow_compositions",
      pool,
    )).toBe(false);
    await pool.query("DELETE FROM runtime_semantic_entries");
    await pool.query("DELETE FROM lifecycle_state_definitions");
  });

  it("rejects present-but-empty RHS in PostgreSQL even when metadata minLength is zero", async () => {
    await upsertWorkflowPredicatePolicies({ predicateMetadata: { proof_any: {
      eligible: true,
      classifying: true,
      operand: operand(true, "any", 0),
      } } });
    const admitted = async (predicate: Record<string, unknown>): Promise<boolean> => {
      const result = await pool.query<{ admitted: boolean }>(
        `SELECT admitted
           FROM resolve_postcondition_proof_eligibility(
             'workflow_compositions'::regclass,
             $1::jsonb
           )`,
        [JSON.stringify([predicate])],
      );
      return result.rows[0]?.admitted === true;
    };
    const base = { left: { path: "outputs.result" }, operator: "proof_any" };

    for (const right of [
      undefined,
      { value: null },
      { value: "" },
      { value: [] },
      { value: {} },
    ]) {
      expect(await admitted({
        ...base,
        ...(right === undefined ? {} : { right }),
      })).toBe(false);
    }

    for (const right of [
      { value: "verified" },
      { value: ["verified"] },
      { value: { verified: true } },
    ]) {
      expect(await admitted({ ...base, right })).toBe(true);
    }
  });

  it("keeps PostgreSQL proof policy isolated across concurrent search paths", async () => {
    const otherSchema = `${schema}_other`;
    await admin.query(`CREATE SCHEMA "${otherSchema}"`);
    const otherPool = new Pool({ connectionString: scopedUrl(postgresUrl, otherSchema), max: 4 });
    try {
      await otherPool.query("CREATE TABLE workflow_compositions(id uuid)");
      await otherPool.query("CREATE TABLE workflow_segment_versions(id uuid)");
      await otherPool.query(
        `CREATE TABLE resource_runtime_policies (
           resource_table REGCLASS PRIMARY KEY,
           policy JSONB NOT NULL,
           version BIGINT NOT NULL DEFAULT 1,
           updated_by TEXT,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await otherPool.query(readFileSync("src/db/migrations/119_runtime_policy_resolution.sql", "utf8"));
      await upsertWorkflowPredicatePolicies({ predicateMetadata: { truthy: {
          eligible: true, classifying: true, operand: operand(false),
      } } });
      await otherPool.query(
        `INSERT INTO resource_runtime_policies(resource_table, policy)
         VALUES
           ('workflow_compositions'::regclass, $1::jsonb),
           ('workflow_segment_versions'::regclass, $1::jsonb)`,
        [JSON.stringify({ predicateMetadata: { truthy: {
          eligible: true, classifying: false, operand: operand(false),
        } } })],
      );
      const contract = {
        version: "1" as const,
        all: [{ left: { path: "outputs.result" }, operator: "truthy" }],
      };
      const probes = Array.from({ length: 20 }, async (_, index) => {
        const selectedPool = index % 2 === 0 ? pool : otherPool;
        const admitted = await postconditionContractHasClassifyingPredicate(
          contract as never,
          "workflow_compositions",
          selectedPool,
        );
        expect(admitted).toBe(index % 2 === 0);
      });
      await Promise.all(probes);
    } finally {
      await otherPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`);
    }
  });
});
