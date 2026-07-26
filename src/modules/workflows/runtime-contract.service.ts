import { getDb } from "../../db/client";
import type { WorkflowStep, WorkflowTemplate } from "./types";

interface RuntimeContractRecord {
  contract_id: string;
  schema_version: number;
  allowed_actions: unknown;
  limits: unknown;
  active: boolean;
}

function collectActions(steps: WorkflowStep[], output: string[] = []): string[] {
  for (const step of steps) {
    if (step.type === "action") {
      output.push(step.action);
      if (step.action === "observe_and_transition") {
        const postcondition = step.params?.postcondition;
        if (postcondition && typeof postcondition === "object" && !Array.isArray(postcondition)) {
          const action = (postcondition as Record<string, unknown>).action;
          if (typeof action === "string") output.push(action);
        }
      }
      if (step.action === "run_state_machine") {
        const transitions = step.params?.transitions;
        if (transitions && typeof transitions === "object" && !Array.isArray(transitions)) {
          for (const transition of Object.values(transitions as Record<string, unknown>)) {
            if (!transition || typeof transition !== "object" || Array.isArray(transition)) continue;
            const action = (transition as Record<string, unknown>).action;
            if (typeof action === "string") output.push(action);
            const postcondition = (transition as Record<string, unknown>).params;
            if (postcondition && typeof postcondition === "object" && !Array.isArray(postcondition)) {
              const nested = (postcondition as Record<string, unknown>).postcondition;
              if (nested && typeof nested === "object" && !Array.isArray(nested)) {
                const nestedAction = (nested as Record<string, unknown>).action;
                if (typeof nestedAction === "string") output.push(nestedAction);
              }
            }
          }
        }
      }
      if (step.onFailureSteps) collectActions(step.onFailureSteps, output);
    } else if (step.type === "wait" && step.until) {
      output.push(step.until.action);
    } else if (step.type === "condition") {
      collectActions(step.if_true, output);
      if (step.if_false) collectActions(step.if_false, output);
    } else if (step.type === "loop") {
      collectActions(step.steps, output);
    }
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
