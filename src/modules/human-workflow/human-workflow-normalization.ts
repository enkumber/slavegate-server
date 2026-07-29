import type { WorkflowTemplate } from "../workflows/types";

const POLICY_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

/**
 * Runtime normalization is intentionally application-agnostic.
 * Packages, URLs, selectors and routes are authored in PostgreSQL/App Maps or
 * in the compiled workflow itself; changing them must never require a release.
 */
export function normalizeCachedHumanWorkflowTemplate(
  workflow: WorkflowTemplate,
  _sourceMetadata: Record<string, unknown> | null | undefined,
): WorkflowTemplate {
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
