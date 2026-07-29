import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkflowSegmentComposer,
  computeCompositionStructureKey,
  computeSegmentFingerprint,
} from "../src/modules/workflow-segments/composer";
import { WorkflowSegmentRepository } from "../src/modules/workflow-segments/repository";
import { transitionWorkflowExecutionBinding } from "../src/modules/workflow-segments/execution-lifecycle.service";
import type {
  WorkflowCompositionRecord,
  WorkflowSegmentVersionRecord,
} from "../src/modules/workflow-segments/types";
import {
  compileGeneratedWorkflowTemplate,
  computeGeneratedWorkflowCompiledPlanHash,
} from "../src/modules/workflows/workflow-validator";
import {
  assertWorkflowSafetyDispatch,
  computeWorkflowSafetyArtifactFingerprint,
  reserveWorkflowSafetyAdmission,
} from "../src/modules/workflows/workflow-safety-admission.service";

const repoRoot = path.resolve(__dirname, "..");
const postgresUrl = process.env.PN_AGENCY_CHAIN_PG_URL
  ?? process.env.PNQ001_PG_URL
  ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";

const deviceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const requestKey = "agency_chain_request";
const intent = "reddit private draft exact unique title PN_E2E_FIXTURE";
const title = "PN_E2E_FIXTURE";

let adminPool: Pool;
let pool: Pool;
let schema = "";
let previousDatabaseUrl: string | undefined;

