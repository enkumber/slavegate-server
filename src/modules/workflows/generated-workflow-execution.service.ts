import { scalabilityConfig } from "../../config/scalability.config";
import { directWsServer } from "../../ws/direct-ws.server";
import { sendEdgeWorkflowToDeviceEnforced } from "../../transport/transport";
import { hbeService } from "../hbe/hbe.service";
import { workflowService } from "./workflow.service";
import type { WorkflowCheckpoint, WorkflowTemplate } from "./types";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";
import { workflowEvents } from "../workflow-events";
import { assertOperationalRuntimeContract } from "./runtime-contract.service";
import { scheduleEdgeWorkflowAckWatchdog } from "./edge-workflow-lifecycle.service";
import { prepareEdgeLearningBindings } from "../ui-graph/edge-learning.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

export function resolveGeneratedWorkflowDeviceId(deviceId: string): string {
  if (UUID_RE.test(deviceId)) return deviceId;

  const matches = directWsServer
    .getConnectedDeviceIds()
    .filter((id) => id.startsWith(deviceId));

  if (matches.length === 1) return matches[0];

  const err = new Error(
    matches.length === 0
      ? "deviceId must be a full UUID or unique online device prefix"
      : "deviceId prefix is ambiguous; use the full UUID"
  );
  (err as Error & { status?: number; code?: string }).status = 400;
  (err as Error & { status?: number; code?: string }).code = matches.length === 0
    ? "DEVICE_NOT_FOUND"
    : "DEVICE_ID_AMBIGUOUS";
  throw err;
}

function createGeneratedWorkflowCheckpoint(
  variables: Record<string, unknown> | undefined,
  hbeSession: Record<string, unknown>,
): WorkflowCheckpoint {
  return {
    stepIndex: 0,
    loopStack: [],
    variables: variables ?? {},
    hbeParams: hbeSession,
    executionStats: {
      compileLlmCalls: 0,
      recoveryLlmCalls: 0,
      creativeLlmCalls: 0,
      runtimeLlmCalls: 0,
      vlmCalls: 0,
      deterministicSteps: 0,
      batchedSteps: 0,
      failedSteps: 0,
      retriedSteps: 0,
      recoveryAttempts: 0,
      recoveryBudgetExhausted: 0,
      mode: "edge",
    },
    checkpointAt: new Date().toISOString(),
  };
}

function containsLegacySemanticOpcode(template: WorkflowTemplate): boolean {
  const visit = (steps: WorkflowTemplate["steps"]): boolean => steps.some((step) => {
    if (step.type === "action" && step.action === "semantic_tap") return true;
    if (step.type === "action" && step.onFailureSteps && visit(step.onFailureSteps)) return true;
    if (step.type === "condition") return visit(step.if_true) || visit(step.if_false ?? []);
    if (step.type === "loop") return visit(step.steps);
    return false;
  });
  return visit(template.steps);
}

export interface GeneratedWorkflowControlPlaneContext {
  accountId?: string;
  clientId?: string;
  campaignId?: string;
  deviceId?: string;
  taskId?: string;
  agencyWorkflowRunId?: string;
  platform?: string;
  routine?: string;
  source: "api" | "task_runner";
}

