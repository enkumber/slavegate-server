/**
 * workflow-validator.ts
 * Zod schema + semantic validation for dynamic workflow dispatch.
 */

import { z } from "zod";
import { createHash } from "crypto";
import type { AppMap, AppMapQualityReport } from "../app-mapping/schema";
import type {
  WorkflowGoalContract,
  WorkflowInteractionEffect,
  WorkflowOutputSchema,
  WorkflowRecoveryPolicy,
  WorkflowStep,
  WorkflowTemplate,
} from "./types";
import { parseWorkflowGoalContract, workflowGoalContractReason } from "./goal-contract";

// ── Allowed step types ──────────────────────────────────────────────────────
const ALLOWED_STEP_TYPES = [
  "screen_wake",
  "unlock",
  "open_app",
  "cascade_tap",
  "tap",
  "wait",
  "decide",
  "check_screen",
] as const;

// ── Blocked packages for open_app (security) ────────────────────────────────
const BLOCKED_PACKAGES = [
  "com.android.settings",
  "com.android.providers.settings",
  "com.android.packageinstaller",
  "com.android.vending",           // Play Store
  "com.android.shell",             // ADB shell
  "com.termux",                    // Terminal access
  "com.noshufou.android.su",       // SuperSU
  "eu.chainfire.supersu",          // SuperSU
  "com.topjohnwu.magisk",          // Magisk root
  "com.google.android.apps.wallet", // Google Wallet
  "com.squareup.pos",              // Square POS
  "com.paypal.android.p2pmobile",  // PayPal
  "com.banking",
];

// ── Zod schemas ─────────────────────────────────────────────────────────────
const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(ALLOWED_STEP_TYPES),
  package: z.string().optional(),
  target: z.string().optional(),
  element: z.string().optional(),
  check: z.string().optional(),
  context: z.record(z.any()).optional(),
  requires: z.array(z.string()).optional(),
  delay_after: z.number().min(1).max(60000).optional(),
  optional: z.boolean().optional(),
});

export const WorkflowDispatchSchema = z.object({
  deviceId: z.string().min(1),
  timeoutMs: z.number().min(1000).max(600000).default(300000),
  workflow: z.object({
    name: z.string().min(1).max(128),
    steps: z.array(WorkflowStepSchema).min(1).max(50),
  }),
});

export type WorkflowDispatchInput = z.infer<typeof WorkflowDispatchSchema>;

// ── Validation result ───────────────────────────────────────────────────────
// ValidationResult moved below — see end of file

// ── Semantic validators ─────────────────────────────────────────────────────

function validateOpenAppPackages(steps: { type: string; package?: string }[]): string[] {
  const errors: string[] = [];
  for (const step of steps) {
    if (step.type === "open_app" && step.package) {
      if (BLOCKED_PACKAGES.some((bp) => step.package!.toLowerCase().includes(bp))) {
        errors.push(`Step with open_app blocked package: ${step.package}`);
      }
    }
  }
  return errors;
}

function isBlockedPackage(packageName: string): boolean {
  const normalized = packageName.toLowerCase();
  return BLOCKED_PACKAGES.some((blocked) => normalized.includes(blocked));
}

function validateWaitSteps(steps: { type: string; delay_after?: number }[]): string[] {
  const errors: string[] = [];
  for (const step of steps) {
    if (step.type === "wait" && step.delay_after !== undefined && step.delay_after <= 0) {
      errors.push(`Step "${step.type}" has invalid delay_after: must be > 0`);
    }
  }
  return errors;
}

/**
 * Detect cycles in the `requires` dependency graph via topological sort (Kahn's algorithm).
 * Returns an array of error messages (empty if no cycles).
 */
function detectCycles(steps: { id: string; requires?: string[] }[]): string[] {
  const errors: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  const adj = new Map<string, string[]>(); // id → ids that depend on it
  const inDegree = new Map<string, number>();

  for (const s of steps) {
    adj.set(s.id, []);
    inDegree.set(s.id, 0);
  }

  for (const s of steps) {
    for (const req of s.requires ?? []) {
      if (!stepIds.has(req)) {
        errors.push(`Step "${s.id}" requires unknown step "${req}"`);
        continue;
      }
      adj.get(req)!.push(s.id);
      inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const dep of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (visited < steps.length) {
    errors.push("Cycle detected in step `requires` dependency graph");
  }

  return errors;
}

function validateUniqueIds(steps: { id: string }[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) {
      errors.push(`Duplicate step id: "${s.id}"`);
    }
    seen.add(s.id);
  }
  return errors;
}

// ── Main validation function ────────────────────────────────────────────────
export interface ValidationResult {
  ok: boolean;
  errors?: string[];
  /** Parsed data — only present when ok=true. Avoids double-parse. */
  data?: WorkflowDispatchInput;
}

export function validateWorkflowDispatch(body: unknown, bodySizeBytes: number): ValidationResult {
  // Size check
  if (bodySizeBytes > 65536) {
    return { ok: false, errors: ["Request body exceeds 64KB limit"] };
  }

  // Zod parse (single parse — data returned for caller reuse)
  const parsed = WorkflowDispatchSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const steps = parsed.data.workflow.steps;
  const errors: string[] = [
    ...validateUniqueIds(steps),
    ...validateOpenAppPackages(steps),
    ...validateWaitSteps(steps),
    ...detectCycles(steps),
  ];

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data: parsed.data };
}

// ── Generated workflow template contract ────────────────────────────────────

const GENERATED_WORKFLOW_STEP_TYPES = [
  "action",
  "wait",
  "condition",
  "loop",
  "checkpoint",
] as const;

const GENERATED_WORKFLOW_VERIFICATION_STRATEGIES = [
  "local_only",
  "local_with_screenshot",
] as const;

const GENERATED_WORKFLOW_ALLOWED_ACTIONS = [
  "close_app",
  "get_screen_state",
  "intent_send",
  "open_app",
  "press_key",
  "screen_wake",
  "screenshot",
  "scroll",
  "detect_current_screen",
  "a11y_find_tap",
  "classify_ui_tree",
  "semantic_tap",
  "set_variable",
  "swipe",
  "tap",
  "type_text",
  "ui_tree_dump",
  "unlock",
  "wait_for_idle",
] as const;

