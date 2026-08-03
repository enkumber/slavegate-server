import type { WorkflowTemplate } from "../workflows/types";

const POLICY_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const EXECUTABLE_STEP_TYPES = new Set(["action", "wait", "condition", "loop", "checkpoint"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function executableStructureErrors(steps: unknown, path: string): string[] {
  if (!Array.isArray(steps)) return [`${path} must be a workflow step array`];

  const errors: string[] = [];
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (!isRecord(step)) {
      errors.push(`${stepPath} must be an object`);
      return;
    }

    if (typeof step.type !== "string" || !EXECUTABLE_STEP_TYPES.has(step.type)) {
      errors.push(`${stepPath}.type must be a valid executable step discriminator`);
      return;
    }

    if (step.type === "action") {
      if (typeof step.action !== "string" || step.action.length === 0) {
        errors.push(`${stepPath}.action must be a non-empty string for action steps`);
      }
      if (step.onFailureSteps !== undefined) {
        errors.push(...executableStructureErrors(step.onFailureSteps, `${stepPath}.onFailureSteps`));
      }
    } else if (step.type === "wait" && step.until !== undefined) {
      if (!isRecord(step.until) || typeof step.until.action !== "string" || step.until.action.length === 0) {
        errors.push(`${stepPath}.until.action must be a non-empty string when provided`);
      }
    } else if (step.type === "condition") {
      errors.push(...executableStructureErrors(step.if_true, `${stepPath}.if_true`));
      if (step.if_false !== undefined) {
        errors.push(...executableStructureErrors(step.if_false, `${stepPath}.if_false`));
      }
    } else if (step.type === "loop") {
      errors.push(...executableStructureErrors(step.steps, `${stepPath}.steps`));
    }
  });
  return errors;
}

/**
 * Runtime normalization is intentionally application-agnostic.
 * Packages, URLs, selectors and routes are authored in PostgreSQL/App Maps or
 * in the compiled workflow itself; changing them must never require a release.
 */
export function normalizeCachedHumanWorkflowTemplate(
  workflow: WorkflowTemplate,
  _sourceMetadata: Record<string, unknown> | null | undefined,
): WorkflowTemplate {
  const errors = executableStructureErrors((workflow as { steps?: unknown }).steps, "workflow.steps");
  if (errors.length > 0) {
    throw Object.assign(
      new Error(`cached workflow has invalid executable structure: ${errors.join("; ")}`),
      {
        status: 409,
        code: "CACHED_WORKFLOW_EXECUTABLE_STRUCTURE_INVALID",
        validationErrors: errors,
      },
    );
  }
  return workflow;
}

/**
 * Safety classes are opaque PostgreSQL-owned policy identifiers. Runtime code
 * must preserve them exactly, reject missing/invalid values, and fail closed
 * when cached artifact projections disagree.
 */
export function resolveCachedWorkflowSafetyClass(
  cached: Record<string, unknown>,
): string {
  const workflow = cached.workflow as Record<string, unknown> | null | undefined;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as
    | Record<string, unknown>
    | null
    | undefined;
  const compiledMetadata = compiledPlan?.metadata as
    | Record<string, unknown>
    | null
    | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as
    | Record<string, unknown>
    | null
    | undefined;
  const declared = [
    workflow?.safetyClass,
    compiledMetadata?.safetyClass,
    sourceMetadata?.safetyClass,
  ].filter((value): value is string => value !== undefined && value !== null);

  if (declared.length === 0) {
    throw Object.assign(new Error("cached workflow has no explicit safety class"), {
      status: 409,
      code: "WORKFLOW_SAFETY_CLASS_REQUIRED",
    });
  }
  if (declared.some((value) => !POLICY_IDENTIFIER_RE.test(value))) {
    throw Object.assign(new Error("cached workflow has an invalid safety class"), {
      status: 409,
      code: "WORKFLOW_SAFETY_CLASS_INVALID",
    });
  }
  const distinct = new Set(declared);
  if (distinct.size !== 1) {
    throw Object.assign(new Error("cached workflow safety class projections disagree"), {
      status: 409,
      code: "WORKFLOW_SAFETY_CLASS_CONFLICT",
    });
  }
  return declared[0];
}
