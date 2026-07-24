import { getDb } from "../../db/client";
import type { WorkflowTemplate } from "../workflows/types";
import {
  validateGeneratedWorkflowTemplate,
  workflowOutputSchemaErrors,
  workflowPostconditionContractErrors,
} from "../workflows/workflow-validator";
import {
  computeCompositionStructureKey,
  computeSegmentFingerprint,
  validateCompositionGraph,
} from "./composer";
import { workflowSegmentRepository } from "./repository";
import { validateInputResolver } from "./input-resolver";
import type {
  SegmentInputResolver,
  SegmentInputSchema,
  WorkflowCompositionExecutionPolicy,
  WorkflowCompositionNodeRecord,
  WorkflowCompositionRecord,
  WorkflowSegmentVersionRecord,
} from "./types";

type EntityType = "segment" | "composition";
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function assertSafeKey(value: string, name: string): void {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value)) {
    throw Object.assign(new Error(`${name} is invalid`), { status: 400, code: "CONTROL_PLANE_KEY_INVALID" });
  }
}

function assertVersion(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw Object.assign(new Error("version is invalid"), { status: 400, code: "CONTROL_PLANE_VERSION_INVALID" });
  }
}

function assertObjectSchema(schema: SegmentInputSchema): void {
  if (
    !schema
    || schema.type !== "object"
    || !Array.isArray(schema.required)
    || !schema.properties
    || typeof schema.properties !== "object"
  ) {
    throw Object.assign(new Error("inputSchema must be an object schema"), {
      status: 422,
      code: "SEGMENT_INPUT_SCHEMA_INVALID",
    });
  }
}

function assertExecutionPolicy(policy: WorkflowCompositionExecutionPolicy): void {
  if (
    !policy
    || !["local_only", "local_with_screenshot", "full_cascade", "vlm_required"].includes(
      policy.defaultVerificationStrategy,
    )
    || !Number.isInteger(policy.dataRetentionDays)
    || policy.dataRetentionDays < 1
    || policy.dataRetentionDays > 3650
    || policy.runtimeContract !== "edge-workflow/v2"
  ) {
    throw Object.assign(new Error("composition executionPolicy is invalid"), {
      status: 422,
      code: "COMPOSITION_EXECUTION_POLICY_INVALID",
    });
  }
}