// Generic interpreter primitives. Application packages, selectors, text,
// coordinates, timing and decisions belong to the workflow payload/DB.
const EDGE_WORKFLOW_V2_ACTIONS = [
  "a11y_find_tap",
  "classify_ui_tree",
  "close_app",
  "double_tap",
  "get_foreground_app",
  "get_screen_state",
  "intent_send",
  "keyevent",
  "long_press",
  "observe_and_transition",
  "ocr_find_tap",
  "open_app",
  "press_key",
  "request_llm",
  "run_state_machine",
  "screen_off",
  "screen_wake",
  "screenshot",
  "screenshot_for_vlm",
  "scroll",
  "set_focused_text",
  "set_variable",
  "swipe",
  "tap",
  "type_text",
  "ui_tree_dump",
  "unlock",
  "wait_for_idle",
] as const;

const GENERATED_WORKFLOW_ALLOWED_URI_LESS_INTENT_ACTIONS = [
  "android.settings.ADD_ACCOUNT_SETTINGS",
] as const;

const GENERATED_WORKFLOW_SAFETY_CLASSES = [
  "read_only",
  "standard",
] as const;

const GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS = [
  "abort_read_only_scan",
  "ai_recovery_workflow",
  "dismiss_transient_ui",
  "navigate_back_once",
  "refresh_screen_state",
  "retry_current_step",
  "return_to_anchor",
  "verify_anchor",
] as const;

const GENERATED_WORKFLOW_RECOVERY_AUTONOMY = [
  "bounded",
  "ai_autopilot",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedWorkflowPlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function validateGeneratedWorkflowOutputSchema(
  value: unknown,
  path: string,
  errors: string[]
): WorkflowOutputSchema | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const required = value.required;
  const properties = value.properties;
  if (!Array.isArray(required) || required.some((item) => typeof item !== "string" || item.length === 0)) {
    errors.push(`${path}.required must be an array of non-empty strings`);
  }
  if (!isRecord(properties)) {
    errors.push(`${path}.properties must be an object`);
    return null;
  }

  const allowedTypes = ["boolean", "string", "number", "object", "array", "null"];
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) {
      errors.push(`${path}.properties.${key} must be an object`);
      continue;
    }
    if (typeof property.type !== "string" || !allowedTypes.includes(property.type)) {
      errors.push(`${path}.properties.${key}.type must be one of: ${allowedTypes.join(", ")}`);
    }
  }
  for (const key of Array.isArray(required) ? required : []) {
    if (typeof key === "string" && isRecord(properties) && !properties[key]) {
      errors.push(`${path}.required contains unknown property: ${key}`);
    }
  }

  return errors.length === 0 ? value as unknown as WorkflowOutputSchema : null;
}

function validateGeneratedWorkflowReadOnlySemantics(
  candidate: Partial<WorkflowTemplate>,
  errors: string[]
): void {
  if (candidate.safetyClass !== "read_only") return;
  if (candidate.goalContract) {
    const reason = workflowGoalContractReason(candidate as WorkflowTemplate);
    if (reason) errors.push(`workflow goal contract violation: ${reason}`);
  }
}

function validateRangeObject(
  value: unknown,
  path: string,
  errors: string[],
  distributions: readonly string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof value.min !== "number") errors.push(`${path}.min must be a number`);
  if (typeof value.max !== "number") errors.push(`${path}.max must be a number`);
  if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) {
    errors.push(`${path}.min must be <= ${path}.max`);
  }
  if (typeof value.distribution !== "string" || !distributions.includes(value.distribution)) {
    errors.push(`${path}.distribution must be one of: ${distributions.join(", ")}`);
  }
}

