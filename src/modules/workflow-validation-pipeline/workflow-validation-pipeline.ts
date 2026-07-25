import { CompilerPolicyGate } from "../compiler-policy-gates/compiler-policy-gates";
import { WorkflowDefinition } from "../workflow-definition-registry/workflow-definition-registry";

type JsonObject = Record<string, unknown>;

type StaticCheckGroup = "schema" | "policy" | "safety" | "coverage" | "rollback";
type StaticCheckSeverity = "error" | "warning" | "info";

interface StaticCheck {
  id: string;
  passed: boolean;
  severity: StaticCheckSeverity;
  evidence: string;
  group: StaticCheckGroup;
}

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function definitionSteps(definition: WorkflowDefinition): string[] {
  return stringArray(definition.definition.steps);
}

function terminalStates(definition: WorkflowDefinition): string[] {
  return stringArray(definition.definition.terminalStates);
}

function sideEffects(definition: WorkflowDefinition): string[] {
  return stringArray(definition.definition.sideEffects);
}

function checkResult(input: {
  id: string;
  passed: boolean;
  severity: StaticCheckSeverity;
  evidence: string;
  group: StaticCheckGroup;
}): StaticCheck {
  return input;
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
      stateCapabilities: gate.stateCapabilities,
    }));
  return {
    gates,
    total: gates.length,
    blocked: gates.filter((gate) =>
      gate.stateCapabilities?.dispatchable !== true &&
      gate.stateCapabilities?.manual !== true
    ).length,
    reviewReady: gates.filter((gate) =>
      gate.stateCapabilities?.manual === true &&
      gate.stateCapabilities?.dispatchable !== true
    ).length,
    enabled: gates.filter((gate) =>
      gate.stateCapabilities?.dispatchable === true
    ).length,
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
  const steps = definitionSteps(definition);
  const terminals = terminalStates(definition);
  const effects = sideEffects(definition);
  const policy = objectValue(definition.policy);
  const rollback = objectValue(definition.rollback);
  const hasExpectedFailure = terminals.includes("expected_failure") || definition.fallbackRules.some((rule) => rule.includes("expected_failure"));
  const hasFailurePath = hasExpectedFailure || terminals.includes("needs_review") || terminals.includes("quarantined");
  const allStepsNonempty = steps.length > 0 && steps.every((step) => /^[a-z0-9_.:-]+$/i.test(step));
  const observableSuccessCriteria = definition.successCriteria.filter((criterion) => {
    const value = String(criterion).toLowerCase();
    return /(classified|detected|visible|state|reports|reason|boolean|present|not visible|loaded|usable)/.test(value);
  });
  const checks = [
    checkResult({
      id: "definition_schema_present",
      passed: Object.keys(definition.definition).length > 0,
      severity: "error",
      group: "schema",
      evidence: "definition JSON exists",
    }),
    checkResult({
      id: "steps_declared",
      passed: allStepsNonempty,
      severity: "error",
      group: "schema",
      evidence: `${steps.length} declared steps`,
    }),
    checkResult({
      id: "terminal_states_declared",
      passed: terminals.includes("success") && terminals.length >= 2,
      severity: "error",
      group: "schema",
      evidence: `${terminals.length} terminal states`,
    }),
    checkResult({
      id: "success_criteria_declared",
      passed: arrayHasItems(definition.successCriteria),
      severity: "error",
      group: "schema",
      evidence: `${definition.successCriteria.length} success criteria`,
    }),
    checkResult({
      id: "observable_success_criteria",
      passed: observableSuccessCriteria.length === definition.successCriteria.length && definition.successCriteria.length > 0,
      severity: "warning",
      group: "coverage",
      evidence: `${observableSuccessCriteria.length}/${definition.successCriteria.length} criteria look directly observable`,
    }),
    checkResult({
      id: "allowed_tools_declared",
      passed: arrayHasItems(definition.allowedTools),
      severity: "error",
      group: "schema",
      evidence: `${definition.allowedTools.length} allowed tools`,
    }),
    checkResult({
      id: "required_capabilities_declared",
      passed: arrayHasItems(definition.requiredCapabilities),
      severity: "error",
      group: "schema",
      evidence: `${definition.requiredCapabilities.length} required capabilities`,
    }),
    checkResult({
      id: "constraints_declared",
      passed: arrayHasItems(definition.constraints),
      severity: "error",
      group: "policy",
      evidence: `${definition.constraints.length} constraints`,
    }),
    checkResult({
      id: "read_only_policy_declared",
      passed: policy.readOnly === true && policy.autoUseEnabled === false && policy.executionChanging === false && policy.workflowCacheChanging === false,
      severity: "error",
      group: "policy",
      evidence: "policy keeps compiler, execution, and cache changes disabled",
    }),
    checkResult({
      id: "side_effects_declared",
      passed: Array.isArray(definition.definition.sideEffects),
      severity: "error",
      group: "safety",
      evidence: `${effects.length} declared side effects`,
    }),
    checkResult({
      id: "fallback_rules_declared",
      passed: arrayHasItems(definition.fallbackRules),
      severity: "error",
      group: "coverage",
      evidence: `${definition.fallbackRules.length} fallback rules`,
    }),
    checkResult({
      id: "failure_path_declared",
      passed: hasFailurePath,
      severity: "error",
      group: "coverage",
      evidence: terminals.join(", ") || "no terminal states",
    }),
    checkResult({
      id: "rollback_or_compensation_declared",
      passed: Object.keys(rollback).length > 0,
      severity: "warning",
      group: "rollback",
      evidence: Object.keys(rollback).length > 0 ? "rollback metadata exists" : "rollback metadata missing",
    }),
  ];
  const errors = checks.filter((check) => check.severity === "error" && !check.passed);
  const warnings = checks.filter((check) => check.severity === "warning" && !check.passed);
  const blockers = checks
    .filter((check) => check.severity === "error" && !check.passed)
    .map((check) => `${check.id}_missing`);
  return {
    mode: "static_validation_read_only",
    valid: blockers.length === 0,
    checks,
    checkGroups: checks.reduce((groups, check) => ({
      ...groups,
      [String(check.group)]: {
        total: Number((groups[String(check.group)] as JsonObject | undefined)?.total ?? 0) + 1,
        passed: Number((groups[String(check.group)] as JsonObject | undefined)?.passed ?? 0) + (check.passed ? 1 : 0),
      },
    }), {} as JsonObject),
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    errors: errors.length,
    warnings: warnings.length,
    blockers,
    warningIds: warnings.map((check) => check.id),
    contract: {
      steps: steps.length,
      terminalStates: terminals.length,
      sideEffects: effects.length,
      observableSuccessCriteria: observableSuccessCriteria.length,
      allowedTools: definition.allowedTools.length,
      requiredCapabilities: definition.requiredCapabilities.length,
      fallbackRules: definition.fallbackRules.length,
    },
    notes: [
      "Static validation checks contract, policy, safety, coverage, and rollback declarations.",
      "Passing static validation does not promote or execute the workflow definition.",
    ],
  };
}

