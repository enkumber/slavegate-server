import { directWsServer } from "../../ws/direct-ws.server";
import { hbeService } from "../hbe/hbe.service";
import { startWorkflow } from "./workflow.executor";
import { workflowService } from "./workflow.service";
import type { WorkflowCheckpoint, WorkflowTemplate } from "./types";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";
import { workflowEvents } from "../workflow-events";
import { canCompileDeviceBundle } from "./workflow-bundle.compiler";

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
  mode: "device_bundle" | "edge" | "server"
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
      mode,
    },
    checkpointAt: new Date().toISOString(),
  };
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
}): Promise<{ workflowId: string; status: "queued" | "running"; mode: "device_bundle" | "edge" | "server"; templateId: string; controlPlaneContext?: GeneratedWorkflowControlPlaneContext }> {
  const { templateId, template, deviceId, accountId, variables, controlPlaneContext, logPrefix = "workflow" } = input;
  const validation = validateGeneratedWorkflowTemplate(template);
  if (!validation.template) {
    const err = new Error(`Generated workflow failed executable validation: ${validation.errors.join("; ")}`);
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).status = 400;
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).code = "GENERATED_WORKFLOW_VALIDATION_FAILED";
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).validationErrors = validation.errors;
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
  const dispatchVariables = controlPlaneContext
    ? { ...(variables ?? {}), controlPlaneContext }
    : variables;

  const supportsDeviceBundle = canCompileDeviceBundle(template);
  if (directWsServer.supportsEdgeExecution(deviceId) && supportsDeviceBundle) {
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: hbeSession,
      checkpoint: createGeneratedWorkflowCheckpoint(dispatchVariables, hbeSession, "device_bundle"),
    });
    startWorkflow(wf.id).catch(err => {
      console.error(`[${logPrefix}] Failed to queue edge workflow ${wf.id}: ${err.message}`);
    });
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
      details: { mode: "device_bundle", templateId, accountId, controlPlaneContext },
    });
    return { workflowId: wf.id, status: "queued", mode: "device_bundle", templateId, controlPlaneContext };
  } else if (!supportsDeviceBundle) {
    console.log(`[${logPrefix}] adaptive/unsupported steps require server execution`);
  }

  const checkpoint = createGeneratedWorkflowCheckpoint(dispatchVariables, hbeSession, "server");
  const wf = await workflowService.create({
    templateId,
    deviceId,
    accountId,
    totalSteps: template.steps.length,
    hbeParams: hbeSession,
    checkpoint,
  });

  startWorkflow(wf.id).catch(err => {
    console.error(`[${logPrefix}] Failed to enqueue ${wf.id}: ${err.message}`);
  });

  workflowEvents.publish({
    source: "workflow_executor",
    event: "dispatch_queued",
    workflowId: wf.id,
    taskId: controlPlaneContext?.taskId,
    agencyWorkflowRunId: controlPlaneContext?.agencyWorkflowRunId,
    clientId: controlPlaneContext?.clientId,
    accountId,
    deviceId,
    mode: "server",
    status: "queued",
    totalSteps: template.steps.length,
    details: {
      mode: "server",
      templateId,
      accountId,
      controlPlaneContext,
    },
  });

  return { workflowId: wf.id, status: "queued", mode: "server", templateId, controlPlaneContext };
}
