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
  parentDefinitionId: string | null;
  versionNote: string | null;
  definition: JsonObject;
  successCriteria: unknown[];
  allowedTools: string[];
  requiredCapabilities: string[];
  constraints: string[];
  fallbackRules: string[];
  rollback: JsonObject;
  policy: JsonObject;
  promotion: {
    state: string;
    scope: string | null;
    note: string | null;
    promotedBy: string | null;
    promotedAt: string | null;
    revokedBy: string | null;
    revokedAt: string | null;
    confidence: number;
    readiness: JsonObject;
    scopeDetails: JsonObject;
    rollbackDefinitionId: string | null;
    rollbackPreview: JsonObject;
    reusable: boolean;
    compilerEligible: false;
    wouldUseDefinition: false;
    autoUseEnabled: false;
  };
  telemetrySummary: JsonObject;
  confidenceDecay: JsonObject;
  promotionHardening: JsonObject;
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
  requestedScope?: string;
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
    parentDefinitionId: typeof row.parent_definition_id === "string" ? row.parent_definition_id : null,
    versionNote: typeof row.version_note === "string" ? row.version_note : null,
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
    promotion: {
      state: String(row.promotion_state ?? "review_only"),
      scope: typeof row.promotion_scope === "string" ? row.promotion_scope : null,
      note: typeof row.promotion_note === "string" ? row.promotion_note : null,
      promotedBy: typeof row.promoted_by === "string" ? row.promoted_by : null,
      promotedAt: dateValue(row.promoted_at),
      revokedBy: typeof row.revoked_by === "string" ? row.revoked_by : null,
      revokedAt: dateValue(row.revoked_at),
      confidence: Number(row.promotion_confidence ?? 0),
      readiness: objectValue(row.promotion_readiness),
      scopeDetails: objectValue(row.promotion_scope_details),
      rollbackDefinitionId: typeof row.rollback_definition_id === "string" ? row.rollback_definition_id : null,
      rollbackPreview: objectValue(row.rollback_preview),
      reusable: row.promotion_state === "limited_reuse",
      compilerEligible: false,
      wouldUseDefinition: false,
      autoUseEnabled: false,
    },
    telemetrySummary: objectValue(row.telemetry_summary),
    confidenceDecay: objectValue(row.confidence_decay),
    promotionHardening: objectValue(row.promotion_hardening),
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

function gateEnabled(policyGates: CompilerPolicyGate[], id: string): boolean {
  return policyGates.find((gate) => gate.id === id)?.state === "enabled";
}

function scopeMatches(requestedScope: string | undefined, promotionScope: string | null): boolean {
  if (!requestedScope || !promotionScope) return false;
  if (requestedScope === promotionScope) return true;
  const [requestedType, ...requestedParts] = requestedScope.split(":");
  const [promotionType, ...promotionParts] = promotionScope.split(":");
  if (!requestedType || !promotionType || requestedType !== promotionType) return false;
  const requestedValue = requestedParts.join(":");
  const promotionValue = promotionParts.join(":");
  return !!requestedValue && !!promotionValue && requestedValue === promotionValue;
}

function controlledAutoUseDecision(input: {
  definition: WorkflowDefinition | null;
  requestedScope?: string;
  policyGates: CompilerPolicyGate[];
}): JsonObject {
  const blockers: string[] = [];
  const gates = {
    compilerVisibility: gateEnabled(input.policyGates, "compiler_knowledge_application"),
    limitedReuseScopeMatch: gateEnabled(input.policyGates, "limited_reuse_scope_match"),
    autoUse: gateEnabled(input.policyGates, "compiler_auto_use"),
    executionPathChange: gateEnabled(input.policyGates, "execution_path_change"),
  };
  if (!input.definition) blockers.push("workflow_definition_not_found");
  if (!gates.compilerVisibility) blockers.push("compiler_visibility_gate_disabled");
  if (!gates.limitedReuseScopeMatch) blockers.push("limited_reuse_scope_gate_disabled");
  if (!gates.autoUse) blockers.push("compiler_auto_use_disabled");
  if (!gates.executionPathChange) blockers.push("execution_changing_disabled");
  if (input.definition) {
    if (input.definition.status !== "active") blockers.push("workflow_definition_not_active");
    if (input.definition.promotion.state !== "limited_reuse") blockers.push("workflow_definition_not_limited_reuse");
    if (!scopeMatches(input.requestedScope, input.definition.promotion.scope)) blockers.push("limited_reuse_scope_mismatch");
    if (Number(input.definition.promotion.confidence ?? 0) < 0.6) blockers.push("promotion_confidence_below_threshold");
    const readinessState = typeof input.definition.promotion.readiness.state === "string"
      ? input.definition.promotion.readiness.state
      : null;
    if (!["manual_limited_promotion_ready", "manual_rollback_applied"].includes(readinessState ?? "")) {
      blockers.push("promotion_readiness_not_ready");
    }
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  const mayUseDefinition = uniqueBlockers.filter((blocker) => blocker !== "execution_changing_disabled").length === 0;

  return {
    gates,
    requestedScope: input.requestedScope ?? null,
    scopeMatched: !!input.definition && scopeMatches(input.requestedScope, input.definition.promotion.scope),
    wouldUseDefinition: mayUseDefinition,
    wouldChangePlan: mayUseDefinition,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    safeToAutoApply: false,
    selectedDefinitionId: mayUseDefinition ? input.definition?.id ?? null : null,
    outcome: mayUseDefinition ? "would_use_definition_dry_run_only" : "blocked_by_policy",
    blockers: uniqueBlockers,
    notes: [
      "Controlled auto-use is a dry-run decision only.",
      "Execution and workflow cache changes remain disabled until canary/smoke gates are implemented and approved.",
    ],
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
  const controlledDecision = controlledAutoUseDecision({
    definition: best,
    requestedScope: input.requestedScope,
    policyGates: input.policyGates,
  });

  return {
    intent: input.intent ?? null,
    platform: input.platform ?? null,
    key: input.key ?? null,
    requestedScope: input.requestedScope ?? null,
    policy: registryPolicy(),
    outcome: best ? controlledDecision.outcome : "no_matching_definition",
    candidateDefinition: best,
    candidateDefinitions: candidates.slice(0, 5).map((candidate) => ({
      definition: candidate.definition,
      score: candidate.score,
    })),
    wouldUseDefinition: controlledDecision.wouldUseDefinition === true,
    wouldChangePlan: controlledDecision.wouldChangePlan === true,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    selectedDefinitionId: controlledDecision.selectedDefinitionId ?? null,
    blockers: best
      ? Array.isArray(controlledDecision.blockers) ? controlledDecision.blockers : []
      : [
          "workflow_definition_not_found",
          "workflow_definition_registry_controlled",
        ],
    policyGateSummary: gateSummary(input.policyGates),
    controlledDecision,
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
      "Workflow Definition Registry is declarative and controlled by policy gates.",
      "Resolution preview does not alter workflow cache or execution path.",
      "A true wouldUseDefinition is still dry-run only unless execution gates and canary/smoke checks are separately approved.",
    ],
  };
}

export function workflowDefinitionRegistryPolicy(): JsonObject {
  return registryPolicy();
}