function buildDryRun(definition: WorkflowDefinition, staticValidation: JsonObject, policyGateSummary: JsonObject): JsonObject {
  const staticBlockers = Array.isArray(staticValidation.blockers) ? staticValidation.blockers : [];
  const steps = definitionSteps(definition);
  const terminals = terminalStates(definition);
  const fixtures = [
    {
      id: "happy_path",
      terminalState: terminals.includes("success") ? "success" : null,
      covered: terminals.includes("success") && steps.length > 0,
      assertions: [
        "all declared steps are visited in order",
        "success criteria are checked directly",
        "no workflow cache or execution state is changed",
      ],
    },
    {
      id: "expected_failure_path",
      terminalState: terminals.includes("expected_failure") ? "expected_failure" : null,
      covered: terminals.includes("expected_failure") && definition.fallbackRules.length > 0,
      assertions: [
        "known app/login/device failures are classified",
        "failure does not promote or cache the definition",
      ],
    },
    {
      id: "timeout_or_unavailable_path",
      terminalState: terminals.includes("needs_review") ? "needs_review" : (terminals.includes("quarantined") ? "quarantined" : null),
      covered: definition.fallbackRules.some((rule) => /(unavailable|offline|timeout|review)/i.test(rule)),
      assertions: [
        "missing dependency exits with a classified result",
        "retry behavior stays bounded",
      ],
    },
    {
      id: "partial_completion_path",
      terminalState: terminals.includes("needs_review") ? "needs_review" : null,
      covered: definition.fallbackRules.some((rule) => /(manual review|review|repeated failure|ui tree unavailable|account mismatch)/i.test(rule)),
      assertions: [
        "last-good boundary would be recorded",
        "partial result cannot promote the whole definition",
      ],
    },
  ];
  const coveredFixtures = fixtures.filter((fixture) => fixture.covered).length;
  const branchCoverage = {
    declaredBranches: Math.max(terminals.length, fixtures.length),
    coveredBranches: coveredFixtures,
    missingBranches: fixtures.filter((fixture) => !fixture.covered).map((fixture) => fixture.id),
    coveragePercent: Math.round((coveredFixtures / fixtures.length) * 100),
  };
  return {
    mode: "workflow_definition_dry_run_preview",
    definitionId: definition.id,
    key: definition.key,
    version: definition.version,
    fixtureMatrix: fixtures,
    branchCoverage,
    simulatedStepPlan: steps.map((step, index) => ({
      index,
      step,
      wouldExecute: false,
      assertions: [
        "preconditions would be checked",
        "postconditions would be checked",
      ],
    })),
    contractCoverage: {
      steps: steps.length,
      allowedTools: definition.allowedTools.length,
      requiredCapabilities: definition.requiredCapabilities.length,
      successCriteria: definition.successCriteria.length,
      constraints: definition.constraints.length,
      fallbackRules: definition.fallbackRules.length,
    },
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
      "smoke_run_required_before_promotion",
      "canary_required_before_reuse",
    ])),
    policyGateSummary,
    notes: [
      "Dry-run preview is deterministic and explanatory only.",
      "No workflow cache, generated plan, or execution path is changed.",
    ],
  };
}

