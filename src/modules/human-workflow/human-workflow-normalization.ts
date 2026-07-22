import type { WorkflowTemplate } from "../workflows/types";

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
