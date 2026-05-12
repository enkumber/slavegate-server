/**
 * workflow-validator.ts
 * Zod schema + semantic validation for dynamic workflow dispatch.
 */

import { z } from "zod";

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
