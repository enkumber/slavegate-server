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
  WorkflowPostconditionContract,
  WorkflowRecoveryPolicy,
  WorkflowStep,
  WorkflowTemplate,
} from "./types";
import { parseWorkflowGoalContract, workflowGoalContractReason } from "./goal-contract";

// ── Zod schemas ─────────────────────────────────────────────────────────────
const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,199}$/),
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

function validateWorkflowPostconditionContract(
  value: unknown,
  path: string,
  errors: string[],
): WorkflowPostconditionContract | null {
  if (!isRecord(value) || value.version !== "1" || !Array.isArray(value.all) || value.all.length === 0) {
    errors.push(`${path} must be a version 1 contract with non-empty all[]`);
    return null;
  }
  value.all.forEach((predicate, index) => {
    const predicatePath = `${path}.all[${index}]`;
    if (!isRecord(predicate) || !isRecord(predicate.left)) {
      errors.push(`${predicatePath}.left must be a value reference`);
      return;
    }
    if (typeof predicate.operator !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(predicate.operator)) {
      errors.push(`${predicatePath}.operator is invalid`);
    }
    for (const [name, reference] of [["left", predicate.left], ["right", predicate.right]] as const) {
      if (name === "right" && reference === undefined) continue;
      if (!isRecord(reference)) {
        errors.push(`${predicatePath}.${name} must be a value reference`);
        continue;
      }
      const hasPath = typeof reference.path === "string" && reference.path.length > 0;
      const hasValue = Object.prototype.hasOwnProperty.call(reference, "value");
      if (hasPath === hasValue) errors.push(`${predicatePath}.${name} must contain exactly one of path or value`);
      if (hasPath && !/^[a-zA-Z0-9_.-]+$/.test(String(reference.path))) {
        errors.push(`${predicatePath}.${name}.path is invalid`);
      }
    }
  });
  return errors.some((error) => error.startsWith(path)) ? null : value as unknown as WorkflowPostconditionContract;
}

export function workflowPostconditionContractErrors(value: unknown): string[] {
  const errors: string[] = [];
  validateWorkflowPostconditionContract(value, "postconditionContract", errors);
  return errors;
}

export function workflowOutputSchemaErrors(value: unknown): string[] {
  const errors: string[] = [];
  validateGeneratedWorkflowOutputSchema(value, "outputSchema", errors);
  return errors;
}

function validateGeneratedWorkflowGoalSemantics(
  candidate: Partial<WorkflowTemplate>,
  errors: string[]
): void {
  if (candidate.goalContract) {
    const reason = workflowGoalContractReason(candidate as WorkflowTemplate);
    if (reason) errors.push(`workflow goal contract violation: ${reason}`);
  }
}

