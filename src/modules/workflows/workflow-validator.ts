/**
 * workflow-validator.ts
 * Zod schema + semantic validation for dynamic workflow dispatch.
 */

import { z } from "zod";
import { createHash } from "crypto";
import type { WorkflowStep, WorkflowTemplate } from "./types";
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
  "open_app",
  "press_key",
  "screen_wake",
  "screenshot",
  "scroll",
  "swipe",
  "ui_tree_dump",
  "unlock",
  "wait_for_idle",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedWorkflowPlatform(platform: string): string {
  return platform.trim().toLowerCase();
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
}

export interface GeneratedWorkflowCompiledPlan {
  planVersion: "generated-workflow-plan/v1";
  cacheKey: string;
  templateId: string;
  platform: string;
  templateVersion: string;
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
      optional: ["defaultVerificationStrategy", "dataRetentionDays", "compatibleAppVersions"],
      platforms: GENERATED_WORKFLOW_PLATFORMS,
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
      defaultVerificationStrategy: "local_with_screenshot",
      dataRetentionDays: 7,
      steps: exampleSteps,
    },
  };
}
