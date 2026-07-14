import { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";
import { WorkflowDefinition } from "../workflow-definition-registry/workflow-definition-registry";

type JsonObject = Record<string, unknown>;

export interface WorkflowValidationPipelineInput {
  definitions: WorkflowDefinition[];
  policyGates: CompilerPolicyGate[];
  intent?: string;
  platform?: string;
  key?: string;
}

function arrayHasItems(value: unknown[]): boolean {
  return Array.isArray(value) && value.length > 0;
}

function gateSummary(policyGates: CompilerPolicyGate[]): JsonObject {
  const gateIds = new Set([
    "compiler_knowledge_application",
    "limited_reuse_scope_match",
    "compiler_auto_use",
    "execution_path_change",
  ]);
  const gates = policyGates
    .filter((gate) => gateIds.has(gate.id))
    .map((gate) => ({
      id: gate.id,
      category: gate.category,
      state: gate.state,
      risk: gate.risk,
      owner: gate.owner,
      safeToAutoApply: gate.remediation.safeToAutoApply,
      version: gate.version ?? 1,
    }));
  return {
    gates,
    total: gates.length,
    blocked: gates.filter((gate) => gate.state === "blocked").length,
    reviewReady: gates.filter((gate) => gate.state === "review_ready").length,
    enabled: gates.filter((gate) => gate.state === "enabled").length,
    highRisk: gates.filter((gate) => gate.risk === "high").length,
    safeToAutoApply: 0,
  };
}

function validationPolicy(): JsonObject {
  return {
    readOnly: true,
    validationOnly: true,
    autoPromotionEnabled: false,
    compilerVisible: false,
    autoUseEnabled: false,
    executionChanging: false,
    workflowCacheChanging: false,
    mode: "workflow_validation_pipeline_read_only",
  };
}

function buildStaticValidation(definition: WorkflowDefinition): JsonObject {
  const checks = [
    {
      id: "definition_schema_present",
      passed: Object.keys(definition.definition).length > 0,
      evidence: "definition JSON exists",
    },
    {
      id: "success_criteria_declared",
      passed: arrayHasItems(definition.successCriteria),
      evidence: `${definition.successCriteria.length} success criteria`,
    },
    {
      id: "allowed_tools_declared",
      passed: arrayHasItems(definition.allowedTools),
      evidence: `${definition.allowedTools.length} allowed tools`,
    },
    {
      id: "required_capabilities_declared",
      passed: arrayHasItems(definition.requiredCapabilities),
      evidence: `${definition.requiredCapabilities.length} required capabilities`,
    },
    {
      id: "constraints_declared",
      passed: arrayHasItems(definition.constraints),
      evidence: `${definition.constraints.length} constraints`,
    },
    {
      id: "fallback_rules_declared",
      passed: arrayHasItems(definition.fallbackRules),
      evidence: `${definition.fallbackRules.length} fallback rules`,
    },
  ];
  const blockers = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.id}_missing`);
  return {
    mode: "static_validation_read_only",
    state: blockers.length === 0 ? "passed" : "blocked",
    checks,
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    blockers,
    notes: [
      "Static validation checks declaration completeness only.",
      "Passing static validation does not promote or execute the workflow definition.",
    ],
  };
}

function buildDryRun(definition: WorkflowDefinition, staticValidation: JsonObject, policyGateSummary: JsonObject): JsonObject {
  const staticBlockers = Array.isArray(staticValidation.blockers) ? staticValidation.blockers : [];
  return {
    mode: "workflow_definition_dry_run_preview",
    definitionId: definition.id,
    key: definition.key,
    version: definition.version,
    wouldUseDefinition: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    wouldExecuteWorkflow: false,
    selectedDefinitionId: null,
    outcome: "blocked_by_policy",
    blockers: Array.from(new Set([
      ...staticBlockers.map(String),
      "workflow_validation_pipeline_read_only",
      "compiler_auto_use_disabled",
      "execution_changing_disabled",
    ])),
    policyGateSummary,
    notes: [
      "Dry-run preview is explanatory only.",
      "No workflow cache, generated plan, or execution path is changed.",
    ],
  };
}

function readiness(kind: "smoke" | "canary" | "regression"): JsonObject {
  const labels = {
    smoke: "smoke_run_not_recorded",
    canary: "canary_not_enabled",
    regression: "regression_suite_not_recorded",
  };
  return {
    mode: `${kind}_readiness_read_only`,
    state: "blocked",
    ready: false,
    blockers: [
      labels[kind],
      "manual_review_required",
      "workflow_validation_pipeline_read_only",
    ],
    notes: [
      `${kind} readiness is not an execution gate yet.`,
      "This preview records what would be required before promotion.",
    ],
  };
}

function buildDecision(input: {
  definition: WorkflowDefinition;
  staticValidation: JsonObject;
  dryRun: JsonObject;
  policyGateSummary: JsonObject;
}): JsonObject {
  const staticBlockers = Array.isArray(input.staticValidation.blockers) ? input.staticValidation.blockers : [];
  const dryRunBlockers = Array.isArray(input.dryRun.blockers) ? input.dryRun.blockers : [];
  return {
    outcome: "blocked_by_policy",
    wouldPromoteDefinition: false,
    wouldUseDefinition: false,
    wouldExecuteWorkflow: false,
    wouldChangePlan: false,
    wouldChangeWorkflowCache: false,
    safeToAutoApply: false,
    selectedDefinitionId: null,
    blockers: Array.from(new Set([
      ...staticBlockers.map(String),
      ...dryRunBlockers.map(String),
      "smoke_not_run",
      "canary_not_enabled",
      "regression_suite_not_run",
    ])),
    policyGateSummary: input.policyGateSummary,
    notes: [
      "Validation Pipeline is read-only.",
      "Definitions require explicit promotion policy before compiler or execution use.",
    ],
  };
}

function buildItem(definition: WorkflowDefinition, policyGateSummary: JsonObject): JsonObject {
  const staticValidation = buildStaticValidation(definition);
  const dryRun = buildDryRun(definition, staticValidation, policyGateSummary);
  const smokeReadiness = readiness("smoke");
  const canaryReadiness = readiness("canary");
  const regressionReadiness = readiness("regression");
  const decision = buildDecision({ definition, staticValidation, dryRun, policyGateSummary });
  return {
    definition,
    staticValidation,
    dryRun,
    smokeReadiness,
    canaryReadiness,
    regressionReadiness,
    decision,
  };
}

export function buildWorkflowValidationPipeline(input: WorkflowValidationPipelineInput): JsonObject {
  const policyGateSummary = gateSummary(input.policyGates);
  const items = input.definitions.map((definition) => buildItem(definition, policyGateSummary));
  const passedStatic = items.filter((item) => (item.staticValidation as JsonObject).state === "passed").length;
  return {
    intent: input.intent ?? null,
    platform: input.platform ?? null,
    key: input.key ?? null,
    policy: validationPolicy(),
    policyGateSummary,
    items,
    summary: {
      definitions: items.length,
      staticPassed: passedStatic,
      staticBlocked: items.length - passedStatic,
      dryRunBlocked: items.length,
      smokeReady: 0,
      canaryReady: 0,
      regressionReady: 0,
      wouldPromoteDefinition: 0,
      wouldUseDefinition: 0,
      wouldExecuteWorkflow: 0,
      safeToAutoApply: 0,
    },
    guardrails: [
      "Validation Pipeline is read-only.",
      "Static and dry-run checks never promote definitions.",
      "Workflow cache and execution path remain unchanged.",
      "Smoke, canary, and regression readiness remain blocked until explicit policy changes.",
    ],
  };
}

export function workflowValidationPipelinePolicy(): JsonObject {
  return validationPolicy();
}
