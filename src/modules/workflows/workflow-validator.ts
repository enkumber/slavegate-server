/**
 * workflow-validator.ts
 * Zod schema + semantic validation for dynamic workflow dispatch.
 */

import { z } from "zod";
import { createHash } from "crypto";
import type { AppMap, AppMapQualityReport } from "../app-mapping/schema";
import type { WorkflowOutputSchema, WorkflowRecoveryPolicy, WorkflowStep, WorkflowTemplate } from "./types";
import { ALL_SCREEN_IDS } from "../screen-detection/types";

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

const GENERATED_WORKFLOW_PLATFORMS = [
  "instagram",
  "reddit",
  "threads",
  "tiktok",
  "twitter",
  "youtube",
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
  "classify_reddit_health_scan",
  "a11y_find_tap",
  "semantic_tap",
  "set_variable",
  "swipe",
  "tap",
  "type_text",
  "ui_tree_dump",
  "unlock",
  "vlm_generate_comment",
  "wait_for_idle",
] as const;

const GENERATED_WORKFLOW_INTENTS = [
  "reddit_account_health_scan",
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

const REDDIT_ACCOUNT_HEALTH_REQUIRED_OUTPUT = [
  "loggedIn",
  "homeFeedVisible",
  "searchSurfaceAvailable",
  "challengeDetected",
  "loginWallDetected",
  "accountSwitcherVisible",
  "observedUsername",
  "screenState",
  "error",
] as const;

const READ_ONLY_MUTATION_TERMS = [
  "comment",
  "downvote",
  "edit_profile",
  "follow",
  "join",
  "login",
  "message",
  "post",
  "profile_edit",
  "reply",
  "settings",
  "send",
  "submit",
  "type_text",
  "upvote",
  "vote",
] as const;

const READ_ONLY_EVIDENCE_KEYS = new Set<string>(REDDIT_ACCOUNT_HEALTH_REQUIRED_OUTPUT);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedWorkflowPlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

function containsMutationTerm(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const tokenized = value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const compact = normalized.replace(/[^a-z0-9]/g, "");
    return READ_ONLY_MUTATION_TERMS.find((term) => {
      if (term === "login" && (normalized.includes("login state") || compact === "loginwalldetected")) {
        return false;
      }
      if (term === "send" && compact === "intentsend") {
        return false;
      }
      const compactTerm = term.replace(/[^a-z0-9]/g, "");
      return tokenized.includes(compactTerm) || compact.includes(compactTerm);
    }) ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsMutationTerm(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const found = (READ_ONLY_EVIDENCE_KEYS.has(key) ? null : containsMutationTerm(key)) ?? containsMutationTerm(nested);
      if (found) return found;
    }
  }
  return null;
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
  const mutationTerm = containsMutationTerm({
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    intent: candidate.intent,
    steps: candidate.steps,
    allowedRecoveryRequests: candidate.allowedRecoveryRequests,
  });
  if (mutationTerm) {
    errors.push(`workflow.safetyClass=read_only cannot include mutating term: ${mutationTerm}`);
  }
}

