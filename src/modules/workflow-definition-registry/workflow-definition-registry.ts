import { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";
import type { WorkflowTemplate } from "../workflows/types";

type JsonObject = Record<string, unknown>;

export type WorkflowDefinitionStatus = string;

export interface WorkflowDefinition {
  id: string;
  key: string;
  version: number;
  status: WorkflowDefinitionStatus | string;
  statusCapabilities: {
    initial: boolean;
    terminal: boolean;
    retryable: boolean;
    administrative: boolean;
    dispatchable: boolean;
    manual: boolean;
  };
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
    stateCapabilities: {
      initial: boolean;
      terminal: boolean;
      retryable: boolean;
      administrative: boolean;
      dispatchable: boolean;
      manual: boolean;
    };
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
    compilerEligible: boolean;
    wouldUseDefinition: boolean;
    autoUseEnabled: boolean;
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
  goal?: string;
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

function registryPolicy(overrides: JsonObject = {}): JsonObject {
  const autoUseEnabled = overrides.autoUseEnabled === true;
  const executionChanging = overrides.executionChanging === true;
  const workflowCacheChanging = overrides.workflowCacheChanging === true;
  return {
    ...overrides,
    readOnly: !autoUseEnabled,
    compilerVisible: overrides.compilerVisible === true || autoUseEnabled,
    autoUseEnabled,
    executionChanging,
    workflowCacheChanging,
    mode: autoUseEnabled ? "workflow_definition_auto_use_enabled" : "workflow_definition_registry_read_only",
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
    status: String(row.status ?? ""),
    statusCapabilities: {
      initial: row.status_initial === true,
      terminal: row.status_terminal === true,
      retryable: row.status_retryable === true,
      administrative: row.status_administrative === true,
      dispatchable: row.status_dispatchable === true,
      manual: row.status_manual === true,
    },
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
    policy: registryPolicy(rowPolicy),
    promotion: {
      state: String(row.promotion_state ?? ""),
      stateCapabilities: {
        initial: row.promotion_initial === true,
        terminal: row.promotion_terminal === true,
        retryable: row.promotion_retryable === true,
        administrative: row.promotion_administrative === true,
        dispatchable: row.promotion_dispatchable === true,
        manual: row.promotion_manual === true,
      },
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
      reusable: rowPolicy.reusable === true,
      compilerEligible: rowPolicy.compilerVisible === true || rowPolicy.autoUseEnabled === true,
      wouldUseDefinition: rowPolicy.autoUseEnabled === true,
      autoUseEnabled: rowPolicy.autoUseEnabled === true,
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
  const raw = [
    input.key,
    input.intent,
    input.goal,
  ]
    .map((entry) => stringValue(entry)?.toLowerCase())
    .filter((entry): entry is string => !!entry);
  return Array.from(new Set(raw.flatMap((entry) => entry
    .replace(/[^a-z0-9_/\s]+/g, " ")
    .split(/[\s_/]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3))));
}

function scoreDefinition(definition: WorkflowDefinition, input: WorkflowDefinitionResolutionInput, searchTerms: string[]): number {
  const scoring = objectValue(definition.policy.resolutionScoring);
  const numberScore = (key: string): number => {
    const value = scoring[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const statusScores = objectValue(scoring.statusScores);
  if (input.key && definition.key !== input.key) return 0;
  let score = 0;
  let exactMatch = false;
  if (input.key && definition.key === input.key) {
    score += numberScore("exactKey");
    exactMatch = true;
  }
  if (input.intent && definition.intent === input.intent) score += numberScore("exactIntent");
  if (input.intent && definition.intent === input.intent) exactMatch = true;
  if (input.platform && definition.platform === input.platform) score += numberScore("platform");

  const haystack = [
    definition.key,
    definition.intent,
    definition.title,
    definition.goal,
    definition.allowedTools.join(" "),
    definition.requiredCapabilities.join(" "),
  ].join(" ").toLowerCase();
  const termMatches = searchTerms.filter((term) => haystack.includes(term)).length;
  if (!exactMatch && termMatches === 0) return 0;
  score += termMatches * numberScore("termMatch");
  const configuredStatusScore = statusScores[definition.status];
  if (typeof configuredStatusScore === "number" && Number.isFinite(configuredStatusScore)) {
    score += configuredStatusScore;
  }
  if (exactMatch && score <= 0) score = 1;
  return score;
}

function gateSummary(policyGates: CompilerPolicyGate[]): JsonObject {
  return {
    gates: policyGates.map((gate) => ({
      id: gate.id,
      category: gate.category,
      state: gate.state,
      risk: gate.risk,
      owner: gate.owner,
      safeToAutoApply: gate.remediation.safeToAutoApply,
      version: gate.version ?? 1,
      stateCapabilities: gate.stateCapabilities,
    })),
    total: policyGates.length,
    blocked: policyGates.filter((gate) =>
      gate.stateCapabilities?.dispatchable !== true
    ).length,
    highRisk: policyGates.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: policyGates.filter((gate) => gate.remediation.safeToAutoApply === true).length,
  };
}

function gateEnabled(policyGates: CompilerPolicyGate[], id: string): boolean {
  return policyGates.find((gate) => gate.id === id)
    ?.stateCapabilities?.dispatchable === true;
}

function scopeMatches(requestedScope: string | undefined, promotionScope: string | null): boolean {
  if (!promotionScope) return false;
  if (!requestedScope) return false;
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
  const policy = input.definition?.policy ?? {};
  const requiredGateIds = stringArray(policy.requiredGateIds);
  const gates = Object.fromEntries(requiredGateIds.map((id) => [id, gateEnabled(input.policyGates, id)]));
  if (!input.definition) blockers.push("workflow_definition_not_found");
  if (input.definition && requiredGateIds.length === 0) blockers.push("required_policy_gates_not_configured");
  for (const gateId of requiredGateIds) {
    if (!gates[gateId]) blockers.push(`policy_gate_disabled:${gateId}`);
  }
  if (input.definition) {
    const allowedStatuses = stringArray(policy.allowedStatuses);
    const allowedPromotionStates = stringArray(policy.allowedPromotionStates);
    const minimumConfidence = policy.minimumPromotionConfidence;
    if (allowedStatuses.length === 0) blockers.push("allowed_statuses_not_configured");
    else if (!allowedStatuses.includes(input.definition.status)) blockers.push("workflow_definition_status_not_allowed");
    if (allowedPromotionStates.length === 0) blockers.push("allowed_promotion_states_not_configured");
    else if (!allowedPromotionStates.includes(input.definition.promotion.state)) blockers.push("workflow_definition_promotion_state_not_allowed");
    if (policy.reusable !== true) blockers.push("workflow_definition_not_reusable");
    if (policy.compilerVisible !== true) blockers.push("workflow_definition_not_compiler_visible");
    if (policy.autoUseEnabled !== true) blockers.push("workflow_definition_auto_use_disabled");
    if (policy.requireScopeMatch !== true) blockers.push("scope_policy_not_configured");
    else if (!scopeMatches(input.requestedScope, input.definition.promotion.scope)) blockers.push("promotion_scope_mismatch");
    if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence)) {
      blockers.push("minimum_promotion_confidence_not_configured");
    } else if (Number(input.definition.promotion.confidence ?? 0) < minimumConfidence) {
      blockers.push("promotion_confidence_below_threshold");
    }
    if (input.definition.promotion.readiness.safeToAutoApply !== true) blockers.push("promotion_readiness_not_safe");
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  const mayUseDefinition = uniqueBlockers.length === 0;

  return {
    gates,
    requestedScope: input.requestedScope ?? null,
    scopeMatched: !!input.definition && scopeMatches(input.requestedScope, input.definition.promotion.scope),
    wouldUseDefinition: mayUseDefinition,
    wouldChangePlan: mayUseDefinition,
    wouldChangeWorkflowCache: mayUseDefinition,
    wouldExecuteWorkflow: mayUseDefinition,
    safeToAutoApply: mayUseDefinition,
    selectedDefinitionId: mayUseDefinition ? input.definition?.id ?? null : null,
    outcome: mayUseDefinition ? "auto_use_execution_allowed" : "blocked_by_policy",
    blockers: uniqueBlockers,
    notes: [
      mayUseDefinition
        ? "Controlled auto-use is enabled for this scoped definition."
        : "Controlled auto-use remains blocked until policy gates, scope, confidence, and readiness pass.",
      "Execution is still routed through generated_workflow task queue and existing runtime guards.",
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
    goal: input.goal ?? null,
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
    wouldChangeWorkflowCache: controlledDecision.wouldChangeWorkflowCache === true,
    wouldExecuteWorkflow: controlledDecision.wouldExecuteWorkflow === true,
    safeToAutoApply: controlledDecision.safeToAutoApply === true,
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
          reason: "Registry resolution does not rollback definitions.",
        }
      : {
          available: false,
          wouldRollback: false,
          reason: "No candidate definition matched the query.",
        },
    notes: [
      "Workflow Definition Registry is declarative and controlled by policy gates.",
      "When all gates pass, execution is allowed only through generated_workflow queueing and audited run records.",
    ],
  };
}

export function workflowDefinitionRegistryPolicy(): JsonObject {
  return registryPolicy();
}

export function workflowDefinitionScopeFor(definition: Pick<WorkflowDefinition, "key" | "version" | "platform" | "intent">): string {
  return `auto_use:test:${definition.platform}:${definition.intent}:v${definition.version}`;
}

export function workflowDefinitionToExecutableTemplate(definition: WorkflowDefinition): WorkflowTemplate | null {
  if (definition.key !== "device_unlock") return null;
  return {
    id: `workflow_definition_${definition.key}_v${definition.version}`,
    name: `${definition.title} auto-use`,
    platform: definition.platform,
    description: definition.description ?? definition.goal,
    version: `${definition.version}.0.0`,
    intent: definition.intent,
    safetyClass: "standard",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 1,
    recoveryPolicy: {
      autonomy: "bounded",
      maxAttemptsPerStep: 2,
      maxAttemptsPerWorkflow: 3,
      maxRecoveryActionsPerAttempt: 0,
      allowedRecoveryRequests: ["retry_current_step", "refresh_screen_state"],
      requireStateVerification: true,
      learnFromFailure: true,
    },
    steps: [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {}, timeoutMs: 10_000 },
      { id: "unlock_device", type: "action", action: "unlock", params: {}, timeoutMs: 15_000 },
      { id: "settle_device", type: "action", action: "wait_for_idle", params: { timeoutMs: 1_500 }, timeoutMs: 5_000 },
      { id: "capture_screen_state", type: "action", action: "ui_tree_dump", params: { outputVariable: "_finalUiTree" }, timeoutMs: 10_000 },
      { id: "device_ready", type: "checkpoint", reason: "Device unlock workflow completed and final UI state captured" },
    ],
  };
}
