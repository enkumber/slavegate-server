import { getDb } from "../../db/client";
import type { WorkflowTemplate } from "../workflows/types";
import { portableCapabilityTokens } from "./portable-capability";

const MAX_CONTEXT_ARTIFACTS = 4;
const MAX_CONTEXT_UI_ITEMS = 10;
const MAX_CONTEXT_FAILURES = 4;

export type CatalogSafetyClass =
  | "read_only"
  | "navigation"
  | "standard"
  | "mutating"
  | "sensitive"
  | "destructive";

export interface WorkflowCapabilityRecord {
  capabilityKey: string;
  platform: string;
  description: string | null;
  aliases: string[];
  requiredTerms: string[];
  forbiddenTerms: string[];
  safetyClass: CatalogSafetyClass;
  portabilityScope: "global" | "contextual" | "device" | "account";
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

function normalizedPlatform(value: string): string {
  return value.trim().toLowerCase();
}

function capabilitySimilarity(queryTokens: string[], descriptorTokens: string[]): number {
  if (queryTokens.length === 0 || descriptorTokens.length === 0) return 0;
  const query = new Set(queryTokens);
  const descriptor = new Set(descriptorTokens);
  let shared = 0;
  for (const token of query) {
    if (descriptor.has(token)) shared += 1;
  }
  if (shared < 2) return 0;
  const queryCoverage = shared / query.size;
  const descriptorCoverage = shared / descriptor.size;
  return (2 * queryCoverage * descriptorCoverage) / (queryCoverage + descriptorCoverage);
}

function capabilityDescriptorSets(capability: WorkflowCapabilityRecord): string[][] {
  return [
    capability.capabilityKey,
    capability.description ?? "",
    ...capability.aliases,
  ]
    .map(portableCapabilityTokens)
    .filter((tokens) => tokens.length > 0);
}

export function rankWorkflowCapabilities(
  intent: string,
  platform: string,
  capabilities: WorkflowCapabilityRecord[],
): RankedWorkflowCapability[] {
  const queryTokens = portableCapabilityTokens(intent);
  const query = new Set(queryTokens);
  const wantedPlatform = normalizedPlatform(platform);
  return capabilities
    .filter((capability) =>
      capability.portabilityScope === "global"
      && (normalizedPlatform(capability.platform) === wantedPlatform || normalizedPlatform(capability.platform) === "android")
      && capability.requiredTerms.every((term) => portableCapabilityTokens(term).every((token) => query.has(token)))
      && capability.forbiddenTerms.every((term) => portableCapabilityTokens(term).every((token) => !query.has(token)))
    )
    .map((capability) => ({
      capability,
      score: Math.max(0, ...capabilityDescriptorSets(capability).map((tokens) => capabilitySimilarity(queryTokens, tokens))),
    }))
    .filter(({ capability, score }) => score >= capability.minMatchScore)
    .sort((a, b) => b.score - a.score || b.capability.updatedAt.localeCompare(a.capability.updatedAt));
}

export function selectUnambiguousCapability(
  ranked: RankedWorkflowCapability[],
): RankedWorkflowCapability | null {
  const best = ranked[0];
  if (!best) return null;
  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < best.capability.ambiguityMargin) return null;
  return best;
}

function safetyRank(value: unknown): number {
  switch (value) {
    case "read_only": return 0;
    case "navigation": return 1;
    case "standard": return 2;
    case "mutating": return 3;
    case "sensitive": return 4;
    case "destructive": return 5;
    default: return Number.POSITIVE_INFINITY;
  }
}

function artifactSafety(row: Record<string, unknown>): string | null {
  const workflow = jsonObject(row.workflow);
  const compiledPlan = jsonObject(row.compiled_plan);
  const metadata = jsonObject(compiledPlan.metadata);
  const sourceMetadata = jsonObject(row.source_metadata);
  const value = metadata.safetyClass ?? workflow.safetyClass ?? sourceMetadata.safetyClass;
  return typeof value === "string" ? value : null;
}

function artifactAllowedByCapability(row: Record<string, unknown>, capability: WorkflowCapabilityRecord): boolean {
  const safety = artifactSafety(row);
  return safety !== null && safetyRank(safety) <= safetyRank(capability.safetyClass);
}

const SAFE_PARAM_KEYS = new Set([
  "action",
  "contentDescription",
  "key",
  "packageName",
  "resourceId",
  "semanticId",
  "target",
  "uri",
]);

