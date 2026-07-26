import crypto from "crypto";
import { getDb } from "../../db/client";
import { resourceLifecycleStateMatches } from "../lifecycle/lifecycle.service";
import type { ActionStep, WorkflowStep, WorkflowTemplate } from "../workflows/types";
import { uiGraphLearningLoop } from "./learning-loop";
import { uiGraphRepository } from "./repository";
import type { UiGraphContext, UiSafetyClass } from "./types";
import { persistStateSnapshot } from "./snapshot-replay.service";

export interface EdgeLearningBinding {
  bindingId: string;
  candidateId?: string;
  appId: string;
  actionStepIndex: number;
  verifiedStepIndex: number;
  stepId: string;
  verificationStepId: string;
  sourceStateId?: string | null;
  targetStateId?: string | null;
  payload: Record<string, unknown>;
  safetyClass: UiSafetyClass;
}

export interface EdgeLearningEvidence {
  bindingId: string;
  result: "success";
  checkpoint: number;
  verificationStepId: string;
  postState: Record<string, unknown>;
  actualTarget?: Record<string, unknown>;
}

interface CandidateRow {
  id: string;
  app_id: string;
  source_state_id: string | null;
  target_state_id?: string | null;
  payload: Record<string, unknown>;
  safety_class?: UiSafetyClass;
}