function withSearchPath(url: string, schemaName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schemaName}`);
  return parsed.toString();
}

async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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

function fixture(): {
  segment: WorkflowSegmentVersionRecord;
  composition: WorkflowCompositionRecord;
} {
  const outputSchema = {
    required: ["draftSavedTree", "finalDraftsTree"],
    properties: {
      draftSavedTree: { type: "object" as const },
      finalDraftsTree: { type: "object" as const },
    },
  };
  const postconditionContract = {
    version: "1" as const,
    all: [{
      left: { path: "outputs.finalDraftsTree.empty" },
      operator: "equals" as const,
      operatorOpcode: 2,
      right: { value: true },
    }],
  };
  const segment: WorkflowSegmentVersionRecord = {
    segmentKey: "reddit_private_draft_reversible",
    version: "fixture",
    platform: "com.reddit.frontpage",
    status: "promoted_fixture",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", pattern: "^[A-Za-z0-9_-]{1,120}$" },
      },
      additionalProperties: false,
    },
    outputSchema,
    postconditionContract,
    compatibility: {},
    fingerprint: "",
    template: {
      id: "reddit_private_draft_reversible",
      name: "Reddit private draft reversible",
      platform: "com.reddit.frontpage",
      description: "Private reversible agency fixture",
      version: "fixture",
      safetyClass: "private_reversible_fixture",
      outputSchema,
      postconditionContract,
      goalContract: {
        version: "1",
        stages: [
          {
            id: "create_private_draft",
            required: true,
            allowedActions: ["classify_ui_tree"],
            allowedEffects: ["business_mutation"],
            produces: ["draftSavedTree"],
          },
          {
            id: "cleanup_private_draft",
            required: true,
            allowedActions: ["classify_ui_tree"],
            allowedEffects: ["local_restore"],
            after: ["create_private_draft"],
            produces: ["finalDraftsTree"],
            consumes: ["draftSavedTree"],
          },
        ],
        requiredOutputs: ["draftSavedTree", "finalDraftsTree"],
        allowedEffects: ["business_mutation", "local_restore"],
      },
      allowedRecoveryRequests: [],
      requiredRecoveryCapabilities: ["state_reobserve"],
      recoveryPolicy: {
        autonomy: "bounded",
        aiRecoveryEnabled: false,
        maxAttemptsPerStep: 0,
        maxAttemptsPerWorkflow: 0,
        maxRecoveryActionsPerAttempt: 0,
        allowedRecoveryRequests: [],
        requireStateVerification: true,
        learnFromFailure: false,
      },
      compatibleAppVersions: ["fixture"],
      steps: [
        {
          type: "action",
          id: "save_private_draft",
          action: "classify_ui_tree",
          effect: "business_mutation",
          goalStage: "create_private_draft",
          params: { title: { $bind: "inputs.title" } },
          saveOutputAs: "draftSavedTree",
        },
        {
          type: "action",
          id: "delete_private_draft",
          action: "classify_ui_tree",
          effect: "local_restore",
          goalStage: "cleanup_private_draft",
          params: {
            title: { $bind: "inputs.title" },
            previous: { $bind: "draftSavedTree" },
          },
          saveOutputAs: "finalDraftsTree",
        },
      ],
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 1,
      runtimeContract: "edge-workflow/v2",
    },
  };
  segment.fingerprint = computeSegmentFingerprint(segment);
  const composition: WorkflowCompositionRecord = {
    compositionName: "reddit_private_draft_reversible",
    version: "fixture",
    compositionKey: "",
    capabilityKey: "reddit_private_draft_reversible",
    platform: "com.reddit.frontpage",
    status: "promoted_fixture",
    inputSchema: segment.inputSchema,
    outputSchema,
    inputResolver: {
      version: "1",
      fields: {
        title: {
          sources: [{
            kind: "regex",
            pattern: "exact unique title\\s+([A-Za-z0-9_-]{1,120})",
            group: 1,
            flags: "i",
          }],
          transforms: [{ kind: "trim" }],
        },
      },
    },
    postconditionContract,
    executionPolicy: {
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 1,
      runtimeContract: "edge-workflow/v2",
    },
    compatibility: {},
    nodes: [{
      nodeKey: "private_draft_roundtrip",
      ordinal: 0,
      segmentKey: segment.segmentKey,
      segmentVersion: segment.version,
      inputBindings: { title: "title" },
      outputBindings: {
        draftSavedTree: "draftSavedTree",
        finalDraftsTree: "finalDraftsTree",
      },
      dependsOn: [],
    }],
  };
  composition.compositionKey = computeCompositionStructureKey(
    composition,
    new Map([[`${segment.segmentKey}@${segment.version}`, segment]]),
  );
  return { segment, composition };
}

describe("compiler to cleanup PostgreSQL agency chain", () => {
  beforeAll(async () => {
    const parsed = new URL(postgresUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("agency chain test database must be local");
    }
    adminPool = new Pool({ connectionString: postgresUrl, max: 2 });
    schema = `agency_chain_${process.pid}_${Date.now()}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const isolatedUrl = withSearchPath(postgresUrl, schema);
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = isolatedUrl;
    pool = new Pool({ connectionString: isolatedUrl, max: 6 });

    await pool.query(`
      CREATE TABLE lifecycle_state_definitions (
        lifecycle_key TEXT NOT NULL,
        status TEXT NOT NULL,
        initial BOOLEAN NOT NULL DEFAULT FALSE,
        terminal BOOLEAN NOT NULL DEFAULT FALSE,
        retryable BOOLEAN NOT NULL DEFAULT FALSE,
        administrative BOOLEAN NOT NULL DEFAULT FALSE,
        dispatchable BOOLEAN NOT NULL DEFAULT FALSE,
        manual BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (lifecycle_key, status)
      );
      CREATE TABLE lifecycle_resource_bindings (
        resource_table REGCLASS NOT NULL,
        lifecycle_key TEXT NOT NULL,
        state_column NAME NOT NULL,
        PRIMARY KEY (resource_table, state_column)
      );
      CREATE TABLE lifecycle_transitions (
        lifecycle_key TEXT NOT NULL,
        action_key TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        manual_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        external_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        automatic BOOLEAN NOT NULL DEFAULT FALSE,
        mark_started BOOLEAN NOT NULL DEFAULT FALSE,
        mark_completed BOOLEAN NOT NULL DEFAULT FALSE,
        clear_completed BOOLEAN NOT NULL DEFAULT FALSE,
        clear_failure BOOLEAN NOT NULL DEFAULT FALSE,
        reset_retry BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (lifecycle_key, action_key, from_status)
      );
      CREATE TABLE workflow_segment_versions (
        segment_key TEXT NOT NULL,
        version TEXT NOT NULL,
        platform TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        template JSONB NOT NULL,
        input_schema JSONB NOT NULL,
        output_schema JSONB,
        postcondition_contract JSONB,
        compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
        fingerprint TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (segment_key, version)
      );
      CREATE TABLE workflow_compositions (
        composition_name TEXT NOT NULL,
        version TEXT NOT NULL,
        composition_key TEXT NOT NULL,
        capability_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        input_schema JSONB NOT NULL,
        output_schema JSONB NOT NULL,
        input_resolver JSONB NOT NULL,
        postcondition_contract JSONB NOT NULL,
        execution_policy JSONB NOT NULL,
        compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (composition_name, version)
      );
      CREATE TABLE workflow_composition_nodes (
        composition_name TEXT NOT NULL,
        composition_version TEXT NOT NULL,
        node_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        segment_key TEXT NOT NULL,
        segment_version TEXT NOT NULL,
        input_bindings JSONB NOT NULL,
        output_bindings JSONB NOT NULL,
        depends_on JSONB NOT NULL,
        PRIMARY KEY (composition_name, composition_version, node_key)
      );
      CREATE TABLE workflow_execution_bindings (
        request_key TEXT PRIMARY KEY,
        execution_key TEXT NOT NULL,
        composition_name TEXT NOT NULL,
        composition_version TEXT NOT NULL,
        composition_key TEXT NOT NULL,
        segment_refs JSONB NOT NULL,
        device_id UUID NOT NULL,
        account_id UUID,
        intent TEXT NOT NULL,
        runtime_inputs JSONB NOT NULL,
        status TEXT NOT NULL,
        postcondition_verified BOOLEAN NOT NULL DEFAULT FALSE,
        result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE runtime_semantic_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        payload JSONB NOT NULL
      );
      CREATE TABLE agency_workflow_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL,
        account_id UUID,
        device_id UUID NOT NULL
      );
    `);
    await pool.query(fs.readFileSync(
      path.join(repoRoot, "src/db/migrations/120_workflow_safety_admission_ledger.sql"),
      "utf8",
    ));

    await pool.query(`
      INSERT INTO lifecycle_state_definitions
        (lifecycle_key,status,initial,terminal,retryable,administrative,dispatchable,sort_order)
      VALUES
        ('artifact_fixture','promoted_fixture',FALSE,TRUE,FALSE,FALSE,TRUE,0),
        ('execution_fixture','resolved_fixture',TRUE,FALSE,FALSE,FALSE,TRUE,0),
        ('execution_fixture','running_fixture',FALSE,FALSE,FALSE,FALSE,TRUE,1),
        ('execution_fixture','completed_fixture',FALSE,TRUE,FALSE,FALSE,FALSE,2),
        ('semantic_fixture','active_fixture',TRUE,FALSE,FALSE,FALSE,TRUE,0);
      INSERT INTO lifecycle_resource_bindings(resource_table,lifecycle_key,state_column)
      VALUES
        ('workflow_segment_versions'::regclass,'artifact_fixture','lifecycle_status'),
        ('workflow_compositions'::regclass,'artifact_fixture','lifecycle_status'),
        ('workflow_execution_bindings'::regclass,'execution_fixture','status'),
        ('runtime_semantic_entries'::regclass,'semantic_fixture','status');
      INSERT INTO lifecycle_transitions
        (lifecycle_key,action_key,from_status,to_status,automatic,mark_started,mark_completed)
      VALUES
        ('execution_fixture','begin_fixture','resolved_fixture','running_fixture',TRUE,TRUE,FALSE),
        ('execution_fixture','finish_fixture','running_fixture','completed_fixture',TRUE,FALSE,TRUE);
      INSERT INTO runtime_semantic_entries
        (namespace,entry_key,platform,status,lifecycle_key,priority,payload)
      VALUES (
        'workflow_safety_policy',
        'private_reversible_fixture',
        '*',
        'active_fixture',
        'semantic_fixture',
        100,
        '{
          "version":"fixture_v1",
          "requiresAdmissionLedger":true,
          "requireExplicitEffects":true,
          "scopeTemplate":"{{clientId}}/{{accountId}}/{{deviceId}}",
          "unitCost":1,
          "allowedEffects":["business_mutation","local_restore"],
          "requiredGoalStages":["create_private_draft","cleanup_private_draft"],
          "requirePostcondition":true,
          "approval":{"required":true,"granted":true,"grantId":"fixture_grant","expiresAt":"2099-01-01T00:00:00.000Z"},
          "limits":[{"windowMs":86400000,"maxRuns":1,"maxUnits":1}]
        }'::jsonb
      );
    `);

    const { segment, composition } = fixture();
    await pool.query(
      `INSERT INTO workflow_segment_versions
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,NOW())`,
      [
        segment.segmentKey, segment.version, segment.platform, segment.status,
        JSON.stringify(segment.template), JSON.stringify(segment.inputSchema),
        JSON.stringify(segment.outputSchema), JSON.stringify(segment.postconditionContract),
        JSON.stringify(segment.compatibility), segment.fingerprint,
      ],
    );
    await pool.query(
      `INSERT INTO workflow_compositions
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,NOW())`,
      [
        composition.compositionName, composition.version, composition.compositionKey,
        composition.capabilityKey, composition.platform, composition.status,
        JSON.stringify(composition.inputSchema), JSON.stringify(composition.outputSchema),
        JSON.stringify(composition.inputResolver), JSON.stringify(composition.postconditionContract),
        JSON.stringify(composition.executionPolicy), JSON.stringify(composition.compatibility),
      ],
    );
    const node = composition.nodes[0];
    await pool.query(
      `INSERT INTO workflow_composition_nodes
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
      [
        composition.compositionName, composition.version, node.nodeKey, node.ordinal,
        node.segmentKey, node.segmentVersion, JSON.stringify(node.inputBindings),
        JSON.stringify(node.outputBindings), JSON.stringify(node.dependsOn),
      ],
    );
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client");
    await closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await pool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("preserves safety, binds lifecycle, admits, dispatches, completes, replays and exhausts budget", async () => {
    const composer = new WorkflowSegmentComposer(new WorkflowSegmentRepository());
    const composed = await composer.compose({
      capabilityKey: "reddit_private_draft_reversible",
      platform: "com.reddit.frontpage",
      intent,
      requestKey,
      deviceId,
      accountId,
    });
    expect(composed).not.toBeNull();
    expect(composed!.runtimeInputs).toEqual({ title });
    expect(composed!.template.safetyClass).toBe("private_reversible_fixture");
    expect(composed!.template.goalContract?.stages.map((stage) => stage.id)).toEqual([
      "create_private_draft",
      "cleanup_private_draft",
    ]);
    expect(composed!.template.requiredRecoveryCapabilities).toEqual(["state_reobserve"]);

    const binding = await pool.query(
      `SELECT status FROM workflow_execution_bindings WHERE request_key=$1`,
      [requestKey],
    );
    expect(binding.rows).toEqual([{ status: "resolved_fixture" }]);

    const plan = compileGeneratedWorkflowTemplate(composed!.template);
    const artifactFingerprint = computeWorkflowSafetyArtifactFingerprint(
      computeGeneratedWorkflowCompiledPlanHash(plan),
      { inputs: composed!.runtimeInputs },
    );
    const context = { clientId, accountId, deviceId, intent, source: "agency_chain_test" };
    const admission = await transaction((client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: composed!.template.safetyClass!,
      workflow: composed!.template,
      artifactFingerprint,
      context,
      idempotencyKey: requestKey,
    }));
    expect(admission.replayed).toBe(false);
    await expect(assertWorkflowSafetyDispatch({
      db: pool,
      workflow: composed!.template,
      safetyAdmissionId: admission.id,
      artifactFingerprint,
      context,
    })).resolves.toBeUndefined();

    await expect(transitionWorkflowExecutionBinding(requestKey, {
      transitionAutomatic: true,
      transitionMarkStarted: true,
      targetTerminal: false,
    })).resolves.toBe(true);
    await expect(transitionWorkflowExecutionBinding(requestKey, {
      transitionAutomatic: true,
      transitionMarkCompleted: true,
      targetTerminal: true,
    }, {
      postconditionVerified: true,
      resultEvidence: { cleanupVerified: true },
    })).resolves.toBe(true);
    const terminal = await pool.query(
      `SELECT status,postcondition_verified,result_evidence
         FROM workflow_execution_bindings WHERE request_key=$1`,
      [requestKey],
    );
    expect(terminal.rows).toEqual([{
      status: "completed_fixture",
      postcondition_verified: true,
      result_evidence: { cleanupVerified: true },
    }]);

    const replay = await transaction((client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: composed!.template.safetyClass!,
      workflow: composed!.template,
      artifactFingerprint,
      context,
      idempotencyKey: requestKey,
    }));
    expect(replay).toMatchObject({ id: admission.id, replayed: true });

    await expect(transaction((client) => reserveWorkflowSafetyAdmission({
      db: client,
      safetyClass: composed!.template.safetyClass!,
      workflow: composed!.template,
      artifactFingerprint: createHash("sha256").update(`${artifactFingerprint}:probe`).digest("hex"),
      context,
      idempotencyKey: `${requestKey}_probe`,
    }))).rejects.toMatchObject({ code: "WORKFLOW_SAFETY_RATE_LIMITED" });
  });
});