function compactStep(value: unknown): Record<string, unknown> | null {
  const step = jsonObject(value);
  if (!step.id && !step.action && !step.type) return null;
  const params = jsonObject(step.params);
  const safeParams = Object.fromEntries(
    Object.entries(params).filter(([key, item]) =>
      SAFE_PARAM_KEYS.has(key)
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

function compactArtifact(row: Record<string, unknown>): Record<string, unknown> {
  const workflow = jsonObject(row.workflow) as WorkflowTemplate & Record<string, unknown>;
  const sourceMetadata = jsonObject(row.source_metadata);
  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.map(compactStep).filter((step): step is Record<string, unknown> => !!step).slice(0, 16)
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
  async retrieve(intent: string, platform: string): Promise<CompilerRetrievalContext> {
    const db = getDb();
    const capabilityRows = await db.query(
      `SELECT *
       FROM workflow_capabilities
       WHERE status = 'active'
         AND portability_scope = 'global'
         AND (LOWER(platform) = LOWER($1) OR LOWER(platform) = 'android')
       ORDER BY updated_at DESC
       LIMIT 500`,
      [platform],
    );
    const ranked = rankWorkflowCapabilities(intent, platform, capabilityRows.rows.map(mapCapabilityRow));
    const selected = selectUnambiguousCapability(ranked);
    const related = ranked.slice(0, 5);
    const relatedKeys = related.map(({ capability }) => capability.capabilityKey);
    const queryTokens = portableCapabilityTokens(intent);

    let artifactRows: Record<string, unknown>[] = [];
    if (relatedKeys.length > 0) {
      const artifacts = await db.query(
        `SELECT binding.capability_key, binding.role, binding.coverage, binding.priority,
                cache.*
         FROM workflow_capability_artifacts binding
         JOIN generated_workflow_plan_cache cache ON cache.cache_key = binding.cache_key
         WHERE binding.capability_key = ANY($1::text[])
           AND binding.status = 'active'
           AND cache.artifact_state = 'promoted'
           AND COALESCE(
             cache.compiled_plan #>> '{metadata,safetyClass}',
             cache.workflow ->> 'safetyClass',
             cache.source_metadata ->> 'safetyClass'
           ) IN ('read_only', 'navigation', 'standard', 'mutating', 'sensitive', 'destructive')
         ORDER BY binding.priority, cache.updated_at DESC
         LIMIT 20`,
        [relatedKeys],
      );
      artifactRows = artifacts.rows;
    }

    const fullArtifact = selected
      ? artifactRows.find((row) =>
          row.capability_key === selected.capability.capabilityKey
          && row.role === "complete"
          && artifactAllowedByCapability(row, selected.capability)
        ) ?? null
      : null;

    // Legacy promoted artifacts remain useful as partial context while the
    // normalized catalog is populated organically.
    const legacyRows = await db.query(
      `SELECT *
       FROM generated_workflow_plan_cache
       WHERE artifact_state = 'promoted'
         AND LOWER(platform) = LOWER($1)
         AND COALESCE(source_metadata ->> 'portable', 'true') <> 'false'
         AND COALESCE(source_metadata ->> 'portabilityScope', 'global') NOT IN ('device', 'account', 'contextual')
       ORDER BY updated_at DESC
       LIMIT 100`,
      [platform],
    );
    const scoredLegacy = legacyRows.rows
      .map((row) => {
        const workflow = jsonObject(row.workflow);
        const metadata = jsonObject(row.source_metadata);
        const descriptors = [
          metadata.capabilityKey,
          metadata.intent,
          workflow.intent,
          workflow.id,
          workflow.name,
          workflow.description,
        ].filter((value): value is string => typeof value === "string");
        const score = Math.max(
          0,
          ...descriptors.map((value) => capabilitySimilarity(queryTokens, portableCapabilityTokens(value))),
        );
        return { row, score };
      })
      .filter(({ score }) => score >= 0.34)
      .sort((a, b) => b.score - a.score)
      .map(({ row }) => row);

    const promotedArtifacts = [...artifactRows, ...scoredLegacy]
      .filter((row, index, all) => all.findIndex((candidate) => candidate.cache_key === row.cache_key) === index)
      .filter((row) => row.cache_key !== fullArtifact?.cache_key)
      .slice(0, MAX_CONTEXT_ARTIFACTS)
      .map(compactArtifact);

    const appIds = relatedAppIds(platform, related);
    const [selectors, transitions, failures] = await Promise.all([
      db.query(
        `SELECT s.app_id, s.state_key, selector.element_key, selector.strategy,
                selector.selector, selector.confidence
         FROM ui_graph_selectors selector
         JOIN ui_graph_states s ON s.id = selector.state_id
         WHERE s.app_id = ANY($1::text[])
           AND selector.status = 'promoted'
         ORDER BY selector.confidence DESC, selector.priority
         LIMIT $2`,
        [appIds, MAX_CONTEXT_UI_ITEMS],
      ),
      db.query(
        `SELECT app_id, transition_key, action, preconditions, postconditions,
                safety_class, confidence
         FROM ui_graph_transitions
         WHERE app_id = ANY($1::text[])
           AND status = 'promoted'
           AND safety_class IN ('read_only', 'navigation')
         ORDER BY confidence DESC, cost
         LIMIT $2`,
        [appIds, MAX_CONTEXT_UI_ITEMS],
      ),
      db.query(
        `SELECT *
         FROM generated_workflow_plan_cache
         WHERE artifact_state IN ('failed', 'quarantined')
           AND LOWER(platform) = LOWER($1)
         ORDER BY updated_at DESC
         LIMIT 50`,
        [platform],
      ),
    ]);

    const avoid = failures.rows
      .map((row) => {
        const workflow = jsonObject(row.workflow);
        const metadata = jsonObject(row.source_metadata);
        const descriptors = [
          metadata.intent,
          metadata.capabilityKey,
          workflow.id,
          workflow.name,
          workflow.description,
        ].filter((value): value is string => typeof value === "string");
        const score = Math.max(
          0,
          ...descriptors.map((value) => capabilitySimilarity(queryTokens, portableCapabilityTokens(value))),
        );
        return { row, score };
      })
      .filter(({ score }) => score >= 0.34)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CONTEXT_FAILURES)
      .map(({ row }) => compactFailure(row));

    return {
      fullArtifactCacheKey: typeof fullArtifact?.cache_key === "string" ? fullArtifact.cache_key : null,
      matchedCapabilityKey: selected?.capability.capabilityKey ?? null,
      matchedCapabilityScore: selected?.score ?? null,
      recommendedSafetyClass: selected?.capability.safetyClass ?? null,
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
