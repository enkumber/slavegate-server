export type CompilerKnowledgeType =
  | "rule"
  | "positive_example"
  | "negative_example"
  | "anti_pattern"
  | "app_map_hint"
  | "success_criteria"
  | "repair_note";

export type CompilerKnowledgeRisk = "low" | "medium" | "high";

export interface CompilerKnowledgeEntry {
  id: string;
  title: string;
  type: CompilerKnowledgeType;
  domain: "workflow_lifecycle" | "step_library" | "tool_selection" | "app_navigation" | "safety" | "recovery";
  appliesTo: string[];
  summary: string;
  guidance: string[];
  risk: CompilerKnowledgeRisk;
  source: "product_decision" | "qa_guardrail" | "live_incident" | "implementation_rule";
  status: "active";
  policy: {
    readOnly: true;
    compilerVisible: false;
    autoUseEnabled: false;
    executionChanging: false;
  };
  evidence: {
    required: string[];
    examples: string[];
  };
  notes: string[];
}

const policy = (): CompilerKnowledgeEntry["policy"] => ({
  readOnly: true,
  compilerVisible: false,
  autoUseEnabled: false,
  executionChanging: false,
});

export const COMPILER_KNOWLEDGE_BASE: CompilerKnowledgeEntry[] = [
  {
    id: "workflow-failure-never-promotes",
    title: "Failed workflow artifacts are not reusable truth",
    type: "rule",
    domain: "workflow_lifecycle",
    appliesTo: ["generated_workflow_plan_cache", "human_workflow_compile_jobs", "agency_workflow_runs"],
    summary: "A failed or candidate workflow can be retained for diagnostics, but normal cache lookup may only serve promoted artifacts.",
    guidance: [
      "Treat generated workflows as candidate until explicitly promoted.",
      "Keep failed artifacts out of normal execution/cache lookup.",
      "Use quarantine/review paths for debugging instead of purging evidence silently.",
    ],
    risk: "high",
    source: "product_decision",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["artifact_state", "run_status", "promotion_state"],
      examples: ["candidate", "promoted", "failed", "quarantined"],
    },
    notes: ["Phase 1A enforces promoted-only cache lookup; this entry documents the compiler rule only."],
  },
  {
    id: "partial-feedback-creates-step-candidates-only",
    title: "Partial feedback nominates step candidates only",
    type: "rule",
    domain: "step_library",
    appliesTo: ["workflow_run_feedback", "agency_workflow_step_candidates"],
    summary: "Partial success is useful evidence, but it must not promote reusable steps by itself.",
    guidance: [
      "Require lastGoodStepIndex for Partial feedback.",
      "Create step_candidate records for nominated steps.",
      "Require contract/evidence review before validated_step.",
    ],
    risk: "high",
    source: "qa_guardrail",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["lastGoodStepIndex", "step_snapshot", "source_run_status"],
      examples: ["dashboard_partial_feedback"],
    },
    notes: ["Prevents accidental step promotion from a lucky upstream/downstream context."],
  },
  {
    id: "validated-step-needs-contract",
    title: "Validated steps require a contract",
    type: "success_criteria",
    domain: "step_library",
    appliesTo: ["validated_step", "step_library"],
    summary: "A step is only validated when its own preconditions, postconditions, compatibility, and evidence are explicit.",
    guidance: [
      "Require preconditions and postconditions.",
      "Require direct evidence rather than downstream success as a proxy.",
      "Keep validated_step separate from automatic reuse eligibility.",
    ],
    risk: "medium",
    source: "qa_guardrail",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["validation_contract", "validation_evidence"],
      examples: ["preconditions", "postconditions", "compatibility.serverVersion"],
    },
    notes: ["Phase 3C validates contracts manually; compiler auto-use remains disabled."],
  },
  {
    id: "limited-reuse-scope-must-match",
    title: "Limited reuse must stay inside declared scope",
    type: "rule",
    domain: "safety",
    appliesTo: ["limited_reuse", "promotion_scope"],
    summary: "Limited reuse can only be considered when device/app/account/workflow context matches the declared scope.",
    guidance: [
      "Reject global/compiler/auto/all scopes in limited promotion.",
      "Treat revoked entries as non-reusable even if they remain validated.",
      "Do not infer broader compatibility from one successful run.",
    ],
    risk: "high",
    source: "implementation_rule",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["promotion_scope", "readiness_score", "promotion_event"],
      examples: ["device:<id>", "account:<id>", "app:<package>:<version>"],
    },
    notes: ["Phase 3F supports limited promotion/revoke; compiler still cannot auto-use entries."],
  },
  {
    id: "tool-catalog-policy-source",
    title: "Tool Catalog is policy source, not execution permission",
    type: "rule",
    domain: "tool_selection",
    appliesTo: ["tool_catalog", "workflow_compiler"],
    summary: "Tool metadata describes capabilities, side effects, and risk; it does not grant automatic execution.",
    guidance: [
      "Inspect input/output schemas before composing steps.",
      "Prefer observation tools before mutating input tools.",
      "Keep compilerVisible and autoUse disabled until explicit compiler policy exists.",
    ],
    risk: "medium",
    source: "implementation_rule",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["tool_id", "risk", "policy", "availability"],
      examples: ["ui_tree_dump before semantic_tap", "screenshot only when visual evidence is needed"],
    },
    notes: ["Phase 4A exposes the catalog read-only."],
  },
  {
    id: "login-wall-is-not-success",
    title: "Login walls and challenges are negative outcomes",
    type: "anti_pattern",
    domain: "app_navigation",
    appliesTo: ["screen_state", "health_scan", "navigation_workflows"],
    summary: "A workflow must not treat a loaded app shell, login wall, or challenge screen as successful business output.",
    guidance: [
      "Check semantic screen state, not just absence of exceptions.",
      "Classify login/challenge surfaces explicitly.",
      "Record negative examples for compiler repair instead of retrying the same path blindly.",
    ],
    risk: "medium",
    source: "live_incident",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["screen_state", "ui_tree", "business_result"],
      examples: ["loginWallDetected=false", "challengeDetected=false", "screenState=reddit_home_feed"],
    },
    notes: ["Captured from Reddit health-scan gates where UI tree output mattered."],
  },
  {
    id: "prefer-deterministic-observation",
    title: "Prefer deterministic observation before LLM/VLM recovery",
    type: "positive_example",
    domain: "recovery",
    appliesTo: ["ui_tree_dump", "get_screen_state", "classify_reddit_health_scan"],
    summary: "Use UI tree and screen-state classifiers on the happy path; reserve LLM/VLM for compile, recovery, or creative generation.",
    guidance: [
      "Use deterministic app maps and cached coordinates when verified.",
      "Capture UI tree before deciding a mutating repair step.",
      "Keep happy path token usage at zero whenever possible.",
    ],
    risk: "low",
    source: "product_decision",
    status: "active",
    policy: policy(),
    evidence: {
      required: ["token_usage", "screen_state", "classifier_output"],
      examples: ["0 LLM/VLM on reddit_account_health_scan happy path"],
    },
    notes: ["Aligns with Phone Network cost/latency strategy."],
  },
];

export function listCompilerKnowledge(filters: {
  type?: string;
  domain?: string;
  risk?: string;
  source?: string;
}): CompilerKnowledgeEntry[] {
  return COMPILER_KNOWLEDGE_BASE.filter((entry) => {
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.domain && entry.domain !== filters.domain) return false;
    if (filters.risk && entry.risk !== filters.risk) return false;
    if (filters.source && entry.source !== filters.source) return false;
    return true;
  });
}