function validateGeneratedWorkflowStepInput(
  step: unknown,
  path: string,
  errors: string[],
  seenIds: Set<string>,
  runtimeContract?: WorkflowTemplate["runtimeContract"],
): void {
  if (!isRecord(step)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const id = step.id;
  if (id !== undefined) {
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${path}.id must be a non-empty string when provided`);
    } else if (seenIds.has(id)) {
      errors.push(`${path}.id duplicates step id "${id}"`);
    } else {
      seenIds.add(id);
    }
  }

  switch (step.type) {
    case "action": {
      const allowedActions = runtimeContract === "edge-workflow/v2"
        ? EDGE_WORKFLOW_V2_ACTIONS
        : GENERATED_WORKFLOW_ALLOWED_ACTIONS;
      if (typeof step.action !== "string" || step.action.length === 0) {
        errors.push(`${path}.action must be a non-empty string for action steps`);
      } else if (!(allowedActions as readonly string[]).includes(step.action)) {
        errors.push(`${path}.action "${step.action}" is not allowed; must be one of: ${allowedActions.join(", ")}`);
      }
      if (step.params !== undefined && !isRecord(step.params)) {
        errors.push(`${path}.params must be an object when provided`);
      }
      if (step.goalStage !== undefined && (typeof step.goalStage !== "string" || !step.goalStage.trim())) {
        errors.push(`${path}.goalStage must be a non-empty string when provided`);
      }
      if (
        step.effect !== undefined
        && !["none", "observation", "navigation", "ui_input", "business_mutation", "sensitive", "destructive"]
          .includes(String(step.effect))
      ) {
        errors.push(`${path}.effect is invalid`);
      }
      if (step.action === "request_llm") {
        const params = isRecord(step.params) ? step.params : {};
        if (typeof params.prompt !== "string" || !params.prompt.trim()) {
          errors.push(`${path}.params.prompt is required for request_llm`);
        }
        if (params.responseFormat !== undefined && !["text", "json"].includes(String(params.responseFormat))) {
          errors.push(`${path}.params.responseFormat must be text or json`);
        }
        if (params.requiredKeys !== undefined && (!Array.isArray(params.requiredKeys) || params.requiredKeys.some((key) => typeof key !== "string" || !key))) {
          errors.push(`${path}.params.requiredKeys must be an array of non-empty strings`);
        }
        if (params.captureScreenshot === true && params.screenshotVariable !== undefined) {
          errors.push(`${path}.params must not define both captureScreenshot and screenshotVariable`);
        }
      }
      if (step.action === "observe_and_transition") {
        const params = isRecord(step.params) ? step.params : {};
        if (
          !Array.isArray(params.selectors)
          || params.selectors.length === 0
          || params.selectors.some((selector) => !isRecord(selector))
        ) {
          errors.push(`${path}.params.selectors must be a non-empty array of selector objects`);
        }
        if (!isRecord(params.postcondition)) {
          errors.push(`${path}.params.postcondition must be an object`);
        } else {
          const action = params.postcondition.action;
          if (
            typeof action !== "string"
            || !(EDGE_WORKFLOW_V2_ACTIONS as readonly string[]).includes(action)
            || ["observe_and_transition", "run_state_machine", "request_llm"].includes(action)
          ) {
            errors.push(`${path}.params.postcondition.action must be a non-recursive deterministic edge primitive`);
          }
          if (
            typeof params.postcondition.operator !== "string"
            || !["truthy", "falsy", "equals", "not_equals", "contains", "contains_ci", "not_contains", "not_contains_ci", "exists", "missing"]
              .includes(params.postcondition.operator)
          ) {
            errors.push(`${path}.params.postcondition.operator is invalid`);
          }
        }
      }
      if (step.action === "run_state_machine") {
        const params = isRecord(step.params) ? step.params : {};
        if (typeof params.stateVariable !== "string" || !params.stateVariable.trim()) {
          errors.push(`${path}.params.stateVariable is required`);
        }
        if (!isRecord(params.resolver) || !isRecord(params.resolver.outputs)) {
          errors.push(`${path}.params.resolver.outputs must be an object`);
        } else if (
          typeof params.stateVariable === "string"
          && !Object.prototype.hasOwnProperty.call(params.resolver.outputs, params.stateVariable)
        ) {
          errors.push(`${path}.params.resolver.outputs must define params.stateVariable`);
        }
        if (
          !Array.isArray(params.goalStates)
          || params.goalStates.length === 0
          || params.goalStates.some((state) => typeof state !== "string" || !state.trim())
        ) {
          errors.push(`${path}.params.goalStates must be a non-empty array of state names`);
        }
        if (!isRecord(params.transitions) || Object.keys(params.transitions).length === 0) {
          errors.push(`${path}.params.transitions must be a non-empty state-to-action object`);
        } else {
          for (const [state, transition] of Object.entries(params.transitions)) {
            if (!isRecord(transition)) {
              errors.push(`${path}.params.transitions.${state} must be an action object`);
              continue;
            }
            if (transition.action === "run_state_machine") {
              errors.push(`${path}.params.transitions.${state} cannot recursively invoke run_state_machine`);
              continue;
            }
            validateGeneratedWorkflowStepInput(
              { ...transition, type: "action", id: transition.id ?? `${String(step.id ?? "state_machine")}_${state}` },
              `${path}.params.transitions.${state}`,
              errors,
              seenIds,
              runtimeContract,
            );
          }
        }
        if (
          params.maxIterations !== undefined
          && (typeof params.maxIterations !== "number" || params.maxIterations < 1 || params.maxIterations > 100)
        ) {
          errors.push(`${path}.params.maxIterations must be between 1 and 100`);
        }
      }
      if (step.action === "semantic_tap") {
        const target = isRecord(step.params) ? step.params.target : undefined;
        if (typeof target !== "string" || target.trim().length === 0) {
          errors.push(`${path}.params.target is required for semantic_tap actions`);
        }
      }
      if (step.x !== undefined && typeof step.x !== "number") {
        errors.push(`${path}.x must be a number when provided`);
      }
      if (step.y !== undefined && typeof step.y !== "number") {
        errors.push(`${path}.y must be a number when provided`);
      }
      if (
        step.verification !== undefined &&
        (typeof step.verification !== "string" || !GENERATED_WORKFLOW_VERIFICATION_STRATEGIES.includes(step.verification as typeof GENERATED_WORKFLOW_VERIFICATION_STRATEGIES[number]))
      ) {
        errors.push(`${path}.verification must be one of: ${GENERATED_WORKFLOW_VERIFICATION_STRATEGIES.join(", ")}`);
      }
      if (step.expectedScreen !== undefined) {
        const screens = Array.isArray(step.expectedScreen) ? step.expectedScreen : [step.expectedScreen];
        for (const screen of screens) {
          if (typeof screen !== "string" || !screen.trim()) {
            errors.push(`${path}.expectedScreen must contain non-empty state identifiers`);
          }
        }
      }
      if ((step.action === "open_app" || step.action === "close_app") && isRecord(step.params)) {
        const packageName = step.params.packageName;
        if (typeof packageName === "string" && isBlockedPackage(packageName)) {
          errors.push(`${path}.params.packageName is blocked for generated workflows: ${packageName}`);
        }
      }
      if (step.action === "intent_send") {
        const params = isRecord(step.params) ? step.params : {};
        const uri = typeof params.uri === "string" ? params.uri.trim() : "";
        const action = typeof params.action === "string" ? params.action.trim() : "";
        if (!uri && !action) {
          errors.push(`${path}.params.uri or params.action is required for intent_send actions`);
        } else if (
          !uri &&
          !GENERATED_WORKFLOW_ALLOWED_URI_LESS_INTENT_ACTIONS.includes(
            action as typeof GENERATED_WORKFLOW_ALLOWED_URI_LESS_INTENT_ACTIONS[number],
          )
        ) {
          errors.push(`${path}.params.action is not allowed without a uri: ${action}`);
        }
      }
      if (step.retries !== undefined && (typeof step.retries !== "number" || step.retries < 0)) {
        errors.push(`${path}.retries must be a non-negative number when provided`);
      }
      for (const key of ["retryDelayMs", "delayAfterMs"] as const) {
        if (step[key] !== undefined && (typeof step[key] !== "number" || step[key] < 0 || step[key] > 600_000)) {
          errors.push(`${path}.${key} must be a number between 0 and 600000 when provided`);
        }
      }
      if (step.saveOutputAs !== undefined && (typeof step.saveOutputAs !== "string" || step.saveOutputAs.length === 0)) {
        errors.push(`${path}.saveOutputAs must be a non-empty string when provided`);
      }
      if (
        step.failureMode !== undefined &&
        !["abort", "continue", "run_branch", "run_branch_then_retry"].includes(String(step.failureMode))
      ) {
        errors.push(`${path}.failureMode is invalid`);
      }
      if (step.onFailureSteps !== undefined) {
        if (!Array.isArray(step.onFailureSteps)) {
          errors.push(`${path}.onFailureSteps must be a step array when provided`);
        } else {
          step.onFailureSteps.forEach((child, index) =>
            validateGeneratedWorkflowStepInput(child, `${path}.onFailureSteps[${index}]`, errors, seenIds, runtimeContract)
          );
        }
      }
      if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== "number" || step.timeoutMs < 1)) {
        errors.push(`${path}.timeoutMs must be a positive number when provided`);
      }
      break;
    }
    case "wait":
      if (step.duration === undefined && step.condition === undefined && step.until === undefined) {
        errors.push(`${path} wait step must define duration, condition, or until`);
      }
      if (step.duration !== undefined) {
        validateRangeObject(step.duration, `${path}.duration`, errors, ["uniform", "lognormal", "normal"]);
      }
      if (step.condition !== undefined && typeof step.condition !== "string") {
        errors.push(`${path}.condition must be a string when provided`);
      }
      if (step.until !== undefined) {
        if (!isRecord(step.until)) {
          errors.push(`${path}.until must be an object when provided`);
        } else {
          if (typeof step.until.action !== "string" || !(EDGE_WORKFLOW_V2_ACTIONS as readonly string[]).includes(step.until.action)) {
            errors.push(`${path}.until.action must be a generic edge primitive`);
          }
          if (step.until.params !== undefined && !isRecord(step.until.params)) {
            errors.push(`${path}.until.params must be an object when provided`);
          }
          if (typeof step.until.operator !== "string" || !["truthy", "falsy", "equals", "not_equals", "contains", "contains_ci", "not_contains", "not_contains_ci", "exists", "missing"].includes(step.until.operator)) {
            errors.push(`${path}.until.operator is invalid`);
          }
          if (typeof step.until.timeoutMs !== "number" || step.until.timeoutMs < 1 || step.until.timeoutMs > 600_000) {
            errors.push(`${path}.until.timeoutMs must be between 1 and 600000`);
          }
        }
      }
      break;
    case "condition":
      if ((typeof step.check !== "string" || step.check.length === 0) && (typeof step.expression !== "string" || step.expression.length === 0)) {
        errors.push(`${path} condition step requires check or expression`);
      }
      if (step.probability !== undefined && (typeof step.probability !== "number" || step.probability < 0 || step.probability > 1)) {
        errors.push(`${path}.probability must be a number between 0 and 1 when provided`);
      }
      if (!Array.isArray(step.if_true) || step.if_true.length === 0) {
        errors.push(`${path}.if_true must be a non-empty step array`);
      } else {
        step.if_true.forEach((child, index) =>
          validateGeneratedWorkflowStepInput(child, `${path}.if_true[${index}]`, errors, seenIds, runtimeContract)
        );
      }
      if (step.if_false !== undefined) {
        if (!Array.isArray(step.if_false)) {
          errors.push(`${path}.if_false must be a step array when provided`);
        } else {
          step.if_false.forEach((child, index) =>
            validateGeneratedWorkflowStepInput(child, `${path}.if_false[${index}]`, errors, seenIds, runtimeContract)
          );
        }
      }
      break;
    case "loop":
      validateRangeObject(step.count, `${path}.count`, errors, ["uniform", "normal"]);
      if (!Array.isArray(step.steps) || step.steps.length === 0) {
        errors.push(`${path}.steps must be a non-empty step array for loop steps`);
      } else {
        step.steps.forEach((child, index) =>
          validateGeneratedWorkflowStepInput(child, `${path}.steps[${index}]`, errors, seenIds, runtimeContract)
        );
      }
      break;
    case "checkpoint":
      if (typeof step.id !== "string" || step.id.length === 0) {
        errors.push(`${path}.id is required for checkpoint steps`);
      }
      break;
    default:
      errors.push(`${path}.type must be one of: ${GENERATED_WORKFLOW_STEP_TYPES.join(", ")}`);
  }
}

function validateGeneratedWorkflowRecoveryPolicy(
  policy: unknown,
  path: string,
  errors: string[],
): void {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }

  const candidate = policy as WorkflowRecoveryPolicy;
  if (
    candidate.autonomy !== undefined &&
    (typeof candidate.autonomy !== "string" || !GENERATED_WORKFLOW_RECOVERY_AUTONOMY.includes(candidate.autonomy as typeof GENERATED_WORKFLOW_RECOVERY_AUTONOMY[number]))
  ) {
    errors.push(`${path}.autonomy must be one of: ${GENERATED_WORKFLOW_RECOVERY_AUTONOMY.join(", ")}`);
  }

  for (const key of ["maxAttemptsPerStep", "maxAttemptsPerWorkflow", "maxRecoveryActionsPerAttempt"] as const) {
    const value = candidate[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 20)) {
      errors.push(`${path}.${key} must be an integer between 0 and 20`);
    }
  }

  if (candidate.allowedRecoveryRequests !== undefined) {
    if (
      !Array.isArray(candidate.allowedRecoveryRequests) ||
      candidate.allowedRecoveryRequests.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      errors.push(`${path}.allowedRecoveryRequests must be an array of non-empty strings`);
    } else {
      for (const recoveryRequest of candidate.allowedRecoveryRequests) {
        if (!GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS.includes(recoveryRequest as typeof GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS[number])) {
          errors.push(`${path}.allowedRecoveryRequests must contain only: ${GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS.join(", ")}`);
          break;
        }
      }
    }
  }

  for (const key of ["requireStateVerification", "learnFromFailure"] as const) {
    const value = candidate[key];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${path}.${key} must be a boolean when provided`);
    }
  }
}

