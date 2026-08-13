import { getDb } from "../../db/client";
import {
  lifecycleTransitionSelectorPredicate,
  serializeLifecycleTransitionSelector,
  type LifecycleTransitionSelector,
} from "../lifecycle/lifecycle.service";
import type { WorkflowTemplate } from "../workflows/types";
import {
  validateGeneratedWorkflowTemplate,
  workflowOutputSchemaErrors,
  workflowPostconditionContractErrors,
} from "../workflows/workflow-validator";
import { postconditionContractHasClassifyingPredicate } from "./postcondition";
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

function resourceSpec(entityType: EntityType): {
  table: string;
  keyColumn: string;
} {
  return entityType === "segment"
    ? { table: "workflow_segment_versions", keyColumn: "segment_key" }
    : { table: "workflow_compositions", keyColumn: "composition_name" };
}

async function initialResourceState(table: string, db: Queryable): Promise<string> {
  const result = await db.query(
    `SELECT definition.status
       FROM lifecycle_resource_bindings binding
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = binding.lifecycle_key
      WHERE binding.resource_table = to_regclass($1)
        AND definition.initial
      ORDER BY definition.sort_order, definition.status
      LIMIT 1`,
    [table],
  );
  const value = result.rows[0]?.status;
  if (typeof value !== "string") {
    throw Object.assign(new Error("resource lifecycle has no configured initial state"), {
      status: 503,
      code: "CONTROL_PLANE_LIFECYCLE_UNCONFIGURED",
    });
  }
  return value;
}

