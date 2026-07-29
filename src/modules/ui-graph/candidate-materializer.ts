import type { PoolClient } from "pg";
import { getResourceRuntimePolicy } from "../runtime-policy/resource-runtime-policy.service";
import {
  listResourceLifecycleStates,
  selectResourceLifecycleTransition,
} from "../lifecycle/lifecycle.service";

type CandidateRow = Record<string, unknown> & {
  id: string;
  candidate_type: string;
  promoted_entity_id?: string | null;
  payload?: Record<string, unknown>;
};

type ValueSource =
  | { source: "candidate"; field: string }
  | { source: "payload"; path: string }
  | { source: "literal"; value: unknown }
  | { source: "candidate_metadata" };

interface MaterializerConfig {
  resourceTable: string;
  columns: Record<string, ValueSource>;
  conflictColumns: string[];
  updateColumns: string[];
  lifecycleStateColumn?: string;
  rollback?: {
    patch?: Record<string, unknown>;
  };
  quarantine?: {
    patch?: Record<string, unknown>;
  };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${field} must be a SQL identifier`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !IDENTIFIER.test(item))) {
    throw new Error(`${field} must contain SQL identifiers`);
  }
  return [...new Set(value as string[])];
}

function materializerConfig(policy: Record<string, unknown>, candidateType: string): MaterializerConfig {
  const materializers = object(policy.candidateMaterializers, "candidateMaterializers");
  const raw = object(materializers[candidateType], `candidateMaterializers.${candidateType}`);
  const columns = object(raw.columns, `candidateMaterializers.${candidateType}.columns`) as Record<string, ValueSource>;
  for (const [column, source] of Object.entries(columns)) {
    identifier(column, `candidateMaterializers.${candidateType}.columns`);
    const spec = object(source, `candidateMaterializers.${candidateType}.columns.${column}`);
    if (!["candidate", "payload", "literal", "candidate_metadata"].includes(String(spec.source))) {
      throw new Error(`candidateMaterializers.${candidateType}.columns.${column} has an invalid source`);
    }
    if (spec.source === "candidate") identifier(spec.field, `${column}.field`);
    if (spec.source === "payload" && (typeof spec.path !== "string" || !spec.path.trim())) {
      throw new Error(`${column}.path must be a non-empty string`);
    }
  }
  if (Object.keys(columns).length === 0) throw new Error(`candidateMaterializers.${candidateType}.columns is empty`);
  return {
    resourceTable: identifier(raw.resourceTable, `${candidateType}.resourceTable`),
    columns,
    conflictColumns: stringList(raw.conflictColumns, `${candidateType}.conflictColumns`),
    updateColumns: stringList(raw.updateColumns, `${candidateType}.updateColumns`),
    lifecycleStateColumn: raw.lifecycleStateColumn === undefined
      ? undefined
      : identifier(raw.lifecycleStateColumn, `${candidateType}.lifecycleStateColumn`),
    rollback: raw.rollback === undefined
      ? undefined
      : object(raw.rollback, `${candidateType}.rollback`) as MaterializerConfig["rollback"],
    quarantine: raw.quarantine === undefined
      ? undefined
      : object(raw.quarantine, `${candidateType}.quarantine`) as MaterializerConfig["quarantine"],
  };
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function sourceValue(candidate: CandidateRow, source: ValueSource): unknown {
  if (source.source === "candidate") return candidate[source.field];
  if (source.source === "payload") return valueAtPath(candidate.payload ?? {}, source.path);
  if (source.source === "candidate_metadata") return { candidateId: candidate.id };
  return source.value;
}

async function configuredDispatchableState(
  resourceTable: string,
  stateColumn: string,
  client: PoolClient,
): Promise<string> {
  const states = (await listResourceLifecycleStates(resourceTable, stateColumn, client))
    .filter((state) => state.dispatchable && !state.terminal && !state.administrative);
  if (states.length !== 1) {
    throw new Error("candidate materialization requires exactly one configured dispatchable resource state");
  }
  return states[0].status;
}

export async function materializeCandidate(candidate: CandidateRow, client: PoolClient): Promise<string> {
  const policy = await getResourceRuntimePolicy("ui_graph_learning_candidates", client);
  const config = materializerConfig(policy, candidate.candidate_type);
  const columns = Object.keys(config.columns);
  const values = columns.map((column) => sourceValue(candidate, config.columns[column]));
  if (config.lifecycleStateColumn) {
    if (!columns.includes(config.lifecycleStateColumn)) {
      columns.push(config.lifecycleStateColumn);
      values.push(await configuredDispatchableState(config.resourceTable, config.lifecycleStateColumn, client));
    }
  }
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const conflict = config.conflictColumns.length
    ? `ON CONFLICT (${config.conflictColumns.join(",")}) DO UPDATE SET ${
      config.updateColumns.length
        ? config.updateColumns.map((column) => `${column}=EXCLUDED.${column}`).join(",")
        : `${config.conflictColumns[0]}=EXCLUDED.${config.conflictColumns[0]}`
    }`
    : "";
  const result = await client.query(
    `INSERT INTO ${config.resourceTable} (${columns.join(",")})
     VALUES (${placeholders.join(",")})
     ${conflict}
     RETURNING id`,
    values,
  );
  if (!result.rows[0]?.id) throw new Error("candidate materializer did not return an entity id");
  return String(result.rows[0].id);
}

export async function transitionMaterializedCandidate(
  candidate: CandidateRow,
  target: "retryable" | "administrative",
  client: PoolClient,
): Promise<void> {
  if (!candidate.promoted_entity_id) return;
  const policy = await getResourceRuntimePolicy("ui_graph_learning_candidates", client);
  const config = materializerConfig(policy, candidate.candidate_type);
  const transitionConfig = target === "retryable" ? config.rollback : config.quarantine;
  if (!transitionConfig) throw new Error(`candidate materializer has no ${target} policy`);
  if (transitionConfig.patch !== undefined) {
    const patch = object(transitionConfig.patch, `${target}.patch`);
    const columns = Object.keys(patch).map((column) => identifier(column, `${target}.patch`));
    if (columns.length === 0) throw new Error(`candidate materializer ${target} patch is empty`);
    await client.query(
      `UPDATE ${config.resourceTable}
          SET ${columns.map((column, index) => `${column}=$${index + 2}`).join(",")}, updated_at=NOW()
        WHERE id=$1`,
      [candidate.promoted_entity_id, ...columns.map((column) => patch[column])],
    );
    return;
  }
  if (!config.lifecycleStateColumn) {
    throw new Error(`candidate materializer ${target} lifecycle mode requires lifecycleStateColumn`);
  }
  const linked = await client.query(
    `SELECT ${config.lifecycleStateColumn} AS status
       FROM ${config.resourceTable}
      WHERE id=$1
      FOR UPDATE`,
    [candidate.promoted_entity_id],
  );
  if (!linked.rows[0]) throw new Error("materialized UI graph entity was not found");
  const transition = await selectResourceLifecycleTransition(
    config.resourceTable,
    linked.rows[0].status,
    target === "retryable"
      ? { targetRetryable: true, transitionAutomatic: true }
      : { targetAdministrative: true, transitionManualAllowed: true },
    config.lifecycleStateColumn,
    client,
  );
  if (!transition) throw new Error(`materialized UI graph entity has no configured ${target} transition`);
  await client.query(
    `UPDATE ${config.resourceTable}
        SET ${config.lifecycleStateColumn}=$2, updated_at=NOW()
      WHERE id=$1`,
    [candidate.promoted_entity_id, transition.toStatus],
  );
}
