import { getDb } from "../../db/client";
import type {
  WorkflowCompositionNodeRecord,
  WorkflowCompositionRecord,
  WorkflowSegmentVersionRecord,
} from "./types";

export interface ResourceStateSelector {
  terminal?: boolean;
  retryable?: boolean;
  administrative?: boolean;
  dispatchable?: boolean;
}

function selectorValues(selector: ResourceStateSelector): Array<boolean | null> {
  return [
    selector.terminal ?? null,
    selector.retryable ?? null,
    selector.administrative ?? null,
    selector.dispatchable ?? null,
  ];
}

function lifecycleSelectorSql(stateExpression: string, offset: number): string {
  return `EXISTS (
    SELECT 1
      FROM lifecycle_resource_bindings binding
      JOIN lifecycle_state_definitions definition
        ON definition.lifecycle_key = binding.lifecycle_key
       AND definition.status = ${stateExpression}
     WHERE binding.resource_table = to_regclass($${offset})
       AND ($${offset + 1}::boolean IS NULL OR definition.terminal = $${offset + 1})
       AND ($${offset + 2}::boolean IS NULL OR definition.retryable = $${offset + 2})
       AND ($${offset + 3}::boolean IS NULL OR definition.administrative = $${offset + 3})
       AND ($${offset + 4}::boolean IS NULL OR definition.dispatchable = $${offset + 4})
  )`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapNode(row: Record<string, unknown>): WorkflowCompositionNodeRecord {
  return {
    nodeKey: String(row.node_key),
    ordinal: Number(row.ordinal),
    segmentKey: String(row.segment_key),
    segmentVersion: String(row.segment_version),
    inputBindings: objectValue(row.input_bindings) as Record<string, string>,
    outputBindings: objectValue(row.output_bindings) as Record<string, string>,
    dependsOn: stringArray(row.depends_on),
  };
}

function mapSegment(row: Record<string, unknown>): WorkflowSegmentVersionRecord {
  return {
    segmentKey: String(row.segment_key),
    version: String(row.version),
    platform: String(row.platform),
    status: row.lifecycle_status as WorkflowSegmentVersionRecord["status"],
    template: objectValue(row.template) as unknown as WorkflowSegmentVersionRecord["template"],
    inputSchema: objectValue(row.input_schema) as unknown as WorkflowSegmentVersionRecord["inputSchema"],
    outputSchema: row.output_schema ? objectValue(row.output_schema) as unknown as WorkflowSegmentVersionRecord["outputSchema"] : null,
    postconditionContract: row.postcondition_contract
      ? objectValue(row.postcondition_contract) as unknown as WorkflowSegmentVersionRecord["postconditionContract"]
      : null,
    compatibility: objectValue(row.compatibility),
    fingerprint: String(row.fingerprint),
  };
}

function mapComposition(
  row: Record<string, unknown>,
  nodes: WorkflowCompositionNodeRecord[],
): WorkflowCompositionRecord | null {
  if (
    typeof row.composition_name !== "string"
    || typeof row.version !== "string"
    || typeof row.composition_key !== "string"
    || typeof row.capability_key !== "string"
  ) return null;
  return {
    compositionName: String(row.composition_name),
    version: String(row.version),
    compositionKey: String(row.composition_key),
    capabilityKey: String(row.capability_key),
    platform: String(row.platform),
    status: row.lifecycle_status as WorkflowCompositionRecord["status"],
    inputSchema: objectValue(row.input_schema) as unknown as WorkflowCompositionRecord["inputSchema"],
    outputSchema: objectValue(row.output_schema) as unknown as WorkflowCompositionRecord["outputSchema"],
    inputResolver: objectValue(row.input_resolver) as unknown as WorkflowCompositionRecord["inputResolver"],
    postconditionContract: objectValue(row.postcondition_contract) as unknown as WorkflowCompositionRecord["postconditionContract"],
    executionPolicy: objectValue(row.execution_policy) as unknown as WorkflowCompositionRecord["executionPolicy"],
    compatibility: objectValue(row.compatibility),
    nodes,
  };
}

export class WorkflowSegmentRepository {
  async promotedComposition(capabilityKey: string, platform: string): Promise<WorkflowCompositionRecord | null> {
    const db = getDb();
    const result = await db.query(
      `SELECT *
       FROM workflow_compositions
       WHERE capability_key = $1
         AND ${lifecycleSelectorSql("lifecycle_status", 3)}
         AND (LOWER(platform) = LOWER($2) OR platform = '*')
       ORDER BY CASE WHEN LOWER(platform) = LOWER($2) THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
      [
        capabilityKey,
        platform,
        "workflow_compositions",
        ...selectorValues({ terminal: true, retryable: false, administrative: false }),
      ],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const nodes = await db.query(
      `SELECT *
       FROM workflow_composition_nodes
       WHERE composition_name = $1 AND composition_version = $2
       ORDER BY ordinal`,
      [row.composition_name, row.version],
    );
    return mapComposition(row, nodes.rows.map((node) => mapNode(node as Record<string, unknown>)));
  }

  async compositionVersion(
    compositionName: string,
    version: string,
    selector: ResourceStateSelector,
  ): Promise<WorkflowCompositionRecord | null> {
    const db = getDb();
    const result = await db.query(
      `SELECT *
       FROM workflow_compositions
       WHERE composition_name = $1
         AND version = $2
         AND ${lifecycleSelectorSql("lifecycle_status", 3)}
       LIMIT 1`,
      [compositionName, version, "workflow_compositions", ...selectorValues(selector)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const nodes = await db.query(
      `SELECT *
       FROM workflow_composition_nodes
       WHERE composition_name = $1 AND composition_version = $2
       ORDER BY ordinal`,
      [compositionName, version],
    );
    return mapComposition(row, nodes.rows.map((node) => mapNode(node as Record<string, unknown>)));
  }

  async segmentVersions(
    nodes: WorkflowCompositionNodeRecord[],
    selector: ResourceStateSelector,
  ): Promise<Map<string, WorkflowSegmentVersionRecord>> {
    if (nodes.length === 0) return new Map();
    const db = getDb();
    const values: unknown[] = [];
    const tuples = nodes.map((node) => {
      values.push(node.segmentKey, node.segmentVersion);
      return `($${values.length - 1}, $${values.length})`;
    });
    const result = await db.query(
      `SELECT *
       FROM workflow_segment_versions
       WHERE (segment_key, version) IN (${tuples.join(",")})
         AND ${lifecycleSelectorSql("lifecycle_status", values.length + 1)}`,
      [...values, "workflow_segment_versions", ...selectorValues(selector)],
    );
    return new Map(
      result.rows.map((row) => {
        const mapped = mapSegment(row as Record<string, unknown>);
        return [`${mapped.segmentKey}@${mapped.version}`, mapped];
      }),
    );
  }

  async saveExecutionBinding(input: {
    requestKey: string;
    executionKey: string;
    composition: WorkflowCompositionRecord;
    deviceId: string;
    accountId: string | null;
    intent: string;
    runtimeInputs: Record<string, unknown>;
    auditRuntimeInputs: Record<string, unknown>;
  }): Promise<void> {
    await getDb().query(
      `INSERT INTO workflow_execution_bindings (
         request_key, execution_key, composition_name, composition_version, composition_key,
         segment_refs, device_id, account_id, intent, runtime_inputs, status
       )
       VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,
         (
           SELECT definition.status
             FROM lifecycle_resource_bindings binding
             JOIN lifecycle_state_definitions definition
               ON definition.lifecycle_key = binding.lifecycle_key
            WHERE binding.resource_table = to_regclass('workflow_execution_bindings')
              AND binding.state_column = 'status'::name
              AND definition.initial
            ORDER BY definition.sort_order, definition.status
            LIMIT 1
         )
       )
       ON CONFLICT (request_key) DO UPDATE SET
         execution_key = EXCLUDED.execution_key,
         composition_name = EXCLUDED.composition_name,
         composition_version = EXCLUDED.composition_version,
         composition_key = EXCLUDED.composition_key,
         segment_refs = EXCLUDED.segment_refs,
         device_id = EXCLUDED.device_id,
         account_id = EXCLUDED.account_id,
         intent = EXCLUDED.intent,
         runtime_inputs = EXCLUDED.runtime_inputs,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [
        input.requestKey,
        input.executionKey,
        input.composition.compositionName,
        input.composition.version,
        input.composition.compositionKey,
        JSON.stringify(input.composition.nodes.map((node) => ({
          segmentKey: node.segmentKey,
          segmentVersion: node.segmentVersion,
        }))),
        input.deviceId,
        input.accountId,
        input.intent,
        JSON.stringify(input.auditRuntimeInputs),
      ],
    );
  }
}

export const workflowSegmentRepository = new WorkflowSegmentRepository();