async function transitionVersion(
  entityType: EntityType,
  key: string,
  version: string,
  selector: LifecycleTransitionSelector,
  db: Queryable,
): Promise<{ action: string; fromStatus: string; toStatus: string } | null> {
  const { table, keyColumn } = resourceSpec(entityType);
  const predicate = lifecycleTransitionSelectorPredicate("transition", "target", "$3");
  const result = await db.query(
    `WITH selected AS (
       SELECT resource.ctid,
              resource.lifecycle_status AS from_status,
              transition.action_key,
              transition.to_status
         FROM ${table} resource
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass($4)
          AND binding.state_column = 'lifecycle_status'::name
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = binding.lifecycle_key
          AND transition.from_status = resource.lifecycle_status
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
        WHERE resource.${keyColumn} = $1
          AND resource.version = $2
          AND ${predicate}
        ORDER BY transition.action_key
        LIMIT 1
        FOR UPDATE OF resource
     ),
     updated AS (
       UPDATE ${table} resource
          SET lifecycle_status = selected.to_status,
              updated_at = NOW()
         FROM selected
        WHERE resource.ctid = selected.ctid
       RETURNING selected.action_key, selected.from_status, selected.to_status
     )
     SELECT * FROM updated`,
    [key, version, serializeLifecycleTransitionSelector(selector), table],
  );
  const row = result.rows[0];
  return row
    ? {
        action: String(row.action_key),
        fromStatus: String(row.from_status),
        toStatus: String(row.to_status),
      }
    : null;
}

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
  }): Promise<{ segmentKey: string; version: string; fingerprint: string; status: string }> {
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
    const db = getDb();
    const initialStatus = await initialResourceState("workflow_segment_versions", db);
    const candidate: WorkflowSegmentVersionRecord = {
      segmentKey: input.segmentKey,
      version: input.version,
      platform: input.platform,
      status: initialStatus,
      template: validation.template,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema ?? null,
      postconditionContract: input.postconditionContract ?? null,
      compatibility: input.compatibility ?? {},
      fingerprint: "",
    };
    candidate.fingerprint = computeSegmentFingerprint(candidate);
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
           (segment_key, version, platform, template, input_schema,
            output_schema, postcondition_contract, compatibility, fingerprint)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)`,
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
        action: initialStatus,
        toStatus: initialStatus,
        actor: input.actor,
      }, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { segmentKey: input.segmentKey, version: input.version, fingerprint: candidate.fingerprint, status: initialStatus };
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
  }): Promise<{ compositionName: string; version: string; compositionKey: string; status: string }> {
    assertSafeKey(input.compositionName, "compositionName");
    assertSafeKey(input.capabilityKey, "capabilityKey");
    assertVersion(input.version);
    assertObjectSchema(input.inputSchema);
    const contractErrors = [
      ...workflowOutputSchemaErrors(input.outputSchema),
      ...workflowPostconditionContractErrors(input.postconditionContract),
    ];
    if (!postconditionContractHasClassifyingPredicate(input.postconditionContract)) {
      contractErrors.push("postconditionContract must include a classifying predicate over outputs or runtime variables");
    }
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
    const segments = await workflowSegmentRepository.segmentVersions(input.nodes, { dispatchable: true });
    const requiredSegmentRefs = new Set(
      input.nodes.map((node) => `${node.segmentKey}@${node.segmentVersion}`),
    );
    if (segments.size !== requiredSegmentRefs.size) {
      throw Object.assign(new Error("all composition segments must be promoted"), {
        status: 422,
        code: "COMPOSITION_SEGMENT_NOT_PROMOTED",
      });
    }
    const initialStatus = await initialResourceState("workflow_compositions", getDb());
    const composition: WorkflowCompositionRecord = {
      compositionName: input.compositionName,
      version: input.version,
      compositionKey: "",
      capabilityKey: input.capabilityKey,
      platform: input.platform,
      status: initialStatus,
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
          (composition_name, version, composition_key, capability_key, platform,
            input_schema, output_schema, input_resolver, postcondition_contract, execution_policy, compatibility)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
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
        action: initialStatus,
        toStatus: initialStatus,
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
      status: initialStatus,
    };
  }

  async validate(entityType: EntityType, key: string, version: string, actor?: string | null): Promise<string> {
    const db = getDb();
    const transition = await transitionVersion(entityType, key, version, {
      targetTerminal: false,
      targetDispatchable: true,
      transitionExternalAllowed: true,
    }, db);
    if (!transition) {
      throw Object.assign(new Error("entity version has no configured validation transition"), {
        status: 409,
        code: "CONTROL_PLANE_TRANSITION_UNAVAILABLE",
      });
    }
    await recordEvent({
      entityType,
      entityKey: key,
      entityVersion: version,
      action: transition.action,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      actor,
    });
    return transition.toStatus;
  }

  async recordCanary(
    entityType: EntityType,
    key: string,
    version: string,
    evidence: Record<string, unknown>,
    actor?: string | null,
  ): Promise<string> {
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
    const { table, keyColumn } = resourceSpec(entityType);
    const result = await getDb().query(
      `SELECT resource.lifecycle_status
         FROM ${table} resource
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass($3)
          AND binding.state_column = 'lifecycle_status'::name
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = binding.lifecycle_key
          AND definition.status = resource.lifecycle_status
        WHERE resource.${keyColumn} = $1
          AND resource.version = $2
          AND NOT definition.terminal
          AND definition.dispatchable`,
      [key, version, table],
    );
    if (result.rows.length === 0) {
      throw Object.assign(new Error("candidate entity version not found"), { status: 404, code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND" });
    }
    const execution = await getDb().query(
      `SELECT execution.composition_name, execution.composition_version, execution.segment_refs
       FROM workflow_execution_bindings execution
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass('workflow_execution_bindings')
        AND binding.state_column = 'status'::name
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = binding.lifecycle_key
        AND definition.status = execution.status
       WHERE execution.execution_key = $1
         AND definition.terminal
         AND NOT definition.retryable
         AND NOT definition.administrative
         AND execution.postcondition_verified = TRUE
       ORDER BY execution.updated_at DESC
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
      action: String(result.rows[0].lifecycle_status),
      fromStatus: String(result.rows[0].lifecycle_status),
      toStatus: String(result.rows[0].lifecycle_status),
      actor,
      evidence,
    });
    return String(result.rows[0].lifecycle_status);
  }

  async promote(entityType: EntityType, key: string, version: string, actor?: string | null): Promise<string> {
    const { table, keyColumn } = resourceSpec(entityType);
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const canary = await client.query(
        `SELECT 1 FROM workflow_control_plane_events
         WHERE entity_type = $1
           AND entity_key = $2
           AND entity_version = $3
           AND evidence ->> 'passed' = 'true'
           AND evidence ->> 'postconditionVerified' = 'true'
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
           FROM ${table} resource
           JOIN lifecycle_resource_bindings binding
             ON binding.resource_table = to_regclass($3)
            AND binding.state_column = 'lifecycle_status'::name
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = binding.lifecycle_key
            AND definition.status = resource.lifecycle_status
          WHERE resource.${keyColumn} = $1
            AND resource.version = $2
            AND NOT definition.terminal
            AND definition.dispatchable
          FOR UPDATE OF resource`,
        [key, version, table],
      );
      if (target.rows.length === 0) {
        throw Object.assign(new Error("candidate entity version not found"), {
          status: 404,
          code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND",
        });
      }
      const siblingColumn = entityType === "segment" ? "segment_key" : "capability_key";
      const siblingValue = entityType === "segment" ? key : target.rows[0].capability_key;
      const siblings = await client.query(
        `SELECT resource.${keyColumn} AS entity_key, resource.version
           FROM ${table} resource
           JOIN lifecycle_resource_bindings binding
             ON binding.resource_table = to_regclass($5)
            AND binding.state_column = 'lifecycle_status'::name
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = binding.lifecycle_key
            AND definition.status = resource.lifecycle_status
          WHERE resource.${siblingColumn} = $1
            AND resource.platform = $2
            AND definition.terminal
            AND NOT definition.retryable
            AND NOT definition.administrative
            AND NOT (resource.${keyColumn} = $3 AND resource.version = $4)`,
        [siblingValue, target.rows[0].platform, key, version, table],
      );
      for (const sibling of siblings.rows) {
        await transitionVersion(
          entityType,
          String(sibling.entity_key),
          String(sibling.version),
          {
            targetTerminal: true,
            targetRetryable: true,
            transitionAutomatic: true,
          },
          client,
        );
      }
      const promoted = await transitionVersion(entityType, key, version, {
        targetTerminal: true,
        targetRetryable: false,
        targetAdministrative: false,
        transitionExternalAllowed: true,
      }, client);
      if (!promoted) {
        throw Object.assign(new Error("candidate entity version not found"), {
          status: 404,
          code: "CONTROL_PLANE_CANDIDATE_NOT_FOUND",
        });
      }
      await recordEvent({
        entityType,
        entityKey: key,
        entityVersion: version,
        action: promoted.action,
        fromStatus: promoted.fromStatus,
        toStatus: promoted.toStatus,
        actor,
      }, client);
      await client.query("COMMIT");
      return promoted.toStatus;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(entityType: EntityType, key: string, toVersion: string, actor?: string | null): Promise<string> {
    const { table, keyColumn } = resourceSpec(entityType);
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const rollbackTarget = await client.query(
        `SELECT *
           FROM ${table} resource
           JOIN lifecycle_resource_bindings binding
             ON binding.resource_table = to_regclass($3)
            AND binding.state_column = 'lifecycle_status'::name
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = binding.lifecycle_key
            AND definition.status = resource.lifecycle_status
          WHERE resource.${keyColumn} = $1
            AND resource.version = $2
            AND definition.dispatchable
            AND (
              NOT definition.terminal
              OR definition.retryable
            )
          FOR UPDATE OF resource`,
        [key, toVersion, table],
      );
      if (rollbackTarget.rows.length === 0) {
        throw Object.assign(new Error("rollback target not found"), {
          status: 404,
          code: "CONTROL_PLANE_ROLLBACK_TARGET_NOT_FOUND",
        });
      }
      const siblingColumn = entityType === "segment" ? "segment_key" : "capability_key";
      const siblingValue = entityType === "segment" ? key : rollbackTarget.rows[0].capability_key;
      const siblings = await client.query(
        `SELECT resource.${keyColumn} AS entity_key, resource.version
           FROM ${table} resource
           JOIN lifecycle_resource_bindings binding
             ON binding.resource_table = to_regclass($5)
            AND binding.state_column = 'lifecycle_status'::name
           JOIN lifecycle_state_definitions definition
             ON definition.lifecycle_key = binding.lifecycle_key
            AND definition.status = resource.lifecycle_status
          WHERE resource.${siblingColumn} = $1
            AND resource.platform = $2
            AND definition.terminal
            AND NOT definition.retryable
            AND NOT definition.administrative
            AND NOT (resource.${keyColumn} = $3 AND resource.version = $4)`,
        [siblingValue, rollbackTarget.rows[0].platform, key, toVersion, table],
      );
      for (const sibling of siblings.rows) {
        await transitionVersion(
          entityType,
          String(sibling.entity_key),
          String(sibling.version),
          {
            targetTerminal: true,
            targetRetryable: true,
            transitionAutomatic: true,
          },
          client,
        );
      }
      const target = await transitionVersion(entityType, key, toVersion, {
        targetTerminal: true,
        targetRetryable: false,
        targetAdministrative: false,
        transitionExternalAllowed: true,
      }, client);
      if (!target) {
        throw Object.assign(new Error("rollback target not found"), { status: 404, code: "CONTROL_PLANE_ROLLBACK_TARGET_NOT_FOUND" });
      }
      await recordEvent({
        entityType,
        entityKey: key,
        entityVersion: toVersion,
        action: target.action,
        fromStatus: target.fromStatus,
        toStatus: target.toStatus,
        actor,
      }, client);
      await client.query("COMMIT");
      return target.toStatus;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export const workflowSegmentControlPlaneService = new WorkflowSegmentControlPlaneService();
