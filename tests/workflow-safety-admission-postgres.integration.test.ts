import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../src/modules/workflows/types";
import {
  assertWorkflowSafetyDispatch,
  computeWorkflowSafetyArtifactFingerprint,
  reserveWorkflowSafetyAdmission,
} from "../src/modules/workflows/workflow-safety-admission.service";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.WORKFLOW_SAFETY_PG_URL
  ?? process.env.PNQ003_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const compiledPlanHash = "a".repeat(64);
const context = {
  clientId: "client",
  accountId: "account",
  deviceId: "device",
  intent: "private_canary",
  source: "integration_test",
};
const workflow: WorkflowTemplate = {
  id: "private_reversible_canary",
  name: "Private reversible canary",
  platform: "android",
  description: "test",
  version: "1.0.0",
  intent: "private_canary",
  safetyClass: "private_reversible_test",
  goalContract: {
    version: "1",
    allowedEffects: ["none", "local_change", "local_restore"],
    stages: [
      { id: "mutate", allowedActions: ["set_clipboard"] },
      { id: "cleanup", allowedActions: ["set_clipboard"], after: ["mutate"] },
    ],
  },
  postconditionContract: {
    version: "1",
    all: [{ left: { path: "outputs.restored" }, operator: "equals", right: { value: true } }],
  },
  steps: [
    { type: "action", action: "get_clipboard", effect: "none", params: {} },
    {
      type: "action",
      action: "set_clipboard",
      effect: "local_change",
      goalStage: "mutate",
      params: { text: "marker" },
    },
    {
      type: "action",
      action: "set_clipboard",
      effect: "local_restore",
      goalStage: "cleanup",
      params: { text: "" },
    },
  ],
  defaultVerificationStrategy: "local_only",
  dataRetentionDays: 1,
};

let adminPool: Pool;
let pool: Pool;
let schema = "";

