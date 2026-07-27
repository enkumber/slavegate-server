import { getDb } from "../../db/client";
import type {
  CatalogRetrievalPolicy,
  CatalogSafetyClass,
} from "./capability-catalog.service";

export type CompilerWorkflowSafetyClass = string;

export interface HumanWorkflowCompilerControlPlane {
  version: string;
  missingCapabilityPolicy: string;
  normalizationPolicy: string;
  promptKeys: {
    compile: string;
    repair: string;
    compileSystem: string;
    repairSystem: string;
    policy: string;
  };
  llm: {
    initialMaxTokens: number;
    repairMaxTokens: number;
    temperature: number;
    disableThinking: boolean;
  };
  retrievalPolicy: CatalogRetrievalPolicy;
  safetyClassMap: Record<CatalogSafetyClass, CompilerWorkflowSafetyClass>;
  prompts: {
    compile: string;
    repair: string;
    compileSystem: string;
    repairSystem: string;
    policy: string;
  };
  toolCatalog: Array<Record<string, unknown>>;
}

export function compilerControlPlaneError(message: string): Error {
  return Object.assign(new Error(`compiler control plane unavailable: ${message}`), {
    status: 503,
    code: "HUMAN_WORKFLOW_COMPILER_CONTROL_PLANE_UNAVAILABLE",
    retryable: true,
    nextAction: "retry_compile",
  });
}

function validPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function validRetrievalPolicy(value: unknown): value is CatalogRetrievalPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<CatalogRetrievalPolicy>;
  const numericKeys: Array<keyof CatalogRetrievalPolicy> = [
    "maxContextArtifacts",
    "maxContextUiItems",
    "maxContextFailures",
    "maxRankedCapabilities",
    "maxArtifactRows",
    "maxFailedArtifactRows",
    "maxArtifactSteps",
  ];
  return numericKeys.every((key) => validPositiveInteger(policy[key]))
    && Array.isArray(policy.artifactParamAllowlist)
    && policy.artifactParamAllowlist.every((item) => typeof item === "string" && item.length > 0)
    && Array.isArray(policy.uiGraphSafetyAllowlist)
    && policy.uiGraphSafetyAllowlist.length > 0
    && !!policy.artifactSafetyAllowlist
    && typeof policy.artifactSafetyAllowlist === "object";
}

export async function loadHumanWorkflowCompilerControlPlane(): Promise<HumanWorkflowCompilerControlPlane> {
  const db = getDb();
  const control = await db.query<{ payload: Record<string, unknown> }>(
    `SELECT payload
       FROM runtime_semantic_entries entry
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass('runtime_semantic_entries')
        AND binding.lifecycle_key = entry.lifecycle_key
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE namespace = 'compiler_control_plane'
        AND entry_key = 'human_workflow_v1'
        AND definition.dispatchable
      LIMIT 1`,
  );
  const payload = control.rows[0]?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw compilerControlPlaneError("missing active human_workflow_v1 configuration");
  }
  const promptKeys = payload.promptKeys as HumanWorkflowCompilerControlPlane["promptKeys"] | undefined;
  const llm = payload.llm as HumanWorkflowCompilerControlPlane["llm"] | undefined;
  const retrievalPolicy = payload.retrievalPolicy as CatalogRetrievalPolicy | undefined;
  const safetyClassMap = payload.safetyClassMap as HumanWorkflowCompilerControlPlane["safetyClassMap"] | undefined;
  if (
    typeof payload.version !== "string"
    || typeof payload.missingCapabilityPolicy !== "string"
    || !payload.missingCapabilityPolicy.trim()
    || typeof payload.normalizationPolicy !== "string"
    || !payload.normalizationPolicy.trim()
    || !promptKeys
    || !llm
    || !validRetrievalPolicy(retrievalPolicy)
    || !safetyClassMap
  ) {
    throw compilerControlPlaneError("invalid human_workflow_v1 configuration");
  }
  const keys = [
    promptKeys.compile,
    promptKeys.repair,
    promptKeys.compileSystem,
    promptKeys.repairSystem,
    promptKeys.policy,
  ];
  if (keys.some((key) => typeof key !== "string" || !key.trim())) {
    throw compilerControlPlaneError("invalid prompt key mapping");
  }
  const [promptRows, toolRows] = await Promise.all([
    db.query<{ key: string; content: string }>(
      "SELECT key, content FROM system_prompts WHERE key = ANY($1::text[])",
      [keys],
    ),
    db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
         FROM runtime_semantic_entries entry
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table = to_regclass('runtime_semantic_entries')
          AND binding.lifecycle_key = entry.lifecycle_key
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key = entry.lifecycle_key
          AND definition.status = entry.status
        WHERE namespace = 'tool_catalog'
          AND definition.dispatchable
        ORDER BY priority DESC, entry_key`,
    ),
  ]);
  const prompts = new Map(promptRows.rows.map((row) => [row.key, row.content]));
  for (const key of keys) {
    if (!prompts.get(key)?.trim()) throw compilerControlPlaneError(`missing system prompt ${key}`);
  }
  if (toolRows.rows.length === 0) throw compilerControlPlaneError("empty primitive catalog");
  return {
    version: payload.version,
    missingCapabilityPolicy: "fail_closed",
    normalizationPolicy: "strict_reject",
    promptKeys,
    llm,
    retrievalPolicy,
    safetyClassMap,
    prompts: {
      compile: prompts.get(promptKeys.compile)!,
      repair: prompts.get(promptKeys.repair)!,
      compileSystem: prompts.get(promptKeys.compileSystem)!,
      repairSystem: prompts.get(promptKeys.repairSystem)!,
      policy: prompts.get(promptKeys.policy)!,
    },
    toolCatalog: toolRows.rows.map((row) => row.payload),
  };
}

export function renderCompilerTemplate(template: string, values: Record<string, string>): string {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{([a-zA-Z0-9_]+)}}/g, (_match, key: string) => {
    if (values[key] === undefined) {
      missing.add(key);
      return "";
    }
    return values[key];
  });
  if (missing.size > 0) {
    throw compilerControlPlaneError(`unbound prompt placeholders: ${[...missing].join(", ")}`);
  }
  return rendered;
}