export interface GeneratedWorkflowTemplateValidationResult {
  ok: boolean;
  errors: string[];
  template?: WorkflowTemplate;
}

export interface GeneratedWorkflowCompiledStep {
  path: string;
  type: WorkflowStep["type"];
  id?: string;
  action?: string;
  verification?: string;
  goalStage?: string;
  effect?: WorkflowInteractionEffect;
  bindingSource?: GeneratedWorkflowBindingSource;
  usedAppMap?: boolean;
  selectorId?: string;
  selectorName?: string;
  pageId?: string;
  pageSignature?: string;
  coordinateSource?: string;
  boundsSource?: string;
  fallbackReason?: string;
  provenance?: GeneratedWorkflowStepProvenance;
}

export type GeneratedWorkflowBindingSource =
  | "app_map_selector"
  | "app_map_coordinate"
  | "ui_tree_selector"
  | "raw_coordinate"
  | "fallback";

export interface GeneratedWorkflowStepProvenance {
  usedAppMap: boolean;
  bindingSource: GeneratedWorkflowBindingSource;
  selector?: {
    id?: string;
    name?: string;
    target?: string;
  };
  page?: {
    id?: string;
    signature?: string;
  };
  coordinate?: {
    x?: number;
    y?: number;
    bounds?: unknown;
    source?: string;
    boundsSource?: string;
  };
  fallbackReason?: string;
}

