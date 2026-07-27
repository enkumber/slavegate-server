import { getDb } from "../../db/client";
import type { WorkflowStep, WorkflowTemplate } from "./types";

interface RuntimeContractRecord {
  contract_id: string;
  schema_version: number;
  allowed_actions: unknown;
  limits: unknown;
  active: boolean;
}

function collectActions(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectActions(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "action" && typeof nested === "string") output.push(nested);
    else collectActions(nested, output);
  }
  return output;
}

function countSteps(steps: WorkflowStep[]): number {
  let count = 0;
  for (const step of steps) {
    count += 1;
    if (step.type === "action" && step.onFailureSteps) count += countSteps(step.onFailureSteps);
    if (step.type === "condition") count += countSteps(step.if_true) + countSteps(step.if_false ?? []);
    if (step.type === "loop") count += countSteps(step.steps);
  }
  return count;
}

export async function assertOperationalRuntimeContract(template: WorkflowTemplate): Promise<void> {
  if (!template.runtimeContract) {
    const error = new Error("Workflow has no configured runtime contract");
    (error as Error & { code?: string; status?: number }).code = "WORKFLOW_RECOMPILE_REQUIRED";
    (error as Error & { code?: string; status?: number }).status = 409;
    throw error;
  }

  const result = await getDb().query<RuntimeContractRecord>(
    `SELECT contract_id, schema_version, allowed_actions, limits, active
       FROM workflow_runtime_contracts
      WHERE contract_id = $1
      LIMIT 1`,
    [template.runtimeContract],
  );
  const contract = result.rows[0];
  if (!contract || !contract.active) {
    const error = new Error(`Runtime contract is missing or inactive: ${template.runtimeContract}`);
    (error as Error & { code?: string }).code = "RUNTIME_CONTRACT_INACTIVE";
    throw error;
  }

  const allowed = new Set(
    Array.isArray(contract.allowed_actions)
      ? contract.allowed_actions.filter((value): value is string => typeof value === "string")
      : [],
  );
  const unknownActions = [...new Set(collectActions(template.steps).filter((action) => !allowed.has(action)))];
  if (unknownActions.length > 0) {
    const error = new Error(`Workflow uses actions disabled by ${template.runtimeContract}: ${unknownActions.join(", ")}`);
    (error as Error & { code?: string; status?: number }).code = "RUNTIME_CONTRACT_ACTION_DISABLED";
    (error as Error & { code?: string; status?: number }).status = 409;
    throw error;
  }

  const limits = contract.limits && typeof contract.limits === "object" && !Array.isArray(contract.limits)
    ? contract.limits as Record<string, unknown>
    : {};
  const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 500;
  const stepCount = countSteps(template.steps);
  if (stepCount > maxSteps) {
    const error = new Error(`Workflow has ${stepCount} steps; runtime contract limit is ${maxSteps}`);
    (error as Error & { code?: string }).code = "RUNTIME_CONTRACT_STEP_LIMIT";
    throw error;
  }
}