interface SelectorContextRow {
  state_id: string;
  element_key: string;
  strategy: string;
  selector: Record<string, unknown>;
  target_state_id: string | null;
  safety_class?: UiSafetyClass;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function selectorFromParts(strategy: string, value: unknown): { strategy: string; value: unknown } | null {
  if (strategy === "normalized_coords") {
    const coords = object(value);
    return finite(coords.x) && finite(coords.y) ? { strategy, value: { x: coords.x, y: coords.y } } : null;
  }
  return typeof value === "string" && value.trim() ? { strategy, value: value.trim() } : null;
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
  return selectorFromParts(String(payload.strategy ?? ""), payload.strategy === "normalized_coords" ? selector : selector.value);
}

function graphSelector(row: SelectorContextRow): { strategy: string; value: unknown } | null {
  const selector = object(row.selector);
  return selectorFromParts(row.strategy, row.strategy === "normalized_coords" ? selector : selector.value);
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

function compatibleGraphSelector(
  actual: { strategy: string; value: unknown },
  graph: { strategy: string; value: unknown },
): boolean {
  if (sameSelector(actual, graph)) return true;
  if (actual.strategy !== "resource_id" || graph.strategy !== "resource_id") return false;
  if (typeof actual.value !== "string" || typeof graph.value !== "string") return false;
  const leaf = (value: string): string => value.split(":id/").pop() ?? value;
  return leaf(actual.value) === leaf(graph.value);
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

function bindingId(input: {
  template: WorkflowTemplate;
  actionStepIndex: number;
  verifiedStepIndex: number;
  selector: { strategy: string; value: unknown };
}): string {
  const canonical = JSON.stringify({
    templateId: input.template.id,
    version: input.template.version,
    appId: input.template.platform,
    actionStepIndex: input.actionStepIndex,
    verifiedStepIndex: input.verifiedStepIndex,
    selector: input.selector,
  });
  return `elb_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function selectorPayload(
  step: ActionStep,
  selector: { strategy: string; value: unknown },
  context?: SelectorContextRow,
): Record<string, unknown> {
  const params = object(step.params);
  return {
    elementKey: context?.element_key
      ?? (typeof params.elementKey === "string" && params.elementKey.trim() ? params.elementKey.trim() : step.target ?? step.id ?? "unknown"),
    strategy: selector.strategy,
    selector: selector.strategy === "normalized_coords" ? object(selector.value) : { value: selector.value },
    priority: 100,
    dynamic: false,
  };
}

export function bindEdgeLearningCandidates(
  template: WorkflowTemplate,
  candidates: CandidateRow[],
  selectorContexts: SelectorContextRow[] = [],
): EdgeLearningBinding[] {
  const bindings: EdgeLearningBinding[] = [];
  template.steps.forEach((step, actionStepIndex) => {
    if (step.type !== "action") return;
    const selector = actionSelector(step);
    const verifiedStepIndex = selector ? verifiedBoundary(template.steps, actionStepIndex) : null;
    if (!selector || verifiedStepIndex === null || step.type !== "action") return;
    const candidate = candidates.find((row) => {
      const expected = candidateSelector(row);
      return expected ? sameSelector(selector, expected) : false;
    });
    const selectorContext = selectorContexts.find((row) => {
      const expected = graphSelector(row);
      return expected ? compatibleGraphSelector(selector, expected) : false;
    });
    const safetyClass = candidate?.safety_class ?? selectorContext?.safety_class;
    if (!safetyClass) return;
    const verifyStep = template.steps[verifiedStepIndex];
    bindings.push({
      bindingId: bindingId({ template, actionStepIndex, verifiedStepIndex, selector }),
      candidateId: candidate?.id,
      appId: candidate?.app_id ?? template.platform,
      actionStepIndex,
      verifiedStepIndex,
      stepId: step.id ?? `step_${actionStepIndex}`,
      verificationStepId: verifyStep.id ?? `step_${verifiedStepIndex}`,
      sourceStateId: candidate?.source_state_id ?? selectorContext?.state_id ?? null,
      targetStateId: candidate?.target_state_id ?? selectorContext?.target_state_id ?? null,
      payload: candidate?.payload ?? selectorPayload(step, selector, selectorContext),
      safetyClass,
    });
  });
  return bindings;
}

export function attachEdgeLearningBindings(template: WorkflowTemplate, bindings: EdgeLearningBinding[]): WorkflowTemplate {
  const clone = structuredClone(template);
  const byAction = new Map(bindings.map((item) => [item.actionStepIndex, item]));
  const byVerification = new Map<number, string[]>();
  for (const item of bindings) {
    byVerification.set(item.verifiedStepIndex, [...(byVerification.get(item.verifiedStepIndex) ?? []), item.bindingId]);
  }
  clone.steps = clone.steps.map((step, index) => {
    if (step.type === "action" && byAction.has(index)) {
      return { ...step, learningBindingId: byAction.get(index)!.bindingId };
    }
    if (step.type === "wait" && byVerification.has(index)) {
      return { ...step, learningBindingIds: byVerification.get(index)! };
    }
    return step;
  });
  return clone;
}

export async function prepareEdgeLearningBindings(template: WorkflowTemplate): Promise<EdgeLearningBinding[]> {
  const [candidates, selectorContexts] = await Promise.all([
    getDb().query(
      `SELECT candidate.id, candidate.app_id, candidate.source_state_id,
              candidate.target_state_id, candidate.payload, candidate.safety_class
         FROM ui_graph_learning_candidates candidate
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table=to_regclass('ui_graph_learning_candidates')
          AND binding.state_column='status'
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key=binding.lifecycle_key
          AND definition.status=candidate.status
        WHERE candidate.app_id = $1
          AND candidate_type = 'selector'
          AND NOT definition.terminal
          AND NOT definition.administrative
        ORDER BY candidate.success_count DESC, candidate.last_observed_at DESC`,
      [template.platform],
    ),
    getDb().query(
      `SELECT s.state_id, s.element_key, s.strategy, s.selector, st.safety_class,
              (SELECT t.target_state_id FROM ui_graph_transitions t
                WHERE t.app_id=$1 AND t.source_state_id=s.state_id AND t.element_key=s.element_key
                ORDER BY t.confidence DESC LIMIT 1) AS target_state_id
         FROM ui_graph_selectors s
         JOIN ui_graph_states st ON st.id=s.state_id
         JOIN lifecycle_resource_bindings binding
           ON binding.resource_table=to_regclass('ui_graph_selectors')
          AND binding.state_column='status'
         JOIN lifecycle_state_definitions definition
           ON definition.lifecycle_key=binding.lifecycle_key
          AND definition.status=s.status
        WHERE st.app_id=$1
          AND NOT definition.terminal
          AND NOT definition.administrative`,
      [template.platform],
    ).catch(() => ({ rows: [] })),
  ]);
  return bindEdgeLearningCandidates(
    template,
    candidates.rows as CandidateRow[],
    selectorContexts.rows as SelectorContextRow[],
  );
}

function bindingsFromVariables(variables: Record<string, unknown> | undefined): EdgeLearningBinding[] {
  const raw = variables?._edgeLearningBindings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is EdgeLearningBinding => {
    const value = object(item);
    return typeof value.bindingId === "string"
      && typeof value.appId === "string"
      && finite(value.actionStepIndex)
      && finite(value.verifiedStepIndex)
      && typeof value.stepId === "string"
      && typeof value.verificationStepId === "string"
      && Object.keys(object(value.payload)).length > 0;
  });
}

function evidenceFromVariables(variables: Record<string, unknown> | undefined): EdgeLearningEvidence[] {
  const raw = variables?._edgeLearningEvidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is EdgeLearningEvidence => {
    const value = object(item);
    const postState = object(value.postState);
    return typeof value.bindingId === "string"
      && value.result === "success"
      && finite(value.checkpoint)
      && typeof value.verificationStepId === "string"
      && postState.verified === true
      && typeof postState.outputHash === "string"
      && postState.outputHash.length > 0;
  });
}

function runtimeContext(
  variables: Record<string, unknown> | undefined,
  fallback: Partial<UiGraphContext>,
): UiGraphContext {
  const raw = object(variables?._runtimeContext);
  return {
    appId: String(raw.appId ?? fallback.appId ?? "android"),
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : null,
    appBuild: typeof raw.appBuild === "string" ? raw.appBuild : null,
    androidVersion: typeof raw.androidVersion === "string" ? raw.androidVersion : null,
    locale: typeof raw.locale === "string" ? raw.locale : null,
    deviceClass: typeof raw.deviceClass === "string" ? raw.deviceClass : null,
    deviceId: fallback.deviceId ?? null,
    workflowId: fallback.workflowId ?? null,
    branchKey: typeof raw.branchKey === "string" ? raw.branchKey : null,
    initialStateKey: typeof raw.initialStateKey === "string" ? raw.initialStateKey : null,
    finalStateKey: typeof variables?._lastObservedState === "string" ? variables._lastObservedState : null,
    recoveryCount: finite(raw.recoveryCount) ? raw.recoveryCount : 0,
  };
}

async function claimReceipt(
  workflowId: string,
  bindingIdValue: string,
  checkpoint: number,
  candidateId: string,
  outcome: string,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const result = await getDb().query(
    `INSERT INTO ui_graph_edge_learning_receipts
       (workflow_id, binding_id, checkpoint_key, candidate_id, outcome, evidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workflow_id, binding_id, checkpoint_key) DO NOTHING
     RETURNING candidate_id`,
    [workflowId, bindingIdValue, String(checkpoint), candidateId, outcome, JSON.stringify(evidence)],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function candidateForEvidence(
  binding: EdgeLearningBinding,
  input: { workflowId: string; deviceId: string },
  evidence: EdgeLearningEvidence,
): Promise<string> {
  if (binding.candidateId && !evidence.actualTarget) return binding.candidateId;
  const payload = evidence.actualTarget
    ? { ...binding.payload, ...evidence.actualTarget }
    : binding.payload;
  return uiGraphLearningLoop.observe({
    appId: binding.appId,
    type: "selector",
    sourceStateId: binding.sourceStateId ?? null,
    targetStateId: binding.targetStateId ?? null,
    payload,
    evidence: {
      source: "edge_workflow_hybrid",
      workflowId: input.workflowId,
      bindingId: binding.bindingId,
      postState: evidence.postState,
    },
    context: {
      appId: binding.appId,
      deviceId: input.deviceId,
      workflowId: input.workflowId,
      stepId: binding.stepId,
      currentStateId: binding.sourceStateId ?? null,
    },
    discoveryMethod: "ui_tree",
    confidence: 0.8,
    safetyClass: binding.safetyClass,
  });
}

async function validateAndMaybePromote(input: {
  workflowId: string;
  deviceId: string;
  binding: EdgeLearningBinding;
  candidateId: string;
  succeeded: boolean;
  checkpoint: number;
  evidence: Record<string, unknown>;
}): Promise<void> {
  const claimed = await claimReceipt(
    input.workflowId,
    input.binding.bindingId,
    input.checkpoint,
    input.candidateId,
    input.succeeded ? "success" : "failure",
    input.evidence,
  );
  if (!claimed) return;
  const context: UiGraphContext = {
    appId: input.binding.appId,
    deviceId: input.deviceId,
    workflowId: input.workflowId,
    stepId: input.binding.stepId,
    currentStateId: input.binding.sourceStateId ?? null,
  };
  try {
    const decision = await uiGraphLearningLoop.validate({
      candidateId: input.candidateId,
      context,
      success: input.succeeded,
      stateVerified: input.succeeded,
      evidence: input.evidence,
    });
    const flags = await uiGraphRepository.resolveFlags(context);
    if (input.succeeded && flags.autoPromotion && decision.autoPromotable) {
      await uiGraphLearningLoop.promote(
        input.candidateId,
        "edge_workflow_auto_promotion",
        "Five state-verified edge executions completed without failures",
        true,
      );
    }
  } catch (error) {
    await getDb().query(
      `DELETE FROM ui_graph_edge_learning_receipts
        WHERE workflow_id=$1 AND binding_id=$2 AND checkpoint_key=$3`,
      [input.workflowId, input.binding.bindingId, String(input.checkpoint)],
    ).catch(() => undefined);
    throw error;
  }
}

export async function reconcileEdgeLearningStatus(input: {
  workflowId: string;
  deviceId: string;
  status: string;
  currentStep: number;
  error?: string;
  variables?: Record<string, unknown>;
}): Promise<void> {
  const delta = {
    reused: 0,
    created: 0,
    validated: 0,
    promoted: 0,
    degraded: 0,
    snapshotsCaptured: 0,
  };
  const bindings = bindingsFromVariables(input.variables);
  const byId = new Map(bindings.map((item) => [item.bindingId, item]));
  const successfulBindings = new Set<string>();

  for (const reported of evidenceFromVariables(input.variables)) {
    const binding = byId.get(reported.bindingId);
    if (!binding || reported.verificationStepId !== binding.verificationStepId) continue;
    successfulBindings.add(binding.bindingId);
    const candidateId = await candidateForEvidence(binding, input, reported);
    delta.validated++;
    const evidence = {
      source: "edge_workflow_hybrid",
      workflowId: input.workflowId,
      bindingId: binding.bindingId,
      stepId: binding.stepId,
      verificationStepId: binding.verificationStepId,
      checkpoint: reported.checkpoint,
      postState: reported.postState,
      actualTarget: reported.actualTarget ?? null,
    };
    await validateAndMaybePromote({
      workflowId: input.workflowId,
      deviceId: input.deviceId,
      binding,
      candidateId,
      succeeded: true,
      checkpoint: reported.checkpoint,
      evidence,
    });
  }

  const transitionTelemetry = Array.isArray(input.variables?._transitionTelemetry)
    ? input.variables?._transitionTelemetry as unknown[]
    : [];
  for (const raw of transitionTelemetry) {
    const transition = object(raw);
    if (transition.postconditionVerified !== true) continue;
    const sourceState = typeof transition.sourceState === "string" ? transition.sourceState : "";
    const targetState = typeof transition.targetState === "string" ? transition.targetState : "";
    const action = typeof transition.action === "string" ? transition.action : "";
    if (!sourceState || !targetState || !action) continue;
    const transitionKey = `${sourceState}__${action}__${targetState}`;
    const bindingKey = `transition:${transitionKey}:${Number(transition.iteration ?? 0)}`;
    const context = runtimeContext(input.variables, {
      appId: String(object(input.variables?._runtimeContext).appId ?? "android"),
      deviceId: input.deviceId,
      workflowId: input.workflowId,
    });
    context.branchKey = typeof transition.branchKey === "string" ? transition.branchKey : transitionKey;
    context.initialStateKey = sourceState;
    context.finalStateKey = targetState;
    const states = await getDb().query(
      `SELECT id, state_key FROM ui_graph_states WHERE app_id=$1 AND state_key = ANY($2::text[])`,
      [context.appId, [sourceState, targetState]],
    );
    const stateIds = new Map(states.rows.map((row) => [String(row.state_key), String(row.id)]));
    if (!stateIds.has(sourceState) || !stateIds.has(targetState)) {
      for (const stateKey of [sourceState, targetState]) {
        if (stateIds.has(stateKey)) continue;
        await uiGraphLearningLoop.observe({
          appId: context.appId,
          type: "state",
          payload: { stateKey, kind: "screen", observedFromStateMachine: true },
          evidence: { workflowId: input.workflowId, transition },
          context,
          discoveryMethod: "ui_tree",
          confidence: 0.75,
          safetyClass: "read_only",
        });
        delta.created++;
      }
      continue;
    }
    const candidateId = await uiGraphLearningLoop.observe({
      appId: context.appId,
      type: "transition",
      sourceStateId: stateIds.get(sourceState),
      targetStateId: stateIds.get(targetState),
      payload: {
        transitionKey,
        action: { action },
        preconditions: { state: sourceState },
        postconditions: { state: targetState },
        cost: 1,
      },
      evidence: { workflowId: input.workflowId, telemetry: transition },
      context,
      discoveryMethod: "ui_tree",
      confidence: 0.85,
      safetyClass: "navigation",
    });
    const claimed = await claimReceipt(
      input.workflowId,
      bindingKey,
      Number(transition.iteration ?? 0),
      candidateId,
      "success",
      transition,
    );
    if (!claimed) {
      delta.reused++;
      continue;
    }
    delta.created++;
    const decision = await uiGraphLearningLoop.validate({
      candidateId,
      context,
      success: true,
      stateVerified: true,
      evidence: { workflowId: input.workflowId, transition },
    });
    delta.validated++;
    const flags = await uiGraphRepository.resolveFlags(context);
    if (flags.autoPromotion && decision.autoPromotable) {
      await uiGraphLearningLoop.promote(
        candidateId,
        "edge_state_machine_auto_promotion",
        "Cross-device and cross-branch state transition coverage verified",
        true,
      );
      delta.promoted++;
    }
  }

  const snapshot = object(input.variables?._stateReplaySnapshot);
  if (typeof snapshot.uiTree === "string" && snapshot.uiTree.trim()
      && typeof snapshot.stateKey === "string" && snapshot.stateKey.trim()) {
    const context = runtimeContext(input.variables, {
      appId: String(snapshot.appId ?? "android"),
      deviceId: input.deviceId,
      workflowId: input.workflowId,
    });
    await persistStateSnapshot({
      appId: context.appId,
      stateKey: snapshot.stateKey,
      uiTree: snapshot.uiTree,
      appVersion: context.appVersion,
      androidVersion: context.androidVersion,
      locale: context.locale,
      deviceClass: context.deviceClass,
      deviceId: input.deviceId,
      workflowId: input.workflowId,
      branchKey: typeof snapshot.branchKey === "string" ? snapshot.branchKey : context.branchKey,
      source: "edge_workflow",
      metadata: { status: input.status, uiTreeHash: snapshot.uiTreeHash ?? null },
    });
    delta.snapshotsCaptured++;
  }

  const workflowFailed = await resourceLifecycleStateMatches(
    "workflows",
    input.status,
    { terminal: true, retryable: true },
  );
  for (const binding of bindings) {
    if (!binding.candidateId || successfulBindings.has(binding.bindingId)) continue;
    const failed = workflowFailed
      && input.currentStep >= binding.actionStepIndex
      && input.currentStep <= binding.verifiedStepIndex;
    if (!failed) continue;
    const evidence = {
      source: "edge_workflow_hybrid",
      workflowId: input.workflowId,
      bindingId: binding.bindingId,
      stepId: binding.stepId,
      currentStep: input.currentStep,
      status: input.status,
      error: input.error ?? null,
    };
    await validateAndMaybePromote({
      workflowId: input.workflowId,
      deviceId: input.deviceId,
      binding,
      candidateId: binding.candidateId,
      succeeded: false,
      checkpoint: binding.verifiedStepIndex,
      evidence,
    });
    delta.validated++;
  }
  if (input.variables) input.variables._learningDelta = delta;
}
