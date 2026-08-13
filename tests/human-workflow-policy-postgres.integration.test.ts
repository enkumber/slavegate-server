import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHumanWorkflowRunIdentity } from "../src/modules/human-workflow/run-identity.service";
import { evaluatePostconditionContract, postconditionContractHasClassifyingPredicate } from "../src/modules/workflow-segments/postcondition";

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

describe("human workflow PostgreSQL policy", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    schema = `human_policy_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: scopedUrl(postgresUrl, schema) });
    await pool.query("CREATE TABLE agency_workflow_runs(id uuid)");
    await pool.query("CREATE TABLE workflow_compositions(id uuid)");
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
    await pool.query(
      `INSERT INTO resource_runtime_policies(resource_table, policy)
       VALUES ('workflow_compositions'::regclass,
         '{"predicateMetadata":{"exists":{"eligible":true,"classifying":false,"rhsRequired":false,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"truthy":{"eligible":true,"classifying":true,"rhsRequired":false,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"equals":{"eligible":true,"classifying":true,"rhsRequired":true,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"contains":{"eligible":true,"classifying":true,"rhsRequired":true,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"contains_ci":{"eligible":true,"classifying":true,"rhsRequired":true,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"matches":{"eligible":true,"classifying":true,"rhsRequired":true,"rhsAllowEmpty":false,"rhsAllowSamePath":false}}}'::jsonb)`,
    );
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
    for (const [operator, operatorOpcode] of [["contains", 4], ["contains_ci", 5], ["matches", 10]] as const) {
      for (const right of [undefined, { value: null }, { value: "" }]) {
        const candidate = {
          version: "1" as const,
          all: [{
            left: { path: "outputs.result" },
            operator,
            operatorOpcode,
            operandConstraintOpcode: 1,
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
    await pool.query(
      `UPDATE resource_runtime_policies
          SET policy = '{"predicateMetadata":{"exists":{"eligible":true,"classifying":true,"rhsRequired":false,"rhsAllowEmpty":false,"rhsAllowSamePath":false},"truthy":{"eligible":true,"classifying":false,"rhsRequired":false,"rhsAllowEmpty":false,"rhsAllowSamePath":false}}}'::jsonb
        WHERE resource_table = 'workflow_compositions'::regclass`,
    );
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
});