function validateRangeObject(
  value: unknown,
  path: string,
  errors: string[],
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
  if (
    typeof value.distribution !== "string"
    || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(value.distribution)
  ) {
    errors.push(`${path}.distribution must be a safe runtime-contract identifier`);
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
      if (typeof step.action !== "string" || step.action.length === 0) {
        errors.push(`${path}.action must be a non-empty string for action steps`);
      } else if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(step.action)) {
        errors.push(`${path}.action must be a safe runtime-contract identifier`);
      }
      if (step.params !== undefined && !isRecord(step.params)) {
        errors.push(`${path}.params must be an object when provided`);
      }
      if (step.goalStage !== undefined && (typeof step.goalStage !== "string" || !step.goalStage.trim())) {
        errors.push(`${path}.goalStage must be a non-empty string when provided`);
      }
      if (
        step.effect !== undefined
        && (typeof step.effect !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(step.effect))
      ) {
        errors.push(`${path}.effect is invalid`);
      }
      if (step.x !== undefined && typeof step.x !== "number") {
        errors.push(`${path}.x must be a number when provided`);
      }
      if (step.y !== undefined && typeof step.y !== "number") {
        errors.push(`${path}.y must be a number when provided`);
      }
      if (
        step.verification !== undefined &&
        (typeof step.verification !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(step.verification))
      ) {
        errors.push(`${path}.verification must be a safe runtime policy identifier`);
      }
      if (step.expectedScreen !== undefined) {
        const screens = Array.isArray(step.expectedScreen) ? step.expectedScreen : [step.expectedScreen];
        for (const screen of screens) {
          if (typeof screen !== "string" || !screen.trim()) {
            errors.push(`${path}.expectedScreen must contain non-empty state identifiers`);
          }
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
      if (step.failureOpcode !== undefined
        && (typeof step.failureOpcode !== "number"
          || !Number.isSafeInteger(step.failureOpcode)
          || step.failureOpcode < 0)) {
        errors.push(`${path}.failureOpcode must be a non-negative integer`);
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
        validateRangeObject(step.duration, `${path}.duration`, errors);
      }
      if (step.condition !== undefined && typeof step.condition !== "string") {
        errors.push(`${path}.condition must be a string when provided`);
      }
      if (step.until !== undefined) {
        if (!isRecord(step.until)) {
          errors.push(`${path}.until must be an object when provided`);
        } else {
          if (typeof step.until.action !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(step.until.action)) {
            errors.push(`${path}.until.action must be a safe runtime-contract identifier`);
          }
          if (step.until.params !== undefined && !isRecord(step.until.params)) {
            errors.push(`${path}.until.params must be an object when provided`);
          }
          if (
            typeof step.until.operator !== "string"
            || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(step.until.operator)
          ) {
            errors.push(`${path}.until.operator must be a safe runtime-contract identifier`);
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
      validateRangeObject(step.count, `${path}.count`, errors);
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
    (typeof candidate.autonomy !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(candidate.autonomy))
  ) {
    errors.push(`${path}.autonomy must be a safe policy identifier`);
  }
  if (candidate.aiRecoveryEnabled !== undefined && typeof candidate.aiRecoveryEnabled !== "boolean") {
    errors.push(`${path}.aiRecoveryEnabled must be a boolean`);
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
        if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(recoveryRequest)) {
          errors.push(`${path}.allowedRecoveryRequests must contain safe policy identifiers`);
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
    safetyClass: string | null;
    outputSchema: WorkflowOutputSchema | null;
    postconditionContract: WorkflowPostconditionContract | null;
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
  if (
    candidate.runtimeContract !== undefined
    && (
      typeof candidate.runtimeContract !== "string"
      || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(candidate.runtimeContract)
    )
  ) {
    errors.push("workflow.runtimeContract must be a safe non-empty contract identifier when provided");
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
    if (
      typeof candidate.safetyClass !== "string"
      || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(candidate.safetyClass)
    ) {
      errors.push("workflow.safetyClass must be a safe non-empty policy identifier");
    }
  }
  if (candidate.outputSchema !== undefined) {
    validateGeneratedWorkflowOutputSchema(candidate.outputSchema, "workflow.outputSchema", errors);
  }
  if (candidate.postconditionContract !== undefined) {
    validateWorkflowPostconditionContract(candidate.postconditionContract, "workflow.postconditionContract", errors);
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
        if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(recoveryRequest)) {
          errors.push("workflow.allowedRecoveryRequests must contain safe policy identifiers");
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
    (
      typeof candidate.defaultVerificationStrategy !== "string"
      || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(candidate.defaultVerificationStrategy)
    )
  ) {
    errors.push("workflow.defaultVerificationStrategy must be a safe runtime policy identifier");
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
  validateGeneratedWorkflowGoalSemantics(candidate, errors);

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
    postconditionContract: template.postconditionContract ?? null,
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
        if (isRecord(step.params) && typeof step.params.prompt === "string") explicitLlmRequests++;
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
    postconditionContract: template.postconditionContract ?? null,
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
      postconditionContract: template.postconditionContract ?? null,
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
      safetyClasses: "catalog_managed",
      allowedRecoveryRequests: "catalog_managed",
      recoveryAutonomy: "catalog_managed",
      defaultVerificationStrategy: "catalog_managed",
      stepTypes: "catalog_managed",
    },
    steps: {
      action: {
        required: ["type", "action"],
        optional: ["id", "target", "x", "y", "params", "verification", "retries", "timeoutMs", "expectedScreen"],
        allowedActions: "runtime_contract_managed",
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
  };
}
