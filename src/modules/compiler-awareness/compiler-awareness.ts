import { listCompilerKnowledge } from "../compiler-knowledge/compiler-knowledge-base";
import { listToolCatalog } from "../tool-catalog/tool-catalog";

export interface CompilerAwarenessStepRow {
  id: string;
  label?: string | null;
  action?: string | null;
  type?: string | null;
  candidate_state?: string | null;
  library_state?: string | null;
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

function decisionFor(input: {
  toolCandidates: Array<Record<string, unknown>>;
  stepCandidates: Array<Record<string, unknown>>;
  knowledgeCandidates: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const blockers = ["compiler_auto_use_disabled"];
  if (input.stepCandidates.some((step) => step.libraryState === "revoked")) {
    blockers.push("step_library_entry_revoked");
  }
  if (input.stepCandidates.some((step) => step.compilerEligible === false)) {
    blockers.push("step_not_compiler_eligible");
  }
  if (input.stepCandidates.length === 0) {
    blockers.push("no_matching_validated_step");
  }

  return {
    outcome: "blocked_by_policy",
    wouldChangePlan: false,
    wouldExecuteStepLibrary: false,
    selectedStepIds: [],
    selectedToolIds: [],
    blockers: Array.from(new Set(blockers)),
    notes: [
      "Awareness is observability-only.",
      "Compiler auto-use remains disabled.",
      "No workflow plan, cache, or execution path is changed.",
    ],
  };
}

export function buildCompilerAwareness(input: CompilerAwarenessInput = {}): Record<string, unknown> {
  const terms = termsFor([input.intent, input.action].filter(Boolean).join(" "));
  const action = input.action?.trim();

  const toolCandidates = listToolCatalog({}).filter((tool) => {
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
    wouldUse: false,
    reason: "read_only_awareness_only",
  }));

  const knowledgeCandidates = listCompilerKnowledge({}).filter((entry) => {
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
    status: step.candidate_state ?? "validated_step",
    libraryState: step.library_state ?? "review_only",
    promotionScope: step.promotion_scope ?? null,
    runIntent: step.run_intent ?? null,
    deviceName: step.device_name ?? null,
    validatedAt: step.validated_at instanceof Date ? step.validated_at.toISOString() : step.validated_at ?? null,
    matchedTerms: matchingTerms(terms, haystackFor([step.id, step.label, step.action, step.type, step.run_intent])),
    compilerEligible: false,
    wouldUse: false,
    reason: "compiler_auto_use_disabled",
  }));
  const decision = decisionFor({ toolCandidates, stepCandidates, knowledgeCandidates });

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
    guardrails: [
      "No compiler plan changes are made from awareness data.",
      "Step Library entries are not auto-used by compiler in this phase.",
      "Tool Catalog and Knowledge Base remain policy/observability sources only.",
    ],
  };
}
