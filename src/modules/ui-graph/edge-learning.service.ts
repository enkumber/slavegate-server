import { getDb } from "../../db/client";
import type { WorkflowStep, WorkflowTemplate } from "../workflows/types";
import { uiGraphLearningLoop } from "./learning-loop";
import { uiGraphRepository } from "./repository";
import type { UiGraphContext } from "./types";

export interface EdgeLearningBinding {
  candidateId: string;
  appId: string;
  actionStepIndex: number;
  verifiedStepIndex: number;
  stepId: string;
  sourceStateId?: string | null;
}

interface CandidateRow {
  id: string;
  app_id: string;
  source_state_id: string | null;
  payload: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function actionSelector(step: WorkflowStep): { strategy: string; value: unknown } | null {
  if (step.type !== "action") return null;
  const params = object(step.params);
  if (typeof params.resourceId === "string" && params.resourceId.trim()) {
    return { strategy: "resource_id", value: params.resourceId.trim() };
  }
  if (typeof params.contentDescription === "string" && params.contentDescription.trim()) {
    return { strategy: "content_description", value: params.contentDescription.trim() };
  }
  if (typeof params.text === "string" && params.text.trim()) {
    return { strategy: "text", value: params.text.trim() };
  }
  const x = finite(params.x) ? params.x : finite(step.x) ? step.x : null;
  const y = finite(params.y) ? params.y : finite(step.y) ? step.y : null;
  return x !== null && y !== null
    ? { strategy: "normalized_coords", value: { x, y } }
    : null;
}

function candidateSelector(candidate: CandidateRow): { strategy: string; value: unknown } | null {
  const payload = object(candidate.payload);
  const selector = object(payload.selector);
  const strategy = typeof payload.strategy === "string" ? payload.strategy : "";
  if (!strategy) return null;
  if (strategy === "normalized_coords") {
    return finite(selector.x) && finite(selector.y)
      ? { strategy, value: { x: selector.x, y: selector.y } }
      : null;
  }
  return typeof selector.value === "string" && selector.value.trim()
    ? { strategy, value: selector.value.trim() }
    : null;
}

function sameSelector(left: { strategy: string; value: unknown }, right: { strategy: string; value: unknown }): boolean {
  if (left.strategy !== right.strategy) return false;
  if (typeof left.value === "string" || typeof right.value === "string") return left.value === right.value;
  const a = object(left.value);
  const b = object(right.value);
  return finite(a.x) && finite(a.y) && finite(b.x) && finite(b.y)
    && Math.abs(a.x - b.x) <= 0.0001
    && Math.abs(a.y - b.y) <= 0.0001;
}

function verifiedBoundary(steps: WorkflowStep[], actionIndex: number): number | null {
  let lastVerification: number | null = null;
  for (let index = actionIndex + 1; index < steps.length; index++) {
    const step = steps[index];
    if (step.type === "action" || step.type === "condition" || step.type === "loop") break;
    if (step.type === "wait" && step.until?.action === "ui_tree_dump") lastVerification = index;
  }
  return lastVerification;
}

export function bindEdgeLearningCandidates(
  template: WorkflowTemplate,
  candidates: CandidateRow[],
): EdgeLearningBinding[] {
  const used = new Set<string>();
  const bindings: EdgeLearningBinding[] = [];
  template.steps.forEach((step, actionStepIndex) => {
    const selector = actionSelector(step);
    const verifiedStepIndex = selector ? verifiedBoundary(template.steps, actionStepIndex) : null;
    if (!selector || verifiedStepIndex === null) return;
    const candidate = candidates.find((row) => {
      if (used.has(row.id)) return false;
      const expected = candidateSelector(row);
      return expected ? sameSelector(selector, expected) : false;
    });
    if (!candidate) return;
    used.add(candidate.id);
    bindings.push({
      candidateId: candidate.id,
      appId: candidate.app_id,
      actionStepIndex,
      verifiedStepIndex,
      stepId: step.id ?? `step_${actionStepIndex}`,
      sourceStateId: candidate.source_state_id,
    });
  });
  return bindings;
}

export async function prepareEdgeLearningBindings(template: WorkflowTemplate): Promise<EdgeLearningBinding[]> {
  const result = await getDb().query(
    `SELECT id, app_id, source_state_id, payload
       FROM ui_graph_learning_candidates
      WHERE app_id = $1
        AND candidate_type = 'selector'
        AND status IN ('candidate', 'validating', 'promoted', 'degraded')
      ORDER BY success_count DESC, last_observed_at DESC`,
    [template.platform],
  );
  return bindEdgeLearningCandidates(template, result.rows as CandidateRow[]);
}

function bindingsFromVariables(variables: Record<string, unknown> | undefined): EdgeLearningBinding[] {
  const raw = variables?._edgeLearningBindings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is EdgeLearningBinding => {
    const value = object(item);
    return typeof value.candidateId === "string"
      && typeof value.appId === "string"
      && finite(value.actionStepIndex)
      && finite(value.verifiedStepIndex)
      && typeof value.stepId === "string";
  });
}

async function claimReceipt(
  workflowId: string,
  candidateId: string,
  outcome: "success" | "failure",
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const result = await getDb().query(
    `INSERT INTO ui_graph_edge_learning_receipts (workflow_id, candidate_id, outcome, evidence)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workflow_id, candidate_id) DO NOTHING
     RETURNING candidate_id`,
    [workflowId, candidateId, outcome, JSON.stringify(evidence)],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

export async function reconcileEdgeLearningStatus(input: {
  workflowId: string;
  deviceId: string;
  status: string;
  currentStep: number;
  error?: string;
  variables?: Record<string, unknown>;
}): Promise<void> {
  const bindings = bindingsFromVariables(input.variables);
  for (const binding of bindings) {
    const succeeded = input.currentStep > binding.verifiedStepIndex;
    const failed = input.status === "failed"
      && input.currentStep >= binding.actionStepIndex
      && input.currentStep <= binding.verifiedStepIndex;
    if (!succeeded && !failed) continue;

    const outcome = succeeded ? "success" : "failure";
    const evidence = {
      source: "edge_workflow",
      workflowId: input.workflowId,
      stepId: binding.stepId,
      actionStepIndex: binding.actionStepIndex,
      verifiedStepIndex: binding.verifiedStepIndex,
      currentStep: input.currentStep,
      status: input.status,
      error: input.error ?? null,
    };
    const claimed = await claimReceipt(input.workflowId, binding.candidateId, outcome, evidence);
    if (!claimed) continue;

    const context: UiGraphContext = {
      appId: binding.appId,
      deviceId: input.deviceId,
      workflowId: input.workflowId,
      stepId: binding.stepId,
      currentStateId: binding.sourceStateId ?? null,
    };
    try {
      const decision = await uiGraphLearningLoop.validate({
        candidateId: binding.candidateId,
        context,
        success: succeeded,
        stateVerified: succeeded,
        evidence,
      });
      const flags = await uiGraphRepository.resolveFlags(context);
      if (succeeded && flags.autoPromotion && decision.autoPromotable) {
        await uiGraphLearningLoop.promote(
          binding.candidateId,
          "edge_workflow_auto_promotion",
          "Five state-verified edge executions completed without failures",
          true,
        );
      }
    } catch (error) {
      await getDb().query(
        `DELETE FROM ui_graph_edge_learning_receipts WHERE workflow_id=$1 AND candidate_id=$2`,
        [input.workflowId, binding.candidateId],
      ).catch(() => undefined);
      throw error;
    }
  }
}
