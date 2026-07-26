import { listCompilerKnowledge } from "../compiler-knowledge/compiler-knowledge-base";
import { listToolCatalog } from "../tool-catalog/tool-catalog";

export interface CompilerAwarenessStepRow {
  id: string;
  label?: string | null;
  action?: string | null;
  type?: string | null;
  candidate_state?: string | null;
  library_state?: string | null;
  candidate_reusable?: boolean | null;
  candidate_terminal?: boolean | null;
  library_reusable?: boolean | null;
  library_terminal?: boolean | null;
  promotion_scope?: string | null;
  validation_contract?: Record<string, unknown> | null;
  validation_evidence?: Record<string, unknown> | null;
  run_intent?: string | null;
  device_name?: string | null;
  validated_at?: Date | string | null;
}

export interface CompilerAwarenessInput {
  intent?: string;
  action?: string;
  steps?: CompilerAwarenessStepRow[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "cu",
  "de",
  "din",
  "do",
  "for",
  "in",
  "la",
  "of",
  "on",
  "pe",
  "sa",
  "să",
  "the",
  "to",
  "un",
  "with",
]);

function termsFor(input: string | undefined): string[] {
  if (!input) return [];
  const normalized = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const terms = normalized
    .split(/[^a-z0-9_]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  return Array.from(new Set(terms)).slice(0, 20);
}

function haystackFor(parts: unknown[]): string {
  return parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchingTerms(terms: string[], haystack: string): string[] {
  return terms.filter((term) => haystack.includes(term));
}

function hasMatch(terms: string[], haystack: string, fallback = false): boolean {
  return terms.length === 0 ? fallback : matchingTerms(terms, haystack).length > 0;
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function policyGatesForBlockers(blockers: string[]): Record<string, unknown>[] {
  void blockers;
  return [];
}

function policyGateId(gate: Record<string, unknown>): string | null {
  return typeof gate.id === "string" && gate.id.trim().length > 0 ? gate.id.trim() : null;
}

function collectPolicyGatesFromValue(value: unknown, out: Map<string, Record<string, unknown>>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPolicyGatesFromValue(item, out);
    return;
  }

  const object = value as Record<string, unknown>;
  const directGates = Array.isArray(object.policyGates) ? object.policyGates : [];
  for (const gate of directGates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
    const gateObject = gate as Record<string, unknown>;
    const id = policyGateId(gateObject);
    if (id && !out.has(id)) out.set(id, gateObject);
  }

  const decisionGates = Array.isArray(object.policyGateSummary) ? object.policyGateSummary : [];
  for (const gate of decisionGates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
    const gateObject = gate as Record<string, unknown>;
    const id = policyGateId(gateObject);
    if (id && !out.has(id)) out.set(id, gateObject);
  }

  for (const nested of Object.values(object)) {
    if (nested && typeof nested === "object") collectPolicyGatesFromValue(nested, out);
  }
}

function aggregatePolicyGateSummary(...values: unknown[]): Record<string, unknown> {
  const gatesById = new Map<string, Record<string, unknown>>();
  for (const value of values) collectPolicyGatesFromValue(value, gatesById);
  const gates = Array.from(gatesById.values()).map((gate) => ({
    id: gate.id,
    category: gate.category ?? null,
    state: gate.state ?? null,
    risk: gate.risk ?? null,
    owner: gate.owner ?? null,
    safeToAutoApply: gate.safeToAutoApply === true,
    stateCapabilities: gate.stateCapabilities ?? null,
  }));
  return {
    gates,
    total: gates.length,
    blocked: gates.filter((gate) => {
      const capabilities = gate.stateCapabilities
        && typeof gate.stateCapabilities === "object"
        && !Array.isArray(gate.stateCapabilities)
        ? gate.stateCapabilities as Record<string, unknown>
        : {};
      return capabilities.dispatchable !== true && capabilities.manual !== true;
    }).length,
    highRisk: gates.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: gates.filter((gate) => gate.safeToAutoApply === true).length,
  };
}

function remediationForBlockers(blockers: string[]): Record<string, unknown> {
  const uniqueBlockers = Array.from(new Set(blockers));
  const nextActions = uniqueBlockers.flatMap((blocker) => {
    switch (blocker) {
      case "tool_catalog_read_only":
        return ["Keep Tool Catalog as observability until compiler tool visibility policy is explicitly enabled."];
      case "knowledge_base_read_only":
        return ["Keep Knowledge Base as guidance until compiler knowledge application policy is explicitly enabled."];
      case "compiler_auto_use_disabled":
        return ["Do not auto-use candidates; enable compiler auto-use only through a later explicit policy gate."];
      case "limited_reuse_not_promoted":
        return ["Promote the validated step to limited_reuse for a declared scope before considering reuse."];
      case "step_library_entry_revoked":
        return ["Review the revoked Step Library entry and create a new validated candidate instead of reusing the revoked entry."];
      case "scope_not_declared":
        return ["Declare a narrow reuse scope such as device, user, account, app version, or session before reuse."];
      case "step_not_compiler_eligible":
        return ["Keep compilerEligible=false until compatibility, confidence, and policy gates are explicitly satisfied."];
      case "step_not_validated":
        return ["Validate the step with contract and evidence before it can become a Step Library candidate."];
      case "no_matching_validated_step":
        return ["Capture and validate a matching step candidate before expecting Step Library reuse."];
      default:
        return [`Review blocker ${blocker} before changing compiler behavior.`];
    }
  });
  const requiredPolicyChanges = uniqueBlockers.flatMap((blocker) => {
    switch (blocker) {
      case "tool_catalog_read_only":
        return ["compiler_tool_visibility"];
      case "knowledge_base_read_only":
        return ["compiler_knowledge_application"];
      case "compiler_auto_use_disabled":
        return ["compiler_auto_use"];
      case "step_not_compiler_eligible":
        return ["step_compiler_eligibility"];
      default:
        return [];
    }
  });

  return {
    state: "manual_review_required",
    nextActions: Array.from(new Set(nextActions)),
    requiredPolicyChanges: Array.from(new Set(requiredPolicyChanges)),
    safeToAutoApply: false,
  };
}

function eligibilityForTool(tool: { policy?: Record<string, unknown> }): Record<string, unknown> {
  const blockers = [
    "tool_catalog_read_only",
    "compiler_auto_use_disabled",
  ];
  return {
    state: "blocked",
    gates: {
      catalogDeclared: true,
      compilerVisible: tool.policy?.compilerVisible === true,
      autoUseEnabled: tool.policy?.autoUseEnabled === true,
      executionChangingAllowed: false,
    },
    blockers,
    policyGates: policyGatesForBlockers(blockers),
    remediation: remediationForBlockers(blockers),
    notes: [
      "Tool Catalog is visible for awareness only.",
      "Compiler cannot select tools until compiler visibility and auto-use policy are explicitly enabled.",
    ],
  };
}

function eligibilityForKnowledge(entry: { policy?: Record<string, unknown> }): Record<string, unknown> {
  const blockers = [
    "knowledge_base_read_only",
    "compiler_auto_use_disabled",
  ];
  return {
    state: "blocked",
    gates: {
      knowledgeDeclared: true,
      compilerVisible: entry.policy?.compilerVisible === true,
      autoUseEnabled: entry.policy?.autoUseEnabled === true,
      executionChangingAllowed: false,
    },
    blockers,
    policyGates: policyGatesForBlockers(blockers),
    remediation: remediationForBlockers(blockers),
    notes: [
      "Knowledge Base entries are guidance only in this phase.",
      "Compiler cannot apply knowledge until a later explicit policy enables it.",
    ],
  };
}

function eligibilityForStep(step: CompilerAwarenessStepRow): Record<string, unknown> {
  const promotedForLimitedReuse =
    step.library_reusable === true &&
    typeof step.promotion_scope === "string" &&
    step.promotion_scope.trim().length > 0;
  const gates = {
    validatedStep: step.candidate_reusable === true,
    limitedReusePromoted: promotedForLimitedReuse,
    notRevoked: step.library_terminal !== true,
    scopedReuseDeclared: typeof step.promotion_scope === "string" && step.promotion_scope.trim().length > 0,
    compilerEligiblePolicy: false,
    autoUseEnabled: false,
  };
  const blockers: string[] = ["compiler_auto_use_disabled"];
  if (!gates.validatedStep) blockers.push("step_not_validated");
  if (!gates.limitedReusePromoted) blockers.push("limited_reuse_not_promoted");
  if (!gates.notRevoked) blockers.push("step_library_entry_revoked");
  if (!gates.scopedReuseDeclared) blockers.push("scope_not_declared");
  if (!gates.compilerEligiblePolicy) blockers.push("step_not_compiler_eligible");

  const uniqueBlockers = Array.from(new Set(blockers));

  return {
    state: "blocked",
    gates,
    blockers: uniqueBlockers,
    policyGates: policyGatesForBlockers(uniqueBlockers),
    remediation: remediationForBlockers(blockers),
    notes: [
      "Step Library candidate is evaluated for awareness only.",
      "No Step Library execution can be selected while compiler auto-use is disabled.",
    ],
  };
}

function decisionFor(input: {
  toolCandidates: Array<Record<string, unknown>>;
  stepCandidates: Array<Record<string, unknown>>;
  knowledgeCandidates: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const blockers = ["compiler_auto_use_disabled"];
  if (input.stepCandidates.some((step) => step.libraryTerminal === true)) {
    blockers.push("step_library_entry_revoked");
  }
  if (input.stepCandidates.some((step) => step.compilerEligible === false)) {
    blockers.push("step_not_compiler_eligible");
  }
  if (input.stepCandidates.length === 0) {
    blockers.push("no_matching_validated_step");
  }
  const uniqueBlockers = Array.from(new Set(blockers));

  return {
    outcome: "blocked_by_policy",
    wouldChangePlan: false,
    wouldExecuteStepLibrary: false,
    selectedStepIds: [],
    selectedToolIds: [],
    blockers: uniqueBlockers,
    policyGateSummary: policyGatesForBlockers(uniqueBlockers),
    remediation: remediationForBlockers(uniqueBlockers),
    notes: [
      "Awareness is observability-only.",
      "Compiler auto-use remains disabled.",
      "No workflow plan, cache, or execution path is changed.",
    ],
  };
}

export async function buildCompilerAwareness(input: CompilerAwarenessInput = {}): Promise<Record<string, unknown>> {
  const terms = termsFor([input.intent, input.action].filter(Boolean).join(" "));
  const action = input.action?.trim();
  const [tools, knowledge] = await Promise.all([
    listToolCatalog({}),
    listCompilerKnowledge({}),
  ]);

  const toolCandidates = tools.filter((tool) => {
    const haystack = haystackFor([
      tool.id,
      tool.name,
      tool.category,
      tool.description,
      tool.sideEffects,
      tool.inputSchema.required,
      tool.inputSchema.optional,
      tool.outputSchema.produces,
      tool.notes,
    ]);
    return action ? tool.id === action || tool.name.toLowerCase() === action.toLowerCase() : hasMatch(terms, haystack, true);
  }).slice(0, 12).map((tool) => ({
    id: tool.id,
    name: tool.name,
    category: tool.category,
    source: tool.source,
    risk: tool.risk,
    matchedTerms: matchingTerms(terms, haystackFor([tool.id, tool.name, tool.description, tool.notes])),
    policy: tool.policy,
    eligibility: eligibilityForTool(tool),
    wouldUse: false,
    reason: "read_only_awareness_only",
  }));

  const knowledgeCandidates = knowledge.filter((entry) => {
    const haystack = haystackFor([
      entry.id,
      entry.title,
      entry.type,
      entry.domain,
      entry.appliesTo,
      entry.summary,
      entry.guidance,
      entry.notes,
    ]);
    return hasMatch(terms, haystack, true);
  }).slice(0, 12).map((entry) => ({
    id: entry.id,
    title: entry.title,
    type: entry.type,
    domain: entry.domain,
    risk: entry.risk,
    source: entry.source,
    matchedTerms: matchingTerms(terms, haystackFor([entry.id, entry.title, entry.summary, entry.guidance])),
    policy: entry.policy,
    eligibility: eligibilityForKnowledge(entry),
    wouldApply: false,
    reason: "read_only_awareness_only",
  }));

  const stepCandidates = (input.steps ?? []).filter((step) => {
    const haystack = haystackFor([
      step.id,
      step.label,
      step.action,
      step.type,
      step.library_state,
      step.promotion_scope,
      step.run_intent,
      objectKeys(step.validation_contract),
      objectKeys(step.validation_evidence),
    ]);
    return action ? step.action === action : hasMatch(terms, haystack, true);
  }).slice(0, 12).map((step) => ({
    id: step.id,
    name: step.label ?? step.action ?? step.id,
    action: step.action ?? null,
    type: step.type ?? null,
    status: step.candidate_state ?? null,
    libraryState: step.library_state ?? null,
    libraryTerminal: step.library_terminal === true,
    reusable: step.library_reusable === true,
    promotionScope: step.promotion_scope ?? null,
    runIntent: step.run_intent ?? null,
    deviceName: step.device_name ?? null,
    validatedAt: step.validated_at instanceof Date ? step.validated_at.toISOString() : step.validated_at ?? null,
    matchedTerms: matchingTerms(terms, haystackFor([step.id, step.label, step.action, step.type, step.run_intent])),
    compilerEligible: false,
    eligibility: eligibilityForStep(step),
    wouldUse: false,
    reason: "compiler_auto_use_disabled",
  }));
  const decision = decisionFor({ toolCandidates, stepCandidates, knowledgeCandidates });
  const policyGateSummary = aggregatePolicyGateSummary(
    toolCandidates,
    stepCandidates,
    knowledgeCandidates,
    decision
  );

  return {
    intent: input.intent ?? null,
    terms,
    policy: {
      readOnly: true,
      compilerVisible: false,
      autoUseEnabled: false,
      executionChanging: false,
      mode: "read_only_compiler_awareness",
    },
    summary: {
      toolCandidates: toolCandidates.length,
      stepCandidates: stepCandidates.length,
      knowledgeCandidates: knowledgeCandidates.length,
    },
    candidates: {
      tools: toolCandidates,
      steps: stepCandidates,
      knowledge: knowledgeCandidates,
    },
    decision,
    policyGateSummary,
    guardrails: [
      "No compiler plan changes are made from awareness data.",
      "Step Library entries are not auto-used by compiler in this phase.",
      "Tool Catalog and Knowledge Base remain policy/observability sources only.",
    ],
  };
}