export interface GeneratedWorkflowAppMapCacheMetadata {
  appId: string;
  mapVersion: string;
  appVersion: string | null;
  resolution: {
    width: number | null;
    height: number | null;
  };
  qualityUsable: boolean;
  qualityStats: AppMapQualityReport["stats"];
  qualityErrors: string[];
  qualityWarnings: string[];
}

export interface GeneratedWorkflowCacheInvalidation {
  stale: boolean;
  code?: "APP_MAP_MISSING" | "APP_MAP_UNUSABLE" | "APP_MAP_VERSION_CHANGED" | "APP_VERSION_CHANGED" | "RESOLUTION_CHANGED";
  reason?: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  cachedAppMap?: GeneratedWorkflowAppMapCacheMetadata;
}

export interface GeneratedWorkflowCompiledPlan {
  planVersion: "generated-workflow-plan/v1";
  cacheKey: string;
  templateId: string;
  platform: string;
  templateVersion: string;
  metadata: {
    intent: string | null;
    safetyClass: "read_only" | "standard" | null;
    outputSchema: WorkflowOutputSchema | null;
    goalContract: WorkflowGoalContract | null;
    allowedRecoveryRequests: string[];
    recoveryPolicy: WorkflowRecoveryPolicy | null;
    appMap?: GeneratedWorkflowAppMapCacheMetadata;
  };
  stepCount: number;
  actionCount: number;
  checkpointCount: number;
  maxDepth: number;
  llmBudget: {
    happyPathRequests: number;
    recoveryRequests: "only_on_failure";
  };
  steps: GeneratedWorkflowCompiledStep[];
}

export function computeGeneratedWorkflowCompiledPlanHash(plan: GeneratedWorkflowCompiledPlan): string {
  return createHash("sha256").update(stableStringify({
    planVersion: plan.planVersion,
    cacheKey: plan.cacheKey,
    templateId: plan.templateId,
    platform: plan.platform,
    templateVersion: plan.templateVersion,
    metadata: plan.metadata,
    stepCount: plan.stepCount,
    actionCount: plan.actionCount,
    checkpointCount: plan.checkpointCount,
    maxDepth: plan.maxDepth,
    llmBudget: plan.llmBudget,
    steps: plan.steps,
  })).digest("hex");
}

export function validateGeneratedWorkflowTemplate(template: unknown): GeneratedWorkflowTemplateValidationResult {
  const errors: string[] = [];
  if (!isRecord(template)) {
    return { ok: false, errors: ["workflow must be an object"] };
  }

  const candidate = template as Partial<WorkflowTemplate>;
  if (candidate.runtimeContract !== undefined && candidate.runtimeContract !== "edge-workflow/v2") {
    errors.push("workflow.runtimeContract must be edge-workflow/v2 when provided");
  }
  if (!candidate.id || typeof candidate.id !== "string") errors.push("workflow.id must be a non-empty string");
  if (!candidate.name || typeof candidate.name !== "string") errors.push("workflow.name must be a non-empty string");
  if (!candidate.platform || typeof candidate.platform !== "string") {
    errors.push("workflow.platform must be a non-empty string");
  } else {
    const normalizedPlatform = normalizeGeneratedWorkflowPlatform(candidate.platform);
    if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(normalizedPlatform)) {
      errors.push("workflow.platform must be a safe app/profile identifier");
    } else {
      candidate.platform = normalizedPlatform;
    }
  }
  if (!candidate.description || typeof candidate.description !== "string") errors.push("workflow.description must be a non-empty string");
  if (!candidate.version || typeof candidate.version !== "string") errors.push("workflow.version must be a non-empty string");
  if (candidate.intent !== undefined) {
    if (
      typeof candidate.intent !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(candidate.intent.trim().toLowerCase())
    ) {
      errors.push("workflow.intent must be a safe catalog identifier when provided");
    }
  }
  if (candidate.safetyClass !== undefined) {
    if (typeof candidate.safetyClass !== "string" || !GENERATED_WORKFLOW_SAFETY_CLASSES.includes(candidate.safetyClass as typeof GENERATED_WORKFLOW_SAFETY_CLASSES[number])) {
      errors.push(`workflow.safetyClass must be one of: ${GENERATED_WORKFLOW_SAFETY_CLASSES.join(", ")}`);
    }
  }
  if (candidate.allowedRecoveryRequests && candidate.safetyClass !== "read_only") {
    errors.push("workflow.allowedRecoveryRequests requires workflow.safetyClass=read_only");
  }
  if (candidate.outputSchema !== undefined) {
    validateGeneratedWorkflowOutputSchema(candidate.outputSchema, "workflow.outputSchema", errors);
  }
  if (candidate.goalContract !== undefined) {
    const parsedContract = parseWorkflowGoalContract(candidate.goalContract);
    if (!parsedContract) {
      errors.push("workflow.goalContract is invalid");
    } else {
      candidate.goalContract = parsedContract;
      const reason = workflowGoalContractReason(candidate as WorkflowTemplate);
      if (reason) errors.push(`workflow goal contract violation: ${reason}`);
    }
  }
  if (candidate.allowedRecoveryRequests !== undefined) {
    if (!Array.isArray(candidate.allowedRecoveryRequests) || candidate.allowedRecoveryRequests.some((item) => typeof item !== "string" || item.length === 0)) {
      errors.push("workflow.allowedRecoveryRequests must be an array of non-empty strings");
    } else {
      for (const recoveryRequest of candidate.allowedRecoveryRequests) {
        if (!GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS.includes(recoveryRequest as typeof GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS[number])) {
          errors.push(`workflow.allowedRecoveryRequests must contain only: ${GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS.join(", ")}`);
          break;
        }
      }
    }
  }
  if (candidate.recoveryPolicy !== undefined) {
    validateGeneratedWorkflowRecoveryPolicy(candidate.recoveryPolicy, "workflow.recoveryPolicy", errors);
  }
  if (
    candidate.defaultVerificationStrategy !== undefined &&
    !GENERATED_WORKFLOW_VERIFICATION_STRATEGIES.includes(candidate.defaultVerificationStrategy as typeof GENERATED_WORKFLOW_VERIFICATION_STRATEGIES[number])
  ) {
    errors.push(`workflow.defaultVerificationStrategy must be one of: ${GENERATED_WORKFLOW_VERIFICATION_STRATEGIES.join(", ")}`);
  }
  if (candidate.dataRetentionDays !== undefined && (typeof candidate.dataRetentionDays !== "number" || candidate.dataRetentionDays < 0)) {
    errors.push("workflow.dataRetentionDays must be a non-negative number when provided");
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    errors.push("workflow.steps must be a non-empty array");
  } else {
    const seenIds = new Set<string>();
    candidate.steps.forEach((step, index) =>
      validateGeneratedWorkflowStepInput(step, `workflow.steps[${index}]`, errors, seenIds, candidate.runtimeContract)
    );
  }
  validateGeneratedWorkflowReadOnlySemantics(candidate, errors);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, errors: [], template: candidate as WorkflowTemplate };
}

