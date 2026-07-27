import { getDb } from "../../db/client";
import type { WorkflowGoalContract, WorkflowTemplate } from "../workflows/types";
import { parseWorkflowGoalContract } from "../workflows/goal-contract";

export type CatalogSafetyClass = string;

export interface CatalogRetrievalPolicy {
  maxContextArtifacts: number;
  maxContextUiItems: number;
  maxContextFailures: number;
  maxRankedCapabilities: number;
  maxArtifactRows: number;
  maxFailedArtifactRows: number;
  maxArtifactSteps: number;
  artifactParamAllowlist: string[];
  uiGraphSafetyAllowlist: CatalogSafetyClass[];
  artifactSafetyAllowlist: Record<CatalogSafetyClass, CatalogSafetyClass[]>;
}

export interface WorkflowCapabilityRecord {
  capabilityKey: string;
  platform: string;
  description: string | null;
  aliases: string[];
  requiredTerms: string[];
  forbiddenTerms: string[];
  safetyClass: CatalogSafetyClass;
  portabilityScope: string;
  minMatchScore: number;
  ambiguityMargin: number;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface RankedWorkflowCapability {
  capability: WorkflowCapabilityRecord;
  score: number;
}

export interface CompilerRetrievalContext {
  fullArtifactCacheKey: string | null;
  matchedCapabilityKey: string | null;
  matchedCapabilityScore: number | null;
  recommendedSafetyClass: CatalogSafetyClass | null;
  goalContract: WorkflowGoalContract | null;
  matchedCapabilityMetadata: Record<string, unknown> | null;
  knowledge: {
    promotedArtifacts: Array<Record<string, unknown>>;
    uiGraph: {
      selectors: Array<Record<string, unknown>>;
      transitions: Array<Record<string, unknown>>;
    };
    avoid: Array<Record<string, unknown>>;
  };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      return stringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function artifactSafety(row: Record<string, unknown>): string | null {
  const workflow = jsonObject(row.workflow);
  const compiledPlan = jsonObject(row.compiled_plan);
  const metadata = jsonObject(compiledPlan.metadata);
  const sourceMetadata = jsonObject(row.source_metadata);
  const value = metadata.safetyClass ?? workflow.safetyClass ?? sourceMetadata.safetyClass;
  return typeof value === "string" ? value : null;
}

function artifactAllowedByCapability(
  row: Record<string, unknown>,
  capability: WorkflowCapabilityRecord,
  policy: CatalogRetrievalPolicy,
): boolean {
  const safety = artifactSafety(row);
  return safety !== null
    && (policy.artifactSafetyAllowlist[capability.safetyClass] ?? []).includes(safety as CatalogSafetyClass);
}

function compactStep(value: unknown, policy: CatalogRetrievalPolicy): Record<string, unknown> | null {
  const step = jsonObject(value);
  if (!step.id && !step.action && !step.type) return null;
  const params = jsonObject(step.params);
  const safeParams = Object.fromEntries(
    Object.entries(params).filter(([key, item]) =>
      policy.artifactParamAllowlist.includes(key)
      && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    ),
  );
  return {
    id: typeof step.id === "string" ? step.id : null,
    type: typeof step.type === "string" ? step.type : null,
    action: typeof step.action === "string" ? step.action : null,
    ...(Object.keys(safeParams).length > 0 ? { params: safeParams } : {}),
    ...(typeof step.reason === "string" ? { verification: step.reason } : {}),
  };
}

function compactArtifact(row: Record<string, unknown>, policy: CatalogRetrievalPolicy): Record<string, unknown> {
  const workflow = jsonObject(row.workflow) as WorkflowTemplate & Record<string, unknown>;
  const sourceMetadata = jsonObject(row.source_metadata);
  const steps = Array.isArray(workflow.steps)
    ? workflow.steps
        .map((step) => compactStep(step, policy))
        .filter((step): step is Record<string, unknown> => !!step)
        .slice(0, policy.maxArtifactSteps)
    : [];
  return {
    capabilityKey: row.capability_key ?? sourceMetadata.capabilityKey ?? null,
    cacheKey: row.cache_key,
    role: row.role ?? sourceMetadata.capabilityRole ?? "complete",
    workflowId: workflow.id ?? row.canonical_workflow_id,
    name: workflow.name ?? null,
    safetyClass: artifactSafety(row),
    steps,
  };
}

function compactFailure(row: Record<string, unknown>): Record<string, unknown> {
  const workflow = jsonObject(row.workflow) as WorkflowTemplate & Record<string, unknown>;
  const sourceMetadata = jsonObject(row.source_metadata);
  const unsafePackages = Array.isArray(workflow.steps)
    ? workflow.steps
        .map((step) => jsonObject(jsonObject(step).params).packageName)
        .filter((value): value is string => typeof value === "string")
        .slice(0, 4)
    : [];
  return {
    workflowId: workflow.id ?? row.canonical_workflow_id,
    reason: sourceMetadata.quarantineReason ?? sourceMetadata.lastFailureReason ?? "previous artifact was quarantined",
    ...(unsafePackages.length > 0 ? { packagesFromRejectedPlan: unsafePackages } : {}),
  };
}

function mapCapabilityRow(row: Record<string, unknown>): WorkflowCapabilityRecord {
  return {
    capabilityKey: String(row.capability_key),
    platform: String(row.platform),
    description: typeof row.description === "string" ? row.description : null,
    aliases: stringArray(row.aliases),
    requiredTerms: stringArray(row.required_terms),
    forbiddenTerms: stringArray(row.forbidden_terms),
    safetyClass: row.safety_class as CatalogSafetyClass,
    portabilityScope: row.portability_scope as WorkflowCapabilityRecord["portabilityScope"],
    minMatchScore: Number(row.min_match_score ?? 0.62),
    ambiguityMargin: Number(row.ambiguity_margin ?? 0.12),
    metadata: jsonObject(row.metadata),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
  };
}

function relatedAppIds(platform: string, capabilities: RankedWorkflowCapability[]): string[] {
  const values = new Set<string>([platform]);
  for (const { capability } of capabilities.slice(0, 3)) {
    for (const key of ["appId", "packageName"]) {
      const value = capability.metadata[key];
      if (typeof value === "string" && value.trim()) values.add(value.trim());
    }
  }
  return [...values];
}

export function formatCompilerRetrievalContext(context: CompilerRetrievalContext): string {
  const payload = {
    matchedCapabilityKey: context.matchedCapabilityKey,
    matchedCapabilityScore: context.matchedCapabilityScore,
    recommendedSafetyClass: context.recommendedSafetyClass,
    goalContract: context.goalContract,
    promotedKnowledge: context.knowledge.promotedArtifacts,
    promotedUiGraph: context.knowledge.uiGraph,
    previousFailuresToAvoid: context.knowledge.avoid,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length <= 20_000) return encoded;
  return JSON.stringify({
    ...payload,
    promotedKnowledge: context.knowledge.promotedArtifacts.slice(0, 2),
    promotedUiGraph: {
      selectors: context.knowledge.uiGraph.selectors.slice(0, 4),
      transitions: context.knowledge.uiGraph.transitions.slice(0, 4),
    },
    previousFailuresToAvoid: context.knowledge.avoid.slice(0, 2),
    retrievalContextTruncated: true,
  });
}

export class CapabilityCatalogService {
  async retrieve(
    intent: string,
    platform: string,
    policy: CatalogRetrievalPolicy,
  ): Promise<CompilerRetrievalContext> {
    const db = getDb();
    const capabilityRows = await db.query(
      `SELECT *
       FROM resolve_workflow_capabilities($1, $2)
       LIMIT 500`,
      [intent, platform],
    );
    const ranked = capabilityRows.rows.map((row) => ({
      capability: mapCapabilityRow(row),
      score: Number(row.score),
      selected: row.selected === true,
    }));
    const selected = ranked.find((entry) => entry.selected) ?? null;
    const related = ranked.slice(0, policy.maxRankedCapabilities);
    const relatedKeys = related.map(({ capability }) => capability.capabilityKey);

    let artifactRows: Record<string, unknown>[] = [];
    if (relatedKeys.length > 0) {
      const allowedArtifactSafetyClasses = [
        ...new Set(Object.values(policy.artifactSafetyAllowlist).flat()),
      ];
      const artifacts = await db.query(
        `SELECT binding.capability_key, binding.role, binding.coverage, binding.priority,
                cache.*
         FROM workflow_capability_artifacts binding
         JOIN generated_workflow_plan_cache cache ON cache.cache_key = binding.cache_key
         JOIN lifecycle_resource_bindings binding_lifecycle
           ON binding_lifecycle.resource_table = to_regclass('workflow_capability_artifacts')
          AND binding_lifecycle.lifecycle_key = binding.lifecycle_key
         JOIN lifecycle_state_definitions binding_state
           ON binding_state.lifecycle_key = binding.lifecycle_key
          AND binding_state.status = binding.status
         JOIN lifecycle_resource_bindings cache_lifecycle
           ON cache_lifecycle.resource_table = to_regclass('generated_workflow_plan_cache')
          AND cache_lifecycle.lifecycle_key = cache.lifecycle_key
         JOIN lifecycle_state_definitions cache_state
           ON cache_state.lifecycle_key = cache.lifecycle_key
          AND cache_state.status = cache.artifact_state
         WHERE binding.capability_key = ANY($1::text[])
           AND binding_state.dispatchable
           AND cache_state.dispatchable
           AND COALESCE(
             cache.compiled_plan #>> '{metadata,safetyClass}',
             cache.workflow ->> 'safetyClass',
             cache.source_metadata ->> 'safetyClass'
           ) = ANY($3::text[])
         ORDER BY binding.priority, cache.updated_at DESC
         LIMIT $2`,
        [relatedKeys, policy.maxArtifactRows, allowedArtifactSafetyClasses],
      );
      artifactRows = artifacts.rows;
    }

    const fullArtifact = selected
      ? artifactRows.find((row) =>
          row.capability_key === selected.capability.capabilityKey
          && row.role === "complete"
          && artifactAllowedByCapability(row, selected.capability, policy)
        ) ?? null
      : null;

    const promotedArtifacts = artifactRows
      .filter((row, index, all) => all.findIndex((candidate) => candidate.cache_key === row.cache_key) === index)
      .filter((row) => row.cache_key !== fullArtifact?.cache_key)
      .slice(0, policy.maxContextArtifacts)
      .map((row) => compactArtifact(row, policy));

    const appIds = relatedAppIds(platform, related);
    const [selectors, transitions, failures] = await Promise.all([
      db.query(
        `SELECT s.app_id, s.state_key, selector.element_key, selector.strategy,
                selector.selector, selector.confidence
         FROM ui_graph_selectors selector
         JOIN ui_graph_states s ON s.id = selector.state_id
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('ui_graph_selectors')
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = binding.lifecycle_key
          AND definition.status = selector.status
         WHERE s.app_id = ANY($1::text[])
           AND definition.terminal
           AND NOT definition.retryable
           AND NOT definition.administrative
         ORDER BY selector.confidence DESC, selector.priority
         LIMIT $2`,
        [appIds, policy.maxContextUiItems],
      ),
      db.query(
        `SELECT app_id, transition_key, action, preconditions, postconditions,
                safety_class, confidence
         FROM ui_graph_transitions
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('ui_graph_transitions')
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = binding.lifecycle_key
          AND definition.status = ui_graph_transitions.status
         WHERE app_id = ANY($1::text[])
           AND definition.terminal
           AND NOT definition.retryable
           AND NOT definition.administrative
           AND safety_class = ANY($3::text[])
         ORDER BY confidence DESC, cost
         LIMIT $2`,
        [appIds, policy.maxContextUiItems, policy.uiGraphSafetyAllowlist],
      ),
      db.query(
        `SELECT *
         FROM generated_workflow_plan_cache
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('generated_workflow_plan_cache')
          AND binding.lifecycle_key = generated_workflow_plan_cache.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = generated_workflow_plan_cache.lifecycle_key
          AND definition.status = generated_workflow_plan_cache.artifact_state
         WHERE (definition.retryable OR definition.administrative)
           AND LOWER(platform) = LOWER($1)
         ORDER BY updated_at DESC
         LIMIT $2`,
        [platform, policy.maxFailedArtifactRows],
      ),
    ]);

    const avoid = failures.rows
      .filter((row) => {
        const metadata = jsonObject(row.source_metadata);
        return relatedKeys.includes(String(metadata.capabilityKey ?? ""));
      })
      .slice(0, policy.maxContextFailures)
      .map((row) => compactFailure(row));

    return {
      fullArtifactCacheKey: typeof fullArtifact?.cache_key === "string" ? fullArtifact.cache_key : null,
      matchedCapabilityKey: selected?.capability.capabilityKey ?? null,
      matchedCapabilityScore: selected?.score ?? null,
      recommendedSafetyClass: selected?.capability.safetyClass ?? null,
      goalContract: parseWorkflowGoalContract(selected?.capability.metadata.goalContract),
      matchedCapabilityMetadata: selected?.capability.metadata ?? null,
      knowledge: {
        promotedArtifacts,
        uiGraph: {
          selectors: selectors.rows.map((row) => ({
            appId: row.app_id,
            state: row.state_key,
            element: row.element_key,
            strategy: row.strategy,
            selector: row.selector,
            confidence: Number(row.confidence),
          })),
          transitions: transitions.rows.map((row) => ({
            appId: row.app_id,
            transition: row.transition_key,
            action: row.action,
            preconditions: row.preconditions,
            postconditions: row.postconditions,
            safetyClass: row.safety_class,
            confidence: Number(row.confidence),
          })),
        },
        avoid,
      },
    };
  }
}

export const capabilityCatalogService = new CapabilityCatalogService();
