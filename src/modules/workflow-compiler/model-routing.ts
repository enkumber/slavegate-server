import type { CompiledWorkflow } from "./types";

export const LEGACY_CODEX_MODEL = "openai-codex/gpt-5.5";

export function canonicalModelOverride(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === LEGACY_CODEX_MODEL) return undefined;
  return trimmed;
}

export function canonicalizeCompiledWorkflow(raw: unknown): CompiledWorkflow {
  const workflow = raw as CompiledWorkflow;
  const recoveryModel = canonicalModelOverride(workflow.recoveryModel);
  if (recoveryModel) {
    workflow.recoveryModel = recoveryModel;
  } else {
    delete workflow.recoveryModel;
  }
  return workflow;
}
