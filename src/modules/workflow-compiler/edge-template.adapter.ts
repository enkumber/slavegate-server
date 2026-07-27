import { loadMap } from "../app-mapping/recorder.service";
import { getDb } from "../../db/client";
import type { AppMap, ElementDef, PageDef } from "../app-mapping/schema";
import type { ActionStep, WaitStep, WorkflowStep, WorkflowTemplate } from "../workflows/types";
import type { CompiledStep, CompiledWorkflow } from "./types";

interface CompiledWorkflowEdgePolicy {
  runtimeContract: string;
  verificationStrategy: string;
  dataRetentionDays: number;
  stepTimeoutMs: number;
  actionRetries: number;
  actionRetryDelayMs: number;
  stateObservation: {
    actionKey: string;
    outputPath: string;
    containsOperator: string;
    excludesOperator: string;
    pollIntervalMs: number;
    timeoutMs: number;
  };
}

async function loadCompiledWorkflowEdgePolicy(): Promise<CompiledWorkflowEdgePolicy> {
  const result = await getDb().query<{ policy: unknown }>(
    `SELECT entry.payload->'compiledWorkflowEdgePolicy' AS policy
       FROM runtime_semantic_entries entry
       JOIN lifecycle_state_definitions definition
         ON definition.lifecycle_key = entry.lifecycle_key
        AND definition.status = entry.status
      WHERE definition.dispatchable
        AND entry.payload ? 'compiledWorkflowEdgePolicy'
      ORDER BY entry.priority DESC, entry.id`,
  );
  if (result.rows.length !== 1) {
    throw new Error("PostgreSQL compiled workflow edge policy is missing or ambiguous");
  }
  const value = result.rows[0].policy;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PostgreSQL compiled workflow edge policy is invalid");
  }
  const policy = value as Record<string, unknown>;
  const observation = policy.stateObservation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("PostgreSQL compiled workflow state observation policy is invalid");
  }
  const stateObservation = observation as Record<string, unknown>;
  const requiredString = (source: Record<string, unknown>, key: string): string => {
    const candidate = source[key];
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`PostgreSQL compiled workflow edge policy requires ${key}`);
    }
    return candidate.trim();
  };
  const requiredNumber = (source: Record<string, unknown>, key: string): number => {
    const candidate = source[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new Error(`PostgreSQL compiled workflow edge policy requires numeric ${key}`);
    }
    return candidate;
  };
  return {
    runtimeContract: requiredString(policy, "runtimeContract"),
    verificationStrategy: requiredString(policy, "verificationStrategy"),
    dataRetentionDays: requiredNumber(policy, "dataRetentionDays"),
    stepTimeoutMs: requiredNumber(policy, "stepTimeoutMs"),
    actionRetries: requiredNumber(policy, "actionRetries"),
    actionRetryDelayMs: requiredNumber(policy, "actionRetryDelayMs"),
    stateObservation: {
      actionKey: requiredString(stateObservation, "actionKey"),
      outputPath: requiredString(stateObservation, "outputPath"),
      containsOperator: requiredString(stateObservation, "containsOperator"),
      excludesOperator: requiredString(stateObservation, "excludesOperator"),
      pollIntervalMs: requiredNumber(stateObservation, "pollIntervalMs"),
      timeoutMs: requiredNumber(stateObservation, "timeoutMs"),
    },
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function configuredNumber(value: unknown, configured: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : configured;
}

function selectorParams(step: CompiledStep, appMap: AppMap): Record<string, unknown> | null {
  const target = step.target;
  if (!target) return null;

  let element: ElementDef | undefined;
  if (target.elementId) {
    for (const page of Object.values(appMap.pages)) {
      element = page.elements[target.elementId];
      if (element) break;
    }
  }

  const resourceId = target.resourceId || element?.resourceId;
  const contentDescription = target.contentDescription || element?.contentDescription;
  const text = target.text || element?.text;
  if (resourceId) return { resourceId };
  if (contentDescription) return { contentDescription };
  if (text) return { text };

  const coords = target.coords ?? (element?.bounds
    ? { x: element.bounds.x + element.bounds.w / 2, y: element.bounds.y + element.bounds.h / 2 }
    : undefined);
  if (coords && finite(coords.x) && finite(coords.y)) return { x: coords.x, y: coords.y };
  return null;
}

function actionStep(
  step: CompiledStep,
  appMap: AppMap,
  policy: CompiledWorkflowEdgePolicy,
): ActionStep {
  const common = {
    type: "action" as const,
    id: step.id,
    retries: Math.max(0, configuredNumber(step.retries, policy.actionRetries)),
    retryDelayMs: Math.max(0, configuredNumber(step.retryDelay, policy.actionRetryDelayMs)),
    verification: policy.verificationStrategy,
    timeoutMs: policy.stepTimeoutMs,
  };
  const target = selectorParams(step, appMap);
  if (step.target && !target) {
    throw new Error(`Compiled step ${step.id} has no portable selector`);
  }
  return {
    ...common,
    action: step.action,
    params: { ...(step.params ?? {}), ...(target ?? {}) },
  };
}

function anchorValue(anchor: string): string {
  const separator = anchor.indexOf(":");
  return (separator >= 0 ? anchor.slice(separator + 1) : anchor).trim();
}

function stateWaits(
  step: CompiledStep,
  page: PageDef | undefined,
  policy: CompiledWorkflowEdgePolicy,
): WaitStep[] {
  if (!page) return [];
  const waits: WaitStep[] = [];
  page.detection.anchors.filter(Boolean).forEach((anchor, index) => {
    waits.push({
      type: "wait",
      id: `${step.id}__state_required_${index}`,
      until: {
        action: policy.stateObservation.actionKey,
        params: {},
        outputPath: policy.stateObservation.outputPath,
        operator: policy.stateObservation.containsOperator,
        expected: anchorValue(anchor),
        pollIntervalMs: policy.stateObservation.pollIntervalMs,
        timeoutMs: policy.stateObservation.timeoutMs,
      },
    });
  });
  (page.detection.forbiddenAnchors ?? []).filter(Boolean).forEach((anchor, index) => {
    waits.push({
      type: "wait",
      id: `${step.id}__state_forbidden_${index}`,
      until: {
        action: policy.stateObservation.actionKey,
        params: {},
        outputPath: policy.stateObservation.outputPath,
        operator: policy.stateObservation.excludesOperator,
        expected: anchorValue(anchor),
        pollIntervalMs: policy.stateObservation.pollIntervalMs,
        timeoutMs: policy.stateObservation.timeoutMs,
      },
    });
  });
  return waits;
}

function compiledStepToEdgeSteps(
  step: CompiledStep,
  appMap: AppMap,
  policy: CompiledWorkflowEdgePolicy,
): WorkflowStep[] {
  const action = actionStep(step, appMap, policy);
  const expectedPage = step.expectedPage ? appMap.pages[step.expectedPage] : undefined;
  if (step.expectedPage && !expectedPage) {
    throw new Error(`Compiled step ${step.id} references unknown expected page ${step.expectedPage}`);
  }
  if (
    expectedPage &&
    expectedPage.detection.anchors.length === 0 &&
    (expectedPage.detection.forbiddenAnchors?.length ?? 0) === 0
  ) {
    throw new Error(`Expected page ${step.expectedPage} has no portable state anchors`);
  }
  return [action, ...stateWaits(step, expectedPage, policy)];
}

export async function compiledWorkflowToEdgeTemplate(workflow: CompiledWorkflow): Promise<WorkflowTemplate> {
  const appMap = await loadMap(workflow.appId);
  if (!appMap) throw new Error(`App map not found for ${workflow.appId}`);
  const policy = await loadCompiledWorkflowEdgePolicy();

  const steps = workflow.steps.flatMap((step) => compiledStepToEdgeSteps(step, appMap, policy));
  return {
    id: workflow.id,
    name: workflow.name,
    platform: workflow.appId,
    description: workflow.source,
    version: `compiled-${workflow.appMapVersion}`,
    runtimeContract: policy.runtimeContract,
    steps,
    defaultVerificationStrategy: policy.verificationStrategy,
    dataRetentionDays: policy.dataRetentionDays,
    compatibleAppVersions: appMap.appVersion ? [appMap.appVersion] : undefined,
  };
}
