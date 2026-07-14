import { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";

type JsonObject = Record<string, unknown>;

export type WorkflowDefinitionStatus = "draft" | "active" | "deprecated" | "archived";

export interface WorkflowDefinition {
  id: string;
  key: string;
  version: number;
  status: WorkflowDefinitionStatus | string;
  title: string;
  description: string | null;
  platform: string;
  intent: string;
  goal: string;
  source: string;
  definition: JsonObject;
  successCriteria: unknown[];
  allowedTools: string[];
  requiredCapabilities: string[];
  constraints: string[];
  fallbackRules: string[];
  rollback: JsonObject;
  policy: JsonObject;
  summary: {
    successCriteria: number;
    allowedTools: number;
    requiredCapabilities: number;
    constraints: number;
    fallbackRules: number;
  };
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinitionResolutionInput {
  intent?: string;
  platform?: string;
  key?: string;
  definitions: WorkflowDefinition[];
  policyGates: CompilerPolicyGate[];
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

function registryPolicy(): JsonObject {
  return {
    readOnly: true,
    compilerVisible: false,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    mode: "workflow_definition_registry_read_only",
  };
}

export function rowToWorkflowDefinition(row: Record<string, unknown>): WorkflowDefinition {
  const successCriteria = arrayValue(row.success_criteria);
  const allowedTools = stringArray(row.allowed_tools);
  const requiredCapabilities = stringArray(row.required_capabilities);
  const constraints = stringArray(row.constraints);
  const fallbackRules = stringArray(row.fallback_rules);
  const rowPolicy = objectValue(row.policy);
  return {
    id: String(row.id),
    key: String(row.definition_key),
    version: typeof row.version === "number" ? row.version : Number(row.version ?? 1),
    status: String(row.status ?? "draft"),
    title: String(row.title),
    description: typeof row.description === "string" ? row.description : null,
    platform: String(row.platform),
    intent: String(row.intent),
    goal: String(row.goal),
    source: String(row.source ?? "unknown"),
    definition: objectValue(row.definition),
    successCriteria,
    allowedTools,
    requiredCapabilities,
    constraints,
    fallbackRules,
    rollback: objectValue(row.rollback),
    policy: {
      ...rowPolicy,
      ...registryPolicy(),
    },
    summary: {
      successCriteria: successCriteria.length,
      allowedTools: allowedTools.length,
      requiredCapabilities: requiredCapabilities.length,
      constraints: constraints.length,
      fallbackRules: fallbackRules.length,
    },
    createdBy: String(row.created_by ?? "unknown"),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function terms(input: WorkflowDefinitionResolutionInput): string[] {
  return [
    input.key,
    input.intent,
    input.platform,
  ]
    .map((entry) => stringValue(entry)?.toLowerCase())
    .filter((entry): entry is string => !!entry);
}

function scoreDefinition(definition: WorkflowDefinition, input: WorkflowDefinitionResolutionInput, searchTerms: string[]): number {
  let score = 0;
  if (input.key && definition.key === input.key) score += 80;
  if (input.intent && definition.intent === input.intent) score += 50;
  if (input.platform && definition.platform === input.platform) score += 30;
  if (definition.status === "active") score += 10;
  if (definition.status === "draft") score += 2;

  const haystack = [
    definition.key,
    definition.intent,
    definition.platform,
    definition.title,
    definition.goal,
    definition.allowedTools.join(" "),
    definition.requiredCapabilities.join(" "),
  ].join(" ").toLowerCase();
  score += searchTerms.filter((term) => haystack.includes(term)).length * 4;
  return score;
}

function gateSummary(policyGates: CompilerPolicyGate[]): JsonObject {
  const relevant = policyGates.filter((gate) => [
    "compiler_knowledge_application",
    "limited_reuse_scope_match",
    "compiler_auto_use",
    "execution_path_change",
  ].includes(gate.id));
  return {
    gates: relevant.map((gate) => ({
      id: gate.id,
      category: gate.category,
      state: gate.state,
      risk: gate.risk,
      owner: gate.owner,
      safeToAutoApply: gate.remediation.safeToAutoApply,
      version: gate.version ?? 1,
    })),
    total: relevant.length,
    blocked: relevant.filter((gate) => gate.state === "blocked").length,
    highRisk: relevant.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: 0,
  };
}

export function buildWorkflowDefinitionResolution(input: WorkflowDefinitionResolutionInput): JsonObject {
  const searchTerms = terms(input);
  const candidates = input.definitions
    .map((definition) => ({
      definition,
      score: scoreDefinition(definition, input, searchTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.definition.version - left.definition.version);
  const best = candidates[0]?.definition ?? null;

  return {
    intent: input.intent ?? null,
    platform: input.platform ?? null,
    key: input.key ?? null,
    policy: registryPolicy(),
    outcome: best ? "blocked_by_policy" : "no_matching_definition",
    candidateDefinition: best,
    candidateDefinitions: candidates.slice(0, 5).map((candidate) => ({
      definition: candidate.definition,
      score: candidate.score,
    })),
    wouldUseDefinition: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    selectedDefinitionId: null,
    blockers: best
      ? [
          "workflow_definition_registry_read_only",
          "compiler_auto_use_disabled",
          "execution_changing_disabled",
        ]
      : [
          "workflow_definition_not_found",
          "workflow_definition_registry_read_only",
        ],
    policyGateSummary: gateSummary(input.policyGates),
    rollbackPreview: best
      ? {
          available: true,
          definitionId: best.id,
          key: best.key,
          version: best.version,
          rollback: best.rollback,
          wouldRollback: false,
          reason: "Registry resolution is read-only.",
        }
      : {
          available: false,
          wouldRollback: false,
          reason: "No candidate definition matched the query.",
        },
    notes: [
      "Workflow Definition Registry is declarative and read-only.",
      "Resolution preview does not alter compiler plans, workflow cache, or execution path.",
      "Definitions require explicit policy gate changes before compiler use.",
    ],
  };
}

export function workflowDefinitionRegistryPolicy(): JsonObject {
  return registryPolicy();
}
