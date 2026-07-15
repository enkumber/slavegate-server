import { scalabilityConfig } from "../../config/scalability.config";
import { directWsServer } from "../../ws/direct-ws.server";
import { deviceExecutionLeaseService } from "../device-execution/device-execution-lease.service";
import { hbeService } from "../hbe/hbe.service";
import { startWorkflow } from "./workflow.executor";
import { workflowService } from "./workflow.service";
import type { WorkflowCheckpoint, WorkflowTemplate } from "./types";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";
import { workflowEvents } from "../workflow-events";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const EDGE_WORKFLOW_ACK_TIMEOUT_MS = Number(process.env.EDGE_WORKFLOW_ACK_TIMEOUT_MS ?? 20_000);
const EDGE_WORKFLOW_ACK_TIMEOUT_ERROR = "Edge workflow did not acknowledge WORKFLOW_START";

function scheduleEdgeWorkflowAckWatchdog(workflowId: string, deviceId: string, logPrefix: string): void {
  const timeout = setTimeout(async () => {
    try {
      const latest = await workflowService.get(workflowId);
      if (!latest || latest.status !== "running" || latest.currentStep !== 0) return;
      if ((latest.checkpoint as unknown as Record<string, unknown> | undefined)?.source === "edge") return;

      await workflowService.markFailed(
        workflowId,
        `${EDGE_WORKFLOW_ACK_TIMEOUT_ERROR} within ${EDGE_WORKFLOW_ACK_TIMEOUT_MS}ms`,
      );
      workflowEvents.publish({
        source: "workflow_executor",
        event: "failed",
        workflowId,
        deviceId,
        mode: "edge",
        status: "failed",
        currentStep: 0,
        error: EDGE_WORKFLOW_ACK_TIMEOUT_ERROR,
        details: {
          reason: "edge_ack_timeout",
          timeoutMs: EDGE_WORKFLOW_ACK_TIMEOUT_MS,
        },
      });
      console.warn(`[${logPrefix}] Edge workflow ${workflowId} on ${deviceId.slice(0, 8)} did not acknowledge start within ${EDGE_WORKFLOW_ACK_TIMEOUT_MS}ms`);
    } catch (err) {
      console.error(`[${logPrefix}] Edge workflow ack watchdog failed for ${workflowId}: ${(err as Error).message}`);
    }
  }, EDGE_WORKFLOW_ACK_TIMEOUT_MS);
  timeout.unref?.();
}

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
  mode: "edge" | "server"
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

function requiresServerSemanticResolution(template: WorkflowTemplate): boolean {
  const visit = (steps: WorkflowTemplate["steps"]): boolean => steps.some((step) => {
    if (step.type === "action" && step.action === "semantic_tap") return true;
    if (step.type === "action" && step.action === "ui_tree_dump") return true;
    if (step.type === "action" && step.params && typeof step.params.outputVariable === "string") return true;
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
}): Promise<{ workflowId: string; status: "queued" | "running"; mode: "edge" | "server"; templateId: string; controlPlaneContext?: GeneratedWorkflowControlPlaneContext }> {
  const { templateId, template, deviceId, accountId, variables, controlPlaneContext, logPrefix = "workflow" } = input;
  const validation = validateGeneratedWorkflowTemplate(template);
  if (!validation.template) {
    const err = new Error(`Generated workflow failed executable validation: ${validation.errors.join("; ")}`);
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).status = 400;
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).code = "GENERATED_WORKFLOW_VALIDATION_FAILED";
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).validationErrors = validation.errors;
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
  const dispatchVariables = controlPlaneContext
    ? { ...(variables ?? {}), controlPlaneContext }
    : variables;

  const requiresServerMode = requiresServerSemanticResolution(template);
  if (directWsServer.supportsEdgeExecution(deviceId) && !requiresServerMode) {
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: hbeSession,
      checkpoint: createGeneratedWorkflowCheckpoint(dispatchVariables, hbeSession, "edge"),
    });
    await workflowService.markRunning(wf.id);

    const lease = await deviceExecutionLeaseService.acquire(deviceId, { ownerId: wf.id, ingress: "generated-workflow.edge", requestKey: wf.id });
    const sent = directWsServer.sendWorkflowStart(
      deviceId,
      template as unknown as Record<string, unknown>,
      dispatchVariables,
      wf.id,
      lease,
    );

    if (sent) {
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

    await workflowService.markFailed(wf.id, "Edge dispatch failed");
    await deviceExecutionLeaseService.release(lease);
    console.warn(`[${logPrefix}] Edge dispatch failed for ${deviceId} — falling back to server execution`);
  } else if (requiresServerMode) {
    console.log(`[${logPrefix}] semantic resolution required — using server execution`);
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