export function summarizeGeneratedWorkflowTemplate(
  template: WorkflowTemplate,
  options?: { dryRun?: boolean; persisted?: boolean; compiledPlan?: GeneratedWorkflowCompiledPlan }
): Record<string, unknown> {
  return {
    generated: true,
    ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options?.persisted !== undefined ? { persisted: options.persisted } : {}),
    templateId: template.id,
    platform: template.platform,
    version: template.version,
    intent: template.intent ?? null,
    safetyClass: template.safetyClass ?? null,
    outputSchema: template.outputSchema ?? null,
    goalContract: template.goalContract ?? null,
    allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
    recoveryPolicy: template.recoveryPolicy ?? null,
    runtimeContract: template.runtimeContract ?? null,
    stepCount: template.steps.length,
    compiledPlan: options?.compiledPlan ?? compileGeneratedWorkflowTemplate(template),
  };
}

export function compileGeneratedWorkflowTemplate(template: WorkflowTemplate): GeneratedWorkflowCompiledPlan {
  const steps: GeneratedWorkflowCompiledStep[] = [];
  let actionCount = 0;
  let checkpointCount = 0;
  let maxDepth = 0;
  let explicitLlmRequests = 0;

  const visit = (stepList: WorkflowStep[], prefix: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    stepList.forEach((step, index) => {
      const path = `${prefix}[${index}]`;
      const compiledStep: GeneratedWorkflowCompiledStep = {
        path,
        type: step.type,
        id: "id" in step ? step.id : undefined,
      };

      if (step.type === "action") {
        actionCount++;
        if (step.action === "request_llm") explicitLlmRequests++;
        compiledStep.action = step.action;
        compiledStep.goalStage = step.goalStage;
        compiledStep.effect = step.effect;
        compiledStep.verification = step.verification ?? template.defaultVerificationStrategy;
        compiledStep.provenance = getGeneratedWorkflowStepProvenance(step);
        compiledStep.bindingSource = compiledStep.provenance.bindingSource;
        compiledStep.usedAppMap = compiledStep.provenance.usedAppMap;
        compiledStep.selectorId = compiledStep.provenance.selector?.id;
        compiledStep.selectorName = compiledStep.provenance.selector?.name;
        compiledStep.pageId = compiledStep.provenance.page?.id;
        compiledStep.pageSignature = compiledStep.provenance.page?.signature;
        compiledStep.coordinateSource = compiledStep.provenance.coordinate?.source;
        compiledStep.boundsSource = compiledStep.provenance.coordinate?.boundsSource;
        compiledStep.fallbackReason = compiledStep.provenance.fallbackReason;
      } else if (step.type === "checkpoint") {
        checkpointCount++;
      }

      steps.push(compiledStep);

      if (step.type === "action" && step.onFailureSteps) {
        visit(step.onFailureSteps, `${path}.onFailureSteps`, depth + 1);
      } else if (step.type === "condition") {
        visit(step.if_true, `${path}.if_true`, depth + 1);
        if (step.if_false) visit(step.if_false, `${path}.if_false`, depth + 1);
      } else if (step.type === "loop") {
        visit(step.steps, `${path}.steps`, depth + 1);
      }
    });
  };

  visit(template.steps, "workflow.steps", 1);

  const cacheSource = stableStringify({
    id: template.id,
    platform: template.platform,
    version: template.version,
    intent: template.intent ?? null,
    safetyClass: template.safetyClass ?? null,
    outputSchema: template.outputSchema ?? null,
    goalContract: template.goalContract ?? null,
    allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
    recoveryPolicy: template.recoveryPolicy ?? null,
    defaultVerificationStrategy: template.defaultVerificationStrategy,
    steps: template.steps,
    runtimeContract: template.runtimeContract ?? null,
  });
  const cacheKey = createHash("sha256").update(cacheSource).digest("hex").slice(0, 24);

  return {
    planVersion: "generated-workflow-plan/v1",
    cacheKey,
    templateId: template.id,
    platform: template.platform,
    templateVersion: template.version,
    metadata: {
      intent: template.intent ?? null,
      safetyClass: template.safetyClass ?? null,
      outputSchema: template.outputSchema ?? null,
      goalContract: template.goalContract ?? null,
      allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
      recoveryPolicy: template.recoveryPolicy ?? null,
      appMap: undefined,
    },
    stepCount: steps.length,
    actionCount,
    checkpointCount,
    maxDepth,
    llmBudget: {
      happyPathRequests: explicitLlmRequests,
      recoveryRequests: "only_on_failure",
    },
    steps,
  };
}

export function inferGeneratedWorkflowBindingSource(step: WorkflowStep): GeneratedWorkflowBindingSource {
  return getGeneratedWorkflowStepProvenance(step).bindingSource;
}