export async function dispatchGeneratedWorkflowTemplate(input: {
  templateId: string;
  template: WorkflowTemplate;
  deviceId: string;
  accountId?: string;
  variables?: Record<string, unknown>;
  controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
  logPrefix?: string;
}): Promise<{ workflowId: string; status: "queued" | "running"; mode: "edge"; templateId: string; controlPlaneContext?: GeneratedWorkflowControlPlaneContext }> {
  const { templateId, template, deviceId, accountId, variables, controlPlaneContext, logPrefix = "workflow" } = input;
  const validation = validateGeneratedWorkflowTemplate(template);
  if (!validation.template) {
    const err = new Error(`Generated workflow failed executable validation: ${validation.errors.join("; ")}`);
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).status = 400;
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).code = "GENERATED_WORKFLOW_VALIDATION_FAILED";
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).validationErrors = validation.errors;
    throw err;
  }
  await assertOperationalRuntimeContract(validation.template);
  if (containsLegacySemanticOpcode(validation.template)) {
    const err = new Error("semantic_tap is a legacy server-resolved opcode; recompile the workflow with explicit selectors or normalized coordinates");
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "WORKFLOW_RECOMPILE_REQUIRED";
    throw err;
  }
  if (!directWsServer.supportsEdgeExecution(deviceId)) {
    const err = new Error("Full workflow execution requires an edge-capable Android agent");
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "EDGE_WORKFLOW_V2_UNSUPPORTED";
    throw err;
  }

  const activeForDevice = await workflowService.countActiveByDevice(deviceId);
  if (activeForDevice >= scalabilityConfig.maxWorkflowsPerDevice) {
    const err = new Error(`Device already has ${activeForDevice} active workflow(s). Max: ${scalabilityConfig.maxWorkflowsPerDevice} per device.`);
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "DEVICE_BUSY";
    throw err;
  }

  const globalRunning = await workflowService.countByStatus("running");
  if (globalRunning >= scalabilityConfig.maxGlobalConcurrentWorkflows) {
    const err = new Error(`Server at capacity: ${globalRunning}/${scalabilityConfig.maxGlobalConcurrentWorkflows} concurrent workflows. Retry later.`);
    (err as Error & { status?: number; code?: string }).status = 429;
    (err as Error & { status?: number; code?: string }).code = "SERVER_BUSY";
    throw err;
  }

  workflowEvents.publish({
    source: "workflow_executor",
    event: "dispatch_accepted",
    taskId: controlPlaneContext?.taskId,
    agencyWorkflowRunId: controlPlaneContext?.agencyWorkflowRunId,
    clientId: controlPlaneContext?.clientId,
    accountId,
    deviceId,
    status: "accepted",
    totalSteps: template.steps.length,
    details: {
      templateId,
      accountId,
      controlPlaneContext,
    },
  });

  const accountAgeDays = (variables?.["accountAgeDays"] as number) ?? 30;
  const simulatedTimezone = (variables?.["timezone"] as string) ?? "Europe/Bucharest";
  const hbeSession = hbeService.initSession(accountAgeDays, simulatedTimezone) as unknown as Record<string, unknown>;
  const edgeLearningBindings = await prepareEdgeLearningBindings(validation.template);
  const dispatchVariables = controlPlaneContext
    ? { ...(variables ?? {}), controlPlaneContext }
    : variables;
  const edgeVariables = {
    ...(dispatchVariables ?? {}),
    ...(edgeLearningBindings.length > 0 ? { _edgeLearningBindings: edgeLearningBindings } : {}),
  };

  {
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: hbeSession,
      checkpoint: createGeneratedWorkflowCheckpoint(edgeVariables, hbeSession),
    });
    const dispatch = await sendEdgeWorkflowToDeviceEnforced(
      deviceId,
      wf.id,
      template as unknown as Record<string, unknown>,
      edgeVariables,
    );

    if (dispatch.sent) {
      const started = await workflowService.markRunning(wf.id);
      if (!started) throw new Error(`Workflow ${wf.id} was cancelled before edge dispatch`);
      scheduleEdgeWorkflowAckWatchdog(wf.id, deviceId, logPrefix);
      workflowEvents.publish({
        source: "workflow_executor",
        event: "dispatch_running",
        workflowId: wf.id,
        taskId: controlPlaneContext?.taskId,
        agencyWorkflowRunId: controlPlaneContext?.agencyWorkflowRunId,
        clientId: controlPlaneContext?.clientId,
        accountId,
        deviceId,
        mode: "edge",
        status: "running",
        totalSteps: template.steps.length,
        details: {
          mode: "edge",
          templateId,
          accountId,
          controlPlaneContext,
        },
      });
      console.log(`[${logPrefix}] ${wf.id} dispatched to device (edge execution, agent=${directWsServer.getAgentVersion(deviceId)})`);
      return { workflowId: wf.id, status: "running", mode: "edge", templateId, controlPlaneContext };
    }

    if (dispatch.queued) {
      workflowEvents.publish({
        source: "workflow_executor",
        event: "dispatch_queued",
        workflowId: wf.id,
        taskId: controlPlaneContext?.taskId,
        agencyWorkflowRunId: controlPlaneContext?.agencyWorkflowRunId,
        clientId: controlPlaneContext?.clientId,
        accountId,
        deviceId,
        mode: "edge",
        status: "queued",
        totalSteps: template.steps.length,
        details: {
          mode: "edge",
          templateId,
          accountId,
          controlPlaneContext,
          pnqDecision: dispatch.decision,
          pnqReason: dispatch.reason ?? null,
        },
      });
      console.log(`[${logPrefix}] ${wf.id} queued behind active device root (edge execution)`);
      return { workflowId: wf.id, status: "queued", mode: "edge", templateId, controlPlaneContext };
    }

    await workflowService.markFailed(wf.id, "Edge dispatch failed");
    const err = new Error("Full workflow edge dispatch failed; server step execution is forbidden");
    (err as Error & { status?: number; code?: string }).status = 503;
    (err as Error & { status?: number; code?: string }).code = "EDGE_WORKFLOW_V2_DISPATCH_FAILED";
    throw err;
  }
}