async function recordEvent(input: {
  entityType: EntityType;
  entityKey: string;
  entityVersion: string;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor?: string | null;
  reason?: string | null;
  evidence?: Record<string, unknown>;
}, db: Queryable = getDb()): Promise<void> {
  await db.query(
    `INSERT INTO workflow_control_plane_events
       (entity_type, entity_key, entity_version, action, from_status, to_status, actor, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      input.entityType,
      input.entityKey,
      input.entityVersion,
      input.action,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.actor ?? null,
      input.reason ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
}

export class WorkflowSegmentControlPlaneService {
  async createSegmentVersion(input: {
    segmentKey: string;
    version: string;
    platform: string;
    description?: string | null;
    template: WorkflowTemplate;
    inputSchema: SegmentInputSchema;
    outputSchema?: WorkflowSegmentVersionRecord["outputSchema"];
    postconditionContract?: WorkflowSegmentVersionRecord["postconditionContract"];
    compatibility?: Record<string, unknown>;
    actor?: string | null;
  }): Promise<{ segmentKey: string; version: string; fingerprint: string; status: "draft" }> {
    assertSafeKey(input.segmentKey, "segmentKey");
    assertVersion(input.version);
    assertObjectSchema(input.inputSchema);
    const contractErrors = [
      ...(input.outputSchema ? workflowOutputSchemaErrors(input.outputSchema) : []),
      ...(input.postconditionContract ? workflowPostconditionContractErrors(input.postconditionContract) : []),
    ];
    if (contractErrors.length > 0) {
      throw Object.assign(new Error(`segment contract failed validation: ${contractErrors.join("; ")}`), {
        status: 422,
        code: "WORKFLOW_SEGMENT_CONTRACT_INVALID",
        validationErrors: contractErrors,
      });
    }
    const validation = validateGeneratedWorkflowTemplate(input.template);
    if (!validation.template) {
      throw Object.assign(new Error(`segment template failed validation: ${validation.errors.join("; ")}`), {
        status: 422,
        code: "WORKFLOW_SEGMENT_VALIDATION_FAILED",
        validationErrors: validation.errors,
      });
    }
    const candidate: WorkflowSegmentVersionRecord = {
      segmentKey: input.segmentKey,
      version: input.version,
      platform: input.platform,
      status: "draft",
      template: validation.template,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema ?? null,
      postconditionContract: input.postconditionContract ?? null,
      compatibility: input.compatibility ?? {},
      fingerprint: "",
    };
    candidate.fingerprint = computeSegmentFingerprint(candidate);
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workflow_segments(segment_key, description)
         VALUES ($1,$2)
         ON CONFLICT (segment_key) DO UPDATE SET
           description = COALESCE(EXCLUDED.description, workflow_segments.description),
           updated_at = NOW()`,
        [input.segmentKey, input.description ?? null],
      );
      await client.query(
        `INSERT INTO workflow_segment_versions
           (segment_key, version, platform, lifecycle_status, template, input_schema,
            output_schema, postcondition_contract, compatibility, fingerprint)
         VALUES ($1,$2,$3,'draft',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
        [
          input.segmentKey,
          input.version,
          input.platform,
          JSON.stringify(candidate.template),
          JSON.stringify(candidate.inputSchema),
          candidate.outputSchema ? JSON.stringify(candidate.outputSchema) : null,
          candidate.postconditionContract ? JSON.stringify(candidate.postconditionContract) : null,
          JSON.stringify(candidate.compatibility),
          candidate.fingerprint,
        ],
      );
      await recordEvent({
        entityType: "segment",
        entityKey: input.segmentKey,
        entityVersion: input.version,
        action: "create",
        toStatus: "draft",
        actor: input.actor,
      }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { segmentKey: input.segmentKey, version: input.version, fingerprint: candidate.fingerprint, status: "draft" };
  }

  async createCompositionVersion(input: {
    compositionName: string;
    version: string;
    capabilityKey: string;
    platform: string;
    inputSchema: SegmentInputSchema;
    outputSchema: WorkflowCompositionRecord["outputSchema"];
    inputResolver: SegmentInputResolver;
    postconditionContract: WorkflowCompositionRecord["postconditionContract"];
    executionPolicy: WorkflowCompositionExecutionPolicy;
    compatibility?: Record<string, unknown>;
    nodes: WorkflowCompositionNodeRecord[];
    actor?: string | null;
  }): Promise<{ compositionName: string; version: string; compositionKey: string; status: "draft" }> {
    assertSafeKey(input.compositionName, "compositionName");
    assertSafeKey(input.capabilityKey, "capabilityKey");
    assertVersion(input.version);
    assertObjectSchema(input.inputSchema);
    const contractErrors = [
      ...workflowOutputSchemaErrors(input.outputSchema),
      ...workflowPostconditionContractErrors(input.postconditionContract),
    ];
    if (contractErrors.length > 0) {
      throw Object.assign(new Error(`composition contract failed validation: ${contractErrors.join("; ")}`), {
        status: 422,
        code: "WORKFLOW_COMPOSITION_CONTRACT_INVALID",
        validationErrors: contractErrors,
      });
    }
    validateInputResolver(input.inputResolver, input.inputSchema);
    assertExecutionPolicy(input.executionPolicy);
    if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
      throw Object.assign(new Error("composition requires at least one node"), { status: 422, code: "COMPOSITION_NODES_REQUIRED" });
    }
    const segments = await workflowSegmentRepository.segmentVersions(input.nodes, ["candidate", "promoted"]);
    const requiredSegmentRefs = new Set(
      input.nodes.map((node) => `${node.segmentKey}@${node.segmentVersion}`),
    );
    if (segments.size !== requiredSegmentRefs.size) {
      throw Object.assign(new Error("all composition segments must be promoted"), {
        status: 422,
        code: "COMPOSITION_SEGMENT_NOT_PROMOTED",
      });
    }
    const composition: WorkflowCompositionRecord = {
      compositionName: input.compositionName,
      version: input.version,
      compositionKey: "",
      capabilityKey: input.capabilityKey,
      platform: input.platform,
      status: "draft",
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      inputResolver: input.inputResolver,
      postconditionContract: input.postconditionContract,
      executionPolicy: input.executionPolicy,
      compatibility: input.compatibility ?? {},
      nodes: [...input.nodes].sort((left, right) => left.ordinal - right.ordinal),
    };
    validateCompositionGraph(composition, segments);
    composition.compositionKey = computeCompositionStructureKey(composition, segments);
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workflow_compositions
          (composition_name, version, composition_key, capability_key, platform, lifecycle_status,
            input_schema, output_schema, input_resolver, postcondition_contract, execution_policy, compatibility)
         VALUES ($1,$2,$3,$4,$5,'draft',$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
        [
          composition.compositionName,
          composition.version,
          composition.compositionKey,
          composition.capabilityKey,
          composition.platform,
          JSON.stringify(composition.inputSchema),
          JSON.stringify(composition.outputSchema),
          JSON.stringify(composition.inputResolver),
          JSON.stringify(composition.postconditionContract),
          JSON.stringify(composition.executionPolicy),
          JSON.stringify(composition.compatibility),
        ],
      );
      for (const node of composition.nodes) {
        await client.query(
          `INSERT INTO workflow_composition_nodes
             (composition_name, composition_version, node_key, ordinal, segment_key, segment_version,
              input_bindings, output_bindings, depends_on)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::text[])`,
          [
            composition.compositionName,
            composition.version,
            node.nodeKey,
            node.ordinal,
            node.segmentKey,
            node.segmentVersion,
            JSON.stringify(node.inputBindings),
            JSON.stringify(node.outputBindings),
            node.dependsOn,
          ],
        );
      }
      await recordEvent({
        entityType: "composition",
        entityKey: composition.compositionName,
        entityVersion: composition.version,
        action: "create",
        toStatus: "draft",
        actor: input.actor,
        evidence: { compositionKey: composition.compositionKey },
      }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      compositionName: composition.compositionName,
      version: composition.version,
      compositionKey: composition.compositionKey,
      status: "draft",
    };
  }

  async validate(entityType: EntityType, key: string, version: string, actor?: string | null): Promise<void> {
    const table = entityType === "segment" ? "workflow_segment_versions" : "workflow_compositions";
    const keyColumn = entityType === "segment" ? "segment_key" : "composition_name";
    const db = getDb();
    const result = await db.query(
      `UPDATE ${table}
       SET lifecycle_status = 'candidate', updated_at = NOW()
       WHERE ${keyColumn} = $1 AND version = $2 AND lifecycle_status = 'draft'
       RETURNING lifecycle_status`,
      [key, version],
    );
    if (result.rows.length === 0) {
      throw Object.assign(new Error("draft entity version not found"), { status: 404, code: "CONTROL_PLANE_DRAFT_NOT_FOUND" });
    }
    await recordEvent({
      entityType,
      entityKey: key,
      entityVersion: version,
      action: "validate",
      fromStatus: "draft",
      toStatus: "candidate",
      actor,
    });
  }

  async recordCanary(
    entityType: EntityType,
    key: string,
    version: string,
    evidence: Record<string, unknown>,
    actor?: string | null,
  ): Promise<void> {
    if (
      evidence.passed !== true
      || evidence.postconditionVerified !== true
      || typeof evidence.executionKey !== "string"
      || !/^[a-f0-9]{24}$/.test(evidence.executionKey)
    ) {
      throw Object.assign(new Error("canary evidence must prove a passed execution and verified postcondition"), {
        status: 422,
        code: "CONTROL_PLANE_CANARY_EVIDENCE_INVALID",
      });
    }
    const table = entityType === "segment" ? "workflow_segment_versions" : "workflow_compositions";
    const keyColumn = entityType === "segment" ? "segment_key" : "composition_name";
    const result = await getDb().query(
      `SELECT 1 FROM ${table} WHERE ${keyColumn} = $1 AND version = $2 AND lifecycle_status = 'candidate'`,
      [key, version],
    );
    if (result.rows.length === 0) {
      throw Object.assign(new Error("candidate entity version not found"), { status: 404, code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND" });
    }
    const execution = await getDb().query(
      `SELECT composition_name, composition_version, segment_refs
       FROM workflow_execution_bindings
       WHERE execution_key = $1
         AND status = 'completed'
         AND postcondition_verified = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
      [evidence.executionKey],
    );
    if (execution.rows.length === 0) {
      throw Object.assign(new Error("canary execution is not completed with a verified postcondition"), {
        status: 409,
        code: "CONTROL_PLANE_CANARY_EXECUTION_UNVERIFIED",
      });
    }
    if (
      entityType === "composition"
      && (
        execution.rows[0].composition_name !== key
        || execution.rows[0].composition_version !== version
      )
    ) {
      throw Object.assign(new Error("canary execution belongs to another composition version"), {
        status: 409,
        code: "CONTROL_PLANE_CANARY_EXECUTION_MISMATCH",
      });
    }
    if (
      entityType === "segment"
      && !(
        Array.isArray(execution.rows[0].segment_refs)
        && execution.rows[0].segment_refs.some((item: unknown) => (
          !!item
          && typeof item === "object"
          && (item as Record<string, unknown>).segmentKey === key
          && (item as Record<string, unknown>).segmentVersion === version
        ))
      )
    ) {
      throw Object.assign(new Error("canary execution does not contain this segment version"), {
        status: 409,
        code: "CONTROL_PLANE_CANARY_EXECUTION_MISMATCH",
      });
    }
    await recordEvent({
      entityType,
      entityKey: key,
      entityVersion: version,
      action: "canary",
      fromStatus: "candidate",
      toStatus: "candidate",
      actor,
      evidence,
    });
  }

  async promote(entityType: EntityType, key: string, version: string, actor?: string | null): Promise<void> {
    const table = entityType === "segment" ? "workflow_segment_versions" : "workflow_compositions";
    const keyColumn = entityType === "segment" ? "segment_key" : "composition_name";
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const canary = await client.query(
        `SELECT 1 FROM workflow_control_plane_events
         WHERE entity_type = $1 AND entity_key = $2 AND entity_version = $3 AND action = 'canary'
         LIMIT 1`,
        [entityType, key, version],
      );
      if (canary.rows.length === 0) {
        throw Object.assign(new Error("promotion requires canary evidence"), {
          status: 409,
          code: "CONTROL_PLANE_CANARY_REQUIRED",
        });
      }
      const target = await client.query(
        `SELECT *
         FROM ${table}
         WHERE ${keyColumn} = $1 AND version = $2 AND lifecycle_status = 'candidate'
         FOR UPDATE`,
        [key, version],
      );
      if (target.rows.length === 0) {
        throw Object.assign(new Error("candidate entity version not found"), {
          status: 404,
          code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND",
        });
      }
      if (entityType === "segment") {
        await client.query(
          `UPDATE workflow_segment_versions
           SET lifecycle_status = 'degraded', updated_at = NOW()
           WHERE segment_key = $1
             AND platform = $2
             AND lifecycle_status = 'promoted'`,
          [key, target.rows[0].platform],
        );
      } else {
        await client.query(
          `UPDATE workflow_compositions
           SET lifecycle_status = 'degraded', updated_at = NOW()
           WHERE capability_key = $1
             AND platform = $2
             AND lifecycle_status = 'promoted'`,
          [target.rows[0].capability_key, target.rows[0].platform],
        );
      }
      const promoted = await client.query(
        `UPDATE ${table}
         SET lifecycle_status = 'promoted', updated_at = NOW()
         WHERE ${keyColumn} = $1 AND version = $2 AND lifecycle_status = 'candidate'
         RETURNING 1`,
        [key, version],
      );
      if (promoted.rows.length === 0) {
        throw Object.assign(new Error("candidate entity version not found"), {
          status: 404,
          code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND",
        });
      }
      await recordEvent({
        entityType,
        entityKey: key,
        entityVersion: version,
        action: "promote",
        fromStatus: "candidate",
        toStatus: "promoted",
        actor,
      }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(entityType: EntityType, key: string, toVersion: string, actor?: string | null): Promise<void> {
    const table = entityType === "segment" ? "workflow_segment_versions" : "workflow_compositions";
    const keyColumn = entityType === "segment" ? "segment_key" : "composition_name";
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const rollbackTarget = await client.query(
        `SELECT *
         FROM ${table}
         WHERE ${keyColumn} = $1
           AND version = $2
           AND lifecycle_status IN ('candidate','degraded')
         FOR UPDATE`,
        [key, toVersion],
      );
      if (rollbackTarget.rows.length === 0) {
        throw Object.assign(new Error("rollback target not found"), {
          status: 404,
          code: "CONTROL_PLANE_ROLLBACK_TARGET_NOT_FOUND",
        });
      }
      if (entityType === "segment") {
        await client.query(
          `UPDATE workflow_segment_versions
           SET lifecycle_status = 'degraded', updated_at = NOW()
           WHERE segment_key = $1
             AND platform = $2
             AND lifecycle_status = 'promoted'`,
          [key, rollbackTarget.rows[0].platform],
        );
      } else {
        await client.query(
          `UPDATE workflow_compositions
           SET lifecycle_status = 'degraded', updated_at = NOW()
           WHERE capability_key = $1
             AND platform = $2
             AND lifecycle_status = 'promoted'`,
          [rollbackTarget.rows[0].capability_key, rollbackTarget.rows[0].platform],
        );
      }
      const target = await client.query(
        `UPDATE ${table} SET lifecycle_status = 'promoted', updated_at = NOW()
         WHERE ${keyColumn} = $1 AND version = $2 AND lifecycle_status IN ('candidate','degraded')
         RETURNING 1`,
        [key, toVersion],
      );
      if (target.rows.length === 0) {
        throw Object.assign(new Error("rollback target not found"), { status: 404, code: "CONTROL_PLANE_ROLLBACK_TARGET_NOT_FOUND" });
      }
      await recordEvent({
        entityType,
        entityKey: key,
        entityVersion: toVersion,
        action: "rollback",
        toStatus: "promoted",
        actor,
      }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export const workflowSegmentControlPlaneService = new WorkflowSegmentControlPlaneService();