function validateRedditAccountHealthIntent(candidate: Partial<WorkflowTemplate>, errors: string[]): void {
  if (candidate.intent !== "reddit_account_health_scan") return;
  if (candidate.platform !== "reddit") {
    errors.push("workflow.intent=reddit_account_health_scan requires workflow.platform=reddit");
  }
  if (candidate.safetyClass !== "read_only") {
    errors.push("workflow.intent=reddit_account_health_scan requires workflow.safetyClass=read_only");
  }
  const schema = candidate.outputSchema;
  if (!schema) {
    errors.push("workflow.intent=reddit_account_health_scan requires workflow.outputSchema");
    return;
  }
  for (const key of REDDIT_ACCOUNT_HEALTH_REQUIRED_OUTPUT) {
    if (!schema.required.includes(key)) {
      errors.push(`workflow.outputSchema.required must include ${key}`);
    }
    const property = schema.properties[key];
    if (!property) {
      errors.push(`workflow.outputSchema.properties.${key} is required`);
    } else if ((key === "error" || key === "observedUsername") && property.type !== "string" && property.type !== "null") {
      errors.push(`workflow.outputSchema.properties.${key}.type must be string or null`);
    } else if (
      key !== "error" &&
      key !== "observedUsername" &&
      property.type !== "boolean" &&
      property.type !== "string"
    ) {
      errors.push(`workflow.outputSchema.properties.${key}.type must be boolean or string`);
    }
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
  seenIds: Set<string>
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
    case "action":
      if (typeof step.action !== "string" || step.action.length === 0) {
        errors.push(`${path}.action must be a non-empty string for action steps`);
      } else if (!GENERATED_WORKFLOW_ALLOWED_ACTIONS.includes(step.action as typeof GENERATED_WORKFLOW_ALLOWED_ACTIONS[number])) {
        errors.push(`${path}.action must be one of: ${GENERATED_WORKFLOW_ALLOWED_ACTIONS.join(", ")}`);
      }
      if (step.params !== undefined && !isRecord(step.params)) {
        errors.push(`${path}.params must be an object when provided`);
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
          if (typeof screen !== "string" || !ALL_SCREEN_IDS.includes(screen as typeof ALL_SCREEN_IDS[number])) {
            errors.push(`${path}.expectedScreen contains unknown screen: ${String(screen)}`);
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
        const uri = isRecord(step.params) ? step.params.uri : undefined;
        if (typeof uri !== "string" || uri.trim().length === 0) {
          errors.push(`${path}.params.uri is required for intent_send actions`);
        }
      }
      if (step.retries !== undefined && (typeof step.retries !== "number" || step.retries < 0)) {
        errors.push(`${path}.retries must be a non-negative number when provided`);
      }
      if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== "number" || step.timeoutMs < 1)) {
        errors.push(`${path}.timeoutMs must be a positive number when provided`);
      }
      break;
    case "wait":
      if (step.duration === undefined && step.condition === undefined) {
        errors.push(`${path} wait step must define duration or condition`);
      }
      if (step.duration !== undefined) {
        validateRangeObject(step.duration, `${path}.duration`, errors, ["uniform", "lognormal", "normal"]);
      }
      if (step.condition !== undefined && typeof step.condition !== "string") {
        errors.push(`${path}.condition must be a string when provided`);
      }
      break;
    case "condition":
      if (typeof step.check !== "string" || step.check.length === 0) {
        errors.push(`${path}.check must be a non-empty string for condition steps`);
      }
      if (step.probability !== undefined && (typeof step.probability !== "number" || step.probability < 0 || step.probability > 1)) {
        errors.push(`${path}.probability must be a number between 0 and 1 when provided`);
      }
      if (!Array.isArray(step.if_true) || step.if_true.length === 0) {
        errors.push(`${path}.if_true must be a non-empty step array`);
      } else {
        step.if_true.forEach((child, index) =>
          validateGeneratedWorkflowStepInput(child, `${path}.if_true[${index}]`, errors, seenIds)
        );
      }
      if (step.if_false !== undefined) {
        if (!Array.isArray(step.if_false)) {
          errors.push(`${path}.if_false must be a step array when provided`);
        } else {
          step.if_false.forEach((child, index) =>
            validateGeneratedWorkflowStepInput(child, `${path}.if_false[${index}]`, errors, seenIds)
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
          validateGeneratedWorkflowStepInput(child, `${path}.steps[${index}]`, errors, seenIds)
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
    allowedRecoveryRequests: string[];
    recoveryPolicy: WorkflowRecoveryPolicy | null;
    appMap?: GeneratedWorkflowAppMapCacheMetadata;
  };
  stepCount: number;
  actionCount: number;
  checkpointCount: number;
  maxDepth: number;
  llmBudget: {
    happyPathRequests: 0;
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
  if (!candidate.id || typeof candidate.id !== "string") errors.push("workflow.id must be a non-empty string");
  if (!candidate.name || typeof candidate.name !== "string") errors.push("workflow.name must be a non-empty string");
  if (!candidate.platform || typeof candidate.platform !== "string") {
    errors.push("workflow.platform must be a non-empty string");
  } else {
    const normalizedPlatform = normalizeGeneratedWorkflowPlatform(candidate.platform);
    if (!GENERATED_WORKFLOW_PLATFORMS.includes(normalizedPlatform as typeof GENERATED_WORKFLOW_PLATFORMS[number])) {
      errors.push(`workflow.platform must be one of: ${GENERATED_WORKFLOW_PLATFORMS.join(", ")}`);
    } else {
      candidate.platform = normalizedPlatform;
    }
  }
  if (!candidate.description || typeof candidate.description !== "string") errors.push("workflow.description must be a non-empty string");
  if (!candidate.version || typeof candidate.version !== "string") errors.push("workflow.version must be a non-empty string");
  if (candidate.intent !== undefined) {
    if (typeof candidate.intent !== "string" || !GENERATED_WORKFLOW_INTENTS.includes(candidate.intent as typeof GENERATED_WORKFLOW_INTENTS[number])) {
      errors.push(`workflow.intent must be one of: ${GENERATED_WORKFLOW_INTENTS.join(", ")}`);
    }
  }
  if (candidate.safetyClass !== undefined) {
    if (typeof candidate.safetyClass !== "string" || !GENERATED_WORKFLOW_SAFETY_CLASSES.includes(candidate.safetyClass as typeof GENERATED_WORKFLOW_SAFETY_CLASSES[number])) {
      errors.push(`workflow.safetyClass must be one of: ${GENERATED_WORKFLOW_SAFETY_CLASSES.join(", ")}`);
    }
  }
  if ((candidate.intent || candidate.outputSchema || candidate.allowedRecoveryRequests) && candidate.safetyClass !== "read_only") {
    errors.push("generated workflow marketing metadata requires workflow.safetyClass=read_only");
  }
  if (candidate.outputSchema !== undefined) {
    validateGeneratedWorkflowOutputSchema(candidate.outputSchema, "workflow.outputSchema", errors);
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
      validateGeneratedWorkflowStepInput(step, `workflow.steps[${index}]`, errors, seenIds)
    );
  }
  validateRedditAccountHealthIntent(candidate, errors);
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
    allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
    recoveryPolicy: template.recoveryPolicy ?? null,
    stepCount: template.steps.length,
    compiledPlan: options?.compiledPlan ?? compileGeneratedWorkflowTemplate(template),
  };
}

export function compileGeneratedWorkflowTemplate(template: WorkflowTemplate): GeneratedWorkflowCompiledPlan {
  const steps: GeneratedWorkflowCompiledStep[] = [];
  let actionCount = 0;
  let checkpointCount = 0;
  let maxDepth = 0;

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
        compiledStep.action = step.action;
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

      if (step.type === "condition") {
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
    allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
    recoveryPolicy: template.recoveryPolicy ?? null,
    defaultVerificationStrategy: template.defaultVerificationStrategy,
    steps: template.steps,
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
      allowedRecoveryRequests: template.allowedRecoveryRequests ?? [],
      recoveryPolicy: template.recoveryPolicy ?? null,
      appMap: undefined,
    },
    stepCount: steps.length,
    actionCount,
    checkpointCount,
    maxDepth,
    llmBudget: {
      happyPathRequests: 0,
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
    { type: "action", id: "open_reddit", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
    { type: "wait", id: "wait_home", condition: "app_launched", timeoutMs: 10000 },
    { type: "checkpoint", id: "home_loaded", reason: "App reached expected starting screen" },
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
      happyPathLlmRequests: 0,
      recovery: "LLM is reserved for recovery after deterministic execution fails.",
    },
    template: {
      required: ["id", "name", "platform", "description", "version", "steps"],
      optional: ["intent", "safetyClass", "outputSchema", "allowedRecoveryRequests", "recoveryPolicy", "defaultVerificationStrategy", "dataRetentionDays", "compatibleAppVersions"],
      platforms: GENERATED_WORKFLOW_PLATFORMS,
      intents: GENERATED_WORKFLOW_INTENTS,
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
      id: "agent_generated_reddit_open_home_v1",
      name: "Agent generated Reddit open home",
      platform: "reddit",
      description: "Minimal generated workflow contract example.",
      version: "1.0.0",
      intent: "reddit_account_health_scan",
      safetyClass: "read_only",
      outputSchema: {
        required: [...REDDIT_ACCOUNT_HEALTH_REQUIRED_OUTPUT],
        properties: {
          loggedIn: { type: "string" },
          homeFeedVisible: { type: "string" },
          searchSurfaceAvailable: { type: "string" },
          challengeDetected: { type: "string" },
          loginWallDetected: { type: "string" },
          accountSwitcherVisible: { type: "string" },
          observedUsername: { type: "string" },
          screenState: { type: "string" },
          error: { type: "string" },
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