describe("workflow safety admission PostgreSQL contract", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl);
    adminPool = new Pool({ connectionString: postgresUrl, max: 4 });
    await assertRealPostgres(adminPool);
    schema = `workflow_safety_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: withSearchPath(postgresUrl, schema), max: 6 });
    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        dispatchable BOOLEAN NOT NULL,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS PRIMARY KEY,
        lifecycle_key TEXT NOT NULL,
        state_column NAME NOT NULL
      );
      CREATE TABLE runtime_semantic_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE agency_workflow_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL,
        account_id UUID NULL,
        device_id UUID NOT NULL
      );
    `);
    const migration = fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/120_workflow_safety_admission_ledger.sql"),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
    await pool.query(`
      INSERT INTO lifecycle_state_definitions(lifecycle_key, status, dispatchable)
      VALUES ('workflow_safety_fixture', 'active_fixture', TRUE);
      INSERT INTO lifecycle_resource_bindings(resource_table, lifecycle_key, state_column)
      VALUES ('runtime_semantic_entries'::regclass, 'workflow_safety_fixture', 'status');
      INSERT INTO runtime_semantic_entries
        (namespace, entry_key, platform, status, lifecycle_key, priority, payload)
      VALUES (
        'workflow_safety_policy',
        'private_reversible_test',
        '*',
        'active_fixture',
        'workflow_safety_fixture',
        100,
        '{
          "version": "fixture_v1",
          "requiresAdmissionLedger": true,
          "requireExplicitEffects": true,
          "scopeTemplate": "{{clientId}}/{{accountId}}/{{deviceId}}",
          "unitCost": 1,
          "allowedEffects": ["none", "local_change", "local_restore"],
          "requiredGoalStages": ["mutate", "cleanup"],
          "requirePostcondition": true,
          "approval": {
            "required": true,
            "granted": true,
            "grantId": "fixture_grant",
            "expiresAt": "2099-01-01T00:00:00.000Z"
          },
          "limits": [{"windowMs": 86400000, "maxRuns": 1, "maxUnits": 1}]
        }'::jsonb
      );
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("reapplies the generic migration without schema drift", async () => {
    const result = await pool.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agency_workflow_runs'
         AND column_name IN ('safety_admission_id', 'idempotency_key')
       ORDER BY column_name
    `);
    expect(result.rows.map((row) => row.column_name)).toEqual([
      "idempotency_key",
      "safety_admission_id",
    ]);
  });

  it("serializes budget allocation, replays exactly once, and rejects changed inputs", async () => {
    const firstVariables = { inputs: { marker: "first" } };
    const fingerprint = computeWorkflowSafetyArtifactFingerprint(compiledPlanHash, firstVariables);
    const first = await inTransaction(async (client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: "private_reversible_test",
      workflow,
      artifactFingerprint: fingerprint,
      context,
      idempotencyKey: "canary_once",
    }));
    expect(first.replayed).toBe(false);

    const replay = await inTransaction(async (client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: "private_reversible_test",
      workflow,
      artifactFingerprint: fingerprint,
      context,
      idempotencyKey: "canary_once",
    }));
    expect(replay).toMatchObject({ id: first.id, replayed: true, consumedUnits: 1 });

    await expect(inTransaction(async (client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: "private_reversible_test",
      workflow,
      artifactFingerprint: computeWorkflowSafetyArtifactFingerprint(
        compiledPlanHash,
        { inputs: { marker: "changed" } },
      ),
      context,
      idempotencyKey: "canary_once",
    }))).rejects.toMatchObject({ code: "WORKFLOW_IDEMPOTENCY_CONFLICT" });

    await expect(inTransaction(async (client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: "private_reversible_test",
      workflow,
      artifactFingerprint: computeWorkflowSafetyArtifactFingerprint(
        compiledPlanHash,
        { inputs: { marker: "second" } },
      ),
      context,
      idempotencyKey: "canary_second",
    }))).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_RATE_LIMITED" });
  });

  it("accepts only the exact receipt binding at dispatch", async () => {
    const fingerprint = computeWorkflowSafetyArtifactFingerprint(
      compiledPlanHash,
      { inputs: { marker: "first" } },
    );
    const ledger = await pool.query<{ id: string }>(
      `SELECT id FROM workflow_safety_admission_ledger WHERE idempotency_key = $1`,
      ["canary_once"],
    );
    await expect(assertWorkflowSafetyDispatch({
      db: pool,
      workflow: { ...workflow, recoveryPolicy: { autonomy: "hydrated_fixture" } },
      safetyAdmissionId: ledger.rows[0].id,
      artifactFingerprint: fingerprint,
      context,
    })).resolves.toBeUndefined();
    await expect(assertWorkflowSafetyDispatch({
      db: pool,
      workflow,
      safetyAdmissionId: ledger.rows[0].id,
      artifactFingerprint: fingerprint,
      context: { ...context, intent: "different_intent" },
    })).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_ADMISSION_INVALID" });
  });

  it("serializes concurrent allocations for the same PostgreSQL scope", async () => {
    const concurrentContext = { ...context, accountId: "concurrent_account" };
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await reserveWorkflowSafetyAdmission({
        db: firstClient,
        safetyClass: "private_reversible_test",
        workflow,
        artifactFingerprint: computeWorkflowSafetyArtifactFingerprint(
          compiledPlanHash,
          { inputs: { marker: "concurrent_first" } },
        ),
        context: concurrentContext,
        idempotencyKey: "concurrent_first",
      });

      let secondSettled = false;
      const second = reserveWorkflowSafetyAdmission({
        db: secondClient,
        safetyClass: "private_reversible_test",
        workflow,
        artifactFingerprint: computeWorkflowSafetyArtifactFingerprint(
          compiledPlanHash,
          { inputs: { marker: "concurrent_second" } },
        ),
        context: concurrentContext,
        idempotencyKey: "concurrent_second",
      });
      const observedSecond = second.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ).finally(() => {
        secondSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondSettled).toBe(false);
      await firstClient.query("COMMIT");
      const secondOutcome = await observedSecond;
      expect(secondOutcome.status).toBe("rejected");
      if (secondOutcome.status === "rejected") {
        expect(secondOutcome.error).toMatchObject({ code: "WORKFLOW_SAFETY_RATE_LIMITED" });
      }
      await secondClient.query("ROLLBACK");
    } finally {
      await firstClient.query("ROLLBACK").catch(() => {});
      await secondClient.query("ROLLBACK").catch(() => {});
      firstClient.release();
      secondClient.release();
    }
  });
});

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function withSearchPath(url: string, schemaName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schemaName}`);
  return parsed.toString();
}

function assertSafeTestDatabase(url: string): void {
  if (url === process.env.DATABASE_URL) {
    throw new Error("workflow safety test database must not be the production DATABASE_URL");
  }
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`workflow safety test database must be local, received ${parsed.hostname}`);
  }
}

async function assertRealPostgres(database: Pool): Promise<void> {
  const result = await database.query<{ server_version: string }>("SHOW server_version");
  expect(result.rows[0]?.server_version).toMatch(/^\d+\./);
}