export function getGeneratedWorkflowStepProvenance(step: WorkflowStep): GeneratedWorkflowStepProvenance {
  if (step.type !== "action") {
    return {
      usedAppMap: false,
      bindingSource: "fallback",
      fallbackReason: "non_action_step",
    };
  }

  const bindingSource = step.params?.bindingSource;
  const inferredBindingSource = inferGeneratedWorkflowBindingSourceFromShape(step);
  const normalizedBindingSource =
    bindingSource === "app_map_selector"
    || bindingSource === "app_map_coordinate"
    || bindingSource === "ui_tree_selector"
    || bindingSource === "raw_coordinate"
    || bindingSource === "fallback"
      ? bindingSource
      : inferredBindingSource;
  const params = step.params ?? {};
  const target = typeof step.target === "string" && step.target.length > 0 ? step.target : undefined;
  const selectorId =
    stringParam(params.selectorId)
    ?? stringParam(params.elementId)
    ?? stringParam(params.appMapElementId)
    ?? parseSelectorIdFromTarget(target);
  const selectorName =
    stringParam(params.selectorName)
    ?? stringParam(params.elementName)
    ?? stringParam(params.accessibilityName)
    ?? (target && !target.includes(":") ? target : undefined);
  const coordinateSource =
    stringParam(params.coordinateSource)
    ?? (normalizedBindingSource === "app_map_coordinate" ? "app_map" : undefined)
    ?? (normalizedBindingSource === "raw_coordinate" ? "raw" : undefined);
  const boundsSource =
    stringParam(params.boundsSource)
    ?? (normalizedBindingSource === "app_map_coordinate" ? "app_map" : undefined);
  const fallbackReason =
    normalizedBindingSource === "fallback"
      ? stringParam(params.fallbackReason) ?? inferFallbackReason(step)
      : undefined;

  return {
    usedAppMap: normalizedBindingSource === "app_map_selector" || normalizedBindingSource === "app_map_coordinate",
    bindingSource: normalizedBindingSource,
    selector: selectorId || selectorName || target ? { id: selectorId, name: selectorName, target } : undefined,
    page: stringParam(params.pageId) || stringParam(params.appMapPageId) || stringParam(params.pageSignature) || stringParam(params.signatureHash)
      ? {
          id: stringParam(params.pageId) ?? stringParam(params.appMapPageId),
          signature: stringParam(params.pageSignature) ?? stringParam(params.signatureHash),
        }
      : undefined,
    coordinate: Number.isFinite(step.x) || Number.isFinite(step.y) || params.bounds !== undefined || coordinateSource || boundsSource
      ? {
          x: Number.isFinite(step.x) ? step.x : undefined,
          y: Number.isFinite(step.y) ? step.y : undefined,
          bounds: params.bounds,
          source: coordinateSource,
          boundsSource,
        }
      : undefined,
    fallbackReason,
  };
}

function inferGeneratedWorkflowBindingSourceFromShape(step: WorkflowStep): GeneratedWorkflowBindingSource {
  if (step.type !== "action") return "fallback";

  const bindingSource = step.params?.bindingSource;
  if (
    bindingSource === "app_map_selector"
    || bindingSource === "app_map_coordinate"
    || bindingSource === "ui_tree_selector"
    || bindingSource === "raw_coordinate"
    || bindingSource === "fallback"
  ) {
    return bindingSource;
  }

  if (typeof step.target === "string" && step.target.length > 0) {
    return step.target.startsWith("app_map:")
      || step.target.startsWith("app_map_selector:")
      || step.target.startsWith("map:")
      ? "app_map_selector"
      : "ui_tree_selector";
  }

  if (Number.isFinite(step.x) && Number.isFinite(step.y)) {
    return step.params?.coordinateSource === "app_map" ? "app_map_coordinate" : "raw_coordinate";
  }

  return "fallback";
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseSelectorIdFromTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const marker = target.includes(":") ? target.split(":").slice(1).join(":") : target;
  return marker.trim().length > 0 ? marker : undefined;
}

function inferFallbackReason(step: WorkflowStep): string {
  if (step.type !== "action") return "non_action_step";
  if (!step.target && !Number.isFinite(step.x) && !Number.isFinite(step.y)) {
    return "no_selector_or_coordinate";
  }
  return "explicit_fallback_binding";
}

export function generatedWorkflowPlanUsesAppMap(plan: GeneratedWorkflowCompiledPlan): boolean {
  return Boolean(plan.metadata.appMap) || plan.steps.some((step) => step.usedAppMap || step.bindingSource === "app_map_selector" || step.bindingSource === "app_map_coordinate");
}

export function buildGeneratedWorkflowAppMapCacheMetadata(
  appMap: AppMap,
  quality: AppMapQualityReport
): GeneratedWorkflowAppMapCacheMetadata {
  return {
    appId: appMap.appId,
    mapVersion: appMap.version,
    appVersion: appMap.appVersion ?? null,
    resolution: {
      width: appMap.deviceProfile?.width ?? null,
      height: appMap.deviceProfile?.height ?? null,
    },
    qualityUsable: quality.usable,
    qualityStats: quality.stats,
    qualityErrors: quality.errors,
    qualityWarnings: quality.warnings,
  };
}

export function withGeneratedWorkflowAppMapCacheMetadata(
  plan: GeneratedWorkflowCompiledPlan,
  appMap: GeneratedWorkflowAppMapCacheMetadata | undefined
): GeneratedWorkflowCompiledPlan {
  if (!appMap) return plan;
  return {
    ...plan,
    metadata: {
      ...plan.metadata,
      appMap,
    },
  };
}