function readiness(kind: "smoke" | "canary" | "regression", definition: WorkflowDefinition, staticValidation: JsonObject, dryRun: JsonObject): JsonObject {
  const labels = {
    smoke: "smoke_run_not_recorded",
    canary: "canary_not_enabled",
    regression: "regression_suite_not_recorded",
  };
  const staticPassed = staticValidation.valid === true;
  const coveragePercent = Number((objectValue(dryRun.branchCoverage).coveragePercent) ?? 0);
  const commonCriteria = [
    { id: "static_validation_passed", passed: staticPassed },
    { id: "dry_run_branch_coverage_declared", passed: coveragePercent >= 50 },
    { id: "success_criteria_declared", passed: definition.successCriteria.length > 0 },
  ];
  const criteriaByKind = {
    smoke: [
      ...commonCriteria,
      { id: "synthetic_fixture_required", passed: false },
      { id: "cleanup_or_rollback_plan_checked", passed: Object.keys(definition.rollback).length > 0 },
    ],
    canary: [
      ...commonCriteria,
      { id: "manual_promotion_policy_required", passed: false },
      { id: "limited_scope_required", passed: definition.constraints.some((constraint) => /scope|limited/i.test(constraint)) },
      { id: "telemetry_baseline_required", passed: false },
    ],
    regression: [
      ...commonCriteria,
      { id: "golden_corpus_required", passed: false },
      { id: "negative_corpus_required", passed: false },
      { id: "dependency_change_revalidation_required", passed: true },
    ],
  }[kind];
  const passed = criteriaByKind.filter((criterion) => criterion.passed).length;
  return {
    mode: `${kind}_readiness_read_only`,
    state: "blocked",
    ready: false,
    score: Math.round((passed / criteriaByKind.length) * 100),
    criteria: criteriaByKind,
    blockers: [
      labels[kind],
      "manual_review_required",
      "workflow_validation_pipeline_read_only",
    ],
    evidenceRequired: {
      smoke: [
        "synthetic tenant run",
        "classified happy path and one expected failure",
        "cleanup or rollback evidence",
      ],
      canary: [
        "manual promotion approval",
        "limited scope and rollback window",
        "telemetry baseline",
      ],
      regression: [
        "golden definitions corpus",
        "negative/quarantined corpus",
        "fixture replay after schema, executor, or dependency changes",
      ],
    }[kind],
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
  const staticErrors = Number(input.staticValidation.errors ?? 0);
  const staticWarnings = Number(input.staticValidation.warnings ?? 0);
  const coveragePercent = Number(objectValue(input.dryRun.branchCoverage).coveragePercent ?? 0);
  const validationScore = Math.max(0, Math.min(100, 40 - (staticErrors * 20) - (staticWarnings * 5) + Math.round(coveragePercent * 0.35)));
  return {
    outcome: "blocked_by_policy",
    validationScore,
    promotionReadiness: "not_ready",
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
    requiredEvidence: [
      "static validation without error blockers",
      "dry-run fixture coverage for happy, expected failure, timeout, and partial paths",
      "smoke run with synthetic data",
      "canary scope and rollback plan",
      "regression corpus with golden and negative cases",
    ],
    nextActions: [
      "add or tighten missing success/failure declarations",
      "record dry-run fixtures for every declared branch",
      "build regression corpus before any manual promotion",
    ],
    notes: [
      "Validation Pipeline is read-only.",
      "Definitions require explicit promotion policy before compiler or execution use.",
    ],
  };
}

function buildItem(definition: WorkflowDefinition, policyGateSummary: JsonObject): JsonObject {
  const staticValidation = buildStaticValidation(definition);
  const dryRun = buildDryRun(definition, staticValidation, policyGateSummary);
  const smokeReadiness = readiness("smoke", definition, staticValidation, dryRun);
  const canaryReadiness = readiness("canary", definition, staticValidation, dryRun);
  const regressionReadiness = readiness("regression", definition, staticValidation, dryRun);
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
  const passedStatic = items.filter((item) =>
    (item.staticValidation as JsonObject).valid === true
  ).length;
  const staticWarnings = items.reduce((total, item) => total + Number((item.staticValidation as JsonObject).warnings ?? 0), 0);
  const dryRunFixtures = items.reduce((total, item) => {
    const matrix = (item.dryRun as JsonObject).fixtureMatrix;
    return total + (Array.isArray(matrix) ? matrix.length : 0);
  }, 0);
  const coveredBranches = items.reduce((total, item) => total + Number(objectValue((item.dryRun as JsonObject).branchCoverage).coveredBranches ?? 0), 0);
  const declaredBranches = items.reduce((total, item) => total + Number(objectValue((item.dryRun as JsonObject).branchCoverage).declaredBranches ?? 0), 0);
  const averageValidationScore = items.length === 0
    ? 0
    : Math.round(items.reduce((total, item) => total + Number((item.decision as JsonObject).validationScore ?? 0), 0) / items.length);
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
      staticWarnings,
      dryRunBlocked: items.length,
      dryRunFixtures,
      branchCoveragePercent: declaredBranches > 0 ? Math.round((coveredBranches / declaredBranches) * 100) : 0,
      averageValidationScore,
      smokeReady: 0,
      canaryReady: 0,
      regressionReady: 0,
      readinessBlocked: items.length * 3,
      wouldPromoteDefinition: 0,
      wouldUseDefinition: 0,
      wouldExecuteWorkflow: 0,
      safeToAutoApply: 0,
    },
    guardrails: [
      "Validation Pipeline is read-only.",
      "Static validation, fixture dry-runs, and readiness scoring never promote definitions.",
      "Workflow cache and execution path remain unchanged.",
      "Smoke, canary, and regression readiness remain blocked until explicit policy changes.",
    ],
  };
}

export function workflowValidationPipelinePolicy(): JsonObject {
  return validationPolicy();
}