export function assessGeneratedWorkflowCacheInvalidation(
  plan: GeneratedWorkflowCompiledPlan,
  currentAppMap: AppMap | null | undefined,
  currentQuality: AppMapQualityReport | null | undefined
): GeneratedWorkflowCacheInvalidation {
  if (!generatedWorkflowPlanUsesAppMap(plan)) {
    return { stale: false };
  }
  const cachedAppMap = plan.metadata.appMap;
  if (!cachedAppMap) {
    return {
      stale: true,
      code: "APP_MAP_MISSING",
      reason: "cached workflow uses app-map bindings but does not include app-map cache metadata",
    };
  }
  if (!currentAppMap || !currentQuality) {
    return {
      stale: true,
      code: "APP_MAP_MISSING",
      reason: `cached workflow expects app map ${cachedAppMap.appId}, but no current app map was available`,
      cachedAppMap,
    };
  }
  if (!currentQuality.usable) {
    return {
      stale: true,
      code: "APP_MAP_UNUSABLE",
      reason: `current app map ${currentAppMap.appId} is not usable`,
      actual: { qualityErrors: currentQuality.errors, qualityWarnings: currentQuality.warnings, qualityStats: currentQuality.stats },
      cachedAppMap,
    };
  }
  if (currentAppMap.version !== cachedAppMap.mapVersion) {
    return {
      stale: true,
      code: "APP_MAP_VERSION_CHANGED",
      reason: `app map version changed from ${cachedAppMap.mapVersion} to ${currentAppMap.version}`,
      expected: { mapVersion: cachedAppMap.mapVersion },
      actual: { mapVersion: currentAppMap.version },
      cachedAppMap,
    };
  }
  if ((currentAppMap.appVersion ?? null) !== cachedAppMap.appVersion) {
    return {
      stale: true,
      code: "APP_VERSION_CHANGED",
      reason: `app version changed from ${cachedAppMap.appVersion ?? "unknown"} to ${currentAppMap.appVersion ?? "unknown"}`,
      expected: { appVersion: cachedAppMap.appVersion },
      actual: { appVersion: currentAppMap.appVersion ?? null },
      cachedAppMap,
    };
  }
  const currentWidth = currentAppMap.deviceProfile?.width ?? null;
  const currentHeight = currentAppMap.deviceProfile?.height ?? null;
  if (currentWidth !== cachedAppMap.resolution.width || currentHeight !== cachedAppMap.resolution.height) {
    return {
      stale: true,
      code: "RESOLUTION_CHANGED",
      reason: `app map resolution changed from ${cachedAppMap.resolution.width ?? "unknown"}x${cachedAppMap.resolution.height ?? "unknown"} to ${currentWidth ?? "unknown"}x${currentHeight ?? "unknown"}`,
      expected: { resolution: cachedAppMap.resolution },
      actual: { resolution: { width: currentWidth, height: currentHeight } },
      cachedAppMap,
    };
  }
  return { stale: false, cachedAppMap };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getGeneratedWorkflowContract(): Record<string, unknown> {
  const exampleSteps: WorkflowStep[] = [
    {
      type: "action",
      id: "open_target",
      action: "open_app",
      params: { packageName: "{{runtime.packageName}}" },
      goalStage: "open_surface",
      effect: "navigation",
    },
    {
      type: "action",
      id: "observe_target",
      action: "classify_ui_tree",
      params: { outputs: { state: { patterns: ["{{catalog.statePattern}}"] } } },
      saveOutputAs: "state",
      goalStage: "observe_surface",
      effect: "observation",
    },
    { type: "checkpoint", id: "goal_verified", reason: "Catalog-defined goal state was observed" },
  ];

  return {
    sourceOfTruth: "Agents generate workflow templates dynamically; server validates, optionally persists, then dispatches.",
    endpoints: {
      validate: "POST /api/workflows/generated/validate",
      dryRun: "POST /api/workflows/generated with { dryRun: true }",
      resolveCache: "POST /api/workflows/generated/cache/resolve",
      cache: "GET /api/workflows/generated/cache/:cacheKey",
      execute: "POST /api/workflows/generated with { deviceId, workflow | cacheKey | requestKey }",
    },
    compiledPlan: {
      returnedBy: ["POST /api/workflows/generated/validate", "POST /api/workflows/generated with { dryRun: true }"],
      cacheKey: "Stable hash of the validated template fields that affect deterministic execution.",
      requestKey: "Stable hash returned by /prompt before LLM generation; use it to check cache first.",
      cacheFirstPrompt: "POST /api/workflows/generated/prompt returns cached workflow+plan when requestKey is already known.",
      executeFromCache: "POST /api/workflows/generated can execute cached templates directly by cacheKey or requestKey.",
      canExecuteFromCache: "Boolean response hint; true means a later call can use cacheKey/requestKey without regenerating the workflow.",
      happyPathLlmRequests: "explicit_workflow_steps_only",
      recovery: "LLM recovery must be declared by the workflow failure branch.",
    },
    template: {
      required: ["id", "name", "platform", "description", "version", "steps"],
      optional: ["intent", "safetyClass", "outputSchema", "allowedRecoveryRequests", "recoveryPolicy", "defaultVerificationStrategy", "dataRetentionDays", "compatibleAppVersions"],
      platforms: "catalog_managed",
      intents: "catalog_managed",
      safetyClasses: GENERATED_WORKFLOW_SAFETY_CLASSES,
      allowedRecoveryRequests: GENERATED_WORKFLOW_ALLOWED_RECOVERY_REQUESTS,
      recoveryAutonomy: GENERATED_WORKFLOW_RECOVERY_AUTONOMY,
      defaultVerificationStrategy: GENERATED_WORKFLOW_VERIFICATION_STRATEGIES,
      stepTypes: GENERATED_WORKFLOW_STEP_TYPES,
    },
    steps: {
      action: {
        required: ["type", "action"],
        optional: ["id", "target", "x", "y", "params", "verification", "retries", "timeoutMs", "expectedScreen"],
        allowedActions: GENERATED_WORKFLOW_ALLOWED_ACTIONS,
      },
      wait: {
        required: ["type", "duration or condition"],
        optional: ["id", "element", "timeoutMs"],
      },
      condition: {
        required: ["type", "check", "if_true"],
        optional: ["id", "probability", "if_false"],
      },
      loop: {
        required: ["type", "count", "steps"],
        optional: ["id", "breakOn"],
      },
      checkpoint: {
        required: ["type", "id"],
        optional: ["reason"],
      },
    },
    example: {
      id: "agent_generated_catalog_example_v1",
      name: "Catalog-driven workflow example",
      platform: "android",
      description: "Minimal data-driven generated workflow contract example.",
      version: "1.0.0",
      safetyClass: "read_only",
      goalContract: {
        version: "1",
        allowedEffects: ["navigation", "observation"],
        requiredOutputs: ["state"],
        stages: [
          {
            id: "open_surface",
            allowedActions: ["open_app"],
            allowedEffects: ["navigation"],
          },
          {
            id: "observe_surface",
            allowedActions: ["classify_ui_tree"],
            allowedEffects: ["observation"],
            after: ["open_surface"],
            produces: ["state"],
          },
        ],
      },
      outputSchema: {
        required: ["state"],
        properties: {
          state: { type: "string" },
        },
      },
      allowedRecoveryRequests: ["refresh_screen_state"],
      recoveryPolicy: {
        autonomy: "ai_autopilot",
        maxAttemptsPerStep: 3,
        maxAttemptsPerWorkflow: 6,
        maxRecoveryActionsPerAttempt: 6,
        allowedRecoveryRequests: ["ai_recovery_workflow", "refresh_screen_state", "retry_current_step", "return_to_anchor", "verify_anchor"],
        requireStateVerification: true,
        learnFromFailure: true,
      },
      defaultVerificationStrategy: "local_with_screenshot",
      dataRetentionDays: 7,
      steps: exampleSteps,
    },
  };
}
