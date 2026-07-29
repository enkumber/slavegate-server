import { scalabilityConfig } from "../../config/scalability.config";
import { directWsServer } from "../../ws/direct-ws.server";
import { sendEdgeWorkflowToDeviceEnforced } from "../../transport/transport";
import { workflowService } from "./workflow.service";
import type { WorkflowCheckpoint, WorkflowTemplate } from "./types";
import { validateGeneratedWorkflowTemplate } from "./workflow-validator";
import { workflowEvents } from "../workflow-events";
import { assertOperationalRuntimeContract } from "./runtime-contract.service";
import { scheduleEdgeWorkflowAckWatchdog } from "./edge-workflow-lifecycle.service";
import { attachEdgeLearningBindings, prepareEdgeLearningBindings } from "../ui-graph/edge-learning.service";
import { uiGraphRepository } from "../ui-graph/repository";
import { getResourceLifecycleExecutionStatusContract } from "../lifecycle/lifecycle.service";
import { assertWorkflowSafetyDispatch } from "./workflow-safety-admission.service";

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
): WorkflowCheckpoint {
  return {
    stepIndex: 0,
    loopStack: [],
    variables: variables ?? {},
    hbeParams: {},
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

export interface GeneratedWorkflowControlPlaneContext {
  accountId?: string;
  clientId?: string;
  campaignId?: string;
  deviceId?: string;
  taskId?: string;
  agencyWorkflowRunId?: string;
  platform?: string;
  routine?: string;
  safetyAdmissionId?: string;
  source: "api" | "task_runner";
}

function configuredRecoveryCapabilities(config: Record<string, unknown>): string[] {
  const value = config.recoveryCapabilities;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertRecoveryAdmission(
  requiredCapabilities: string[],
  flags: Awaited<ReturnType<typeof uiGraphRepository.resolveFlags>>,
): { requiredCapabilities: string[]; authorizedCapabilities: string[] } | null {
  if (requiredCapabilities.length === 0) return null;
  if (!flags.enabled || !flags.aiRecovery) {
    const err = new Error("Workflow recovery is not enabled for the effective UI Graph scope");
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "UI_GRAPH_RECOVERY_DISABLED";
    throw err;
  }
  const authorizedCapabilities = configuredRecoveryCapabilities(flags.config);
  const authorized = new Set(authorizedCapabilities);
  if (requiredCapabilities.some((capability) => !authorized.has(capability))) {
    const err = new Error("Workflow recovery capability is not authorized for the effective UI Graph scope");
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "UI_GRAPH_RECOVERY_CAPABILITY_DENIED";
    throw err;
  }
  return { requiredCapabilities, authorizedCapabilities };
}

export async function dispatchGeneratedWorkflowTemplate(input: {
  templateId: string;
  template: WorkflowTemplate;
  deviceId: string;
  accountId?: string;
  variables?: Record<string, unknown>;
  controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
  logPrefix?: string;
}): Promise<{ workflowId: string; status: string; mode: "edge"; templateId: string; controlPlaneContext?: GeneratedWorkflowControlPlaneContext }> {
  const { templateId, template, deviceId, accountId, variables, controlPlaneContext, logPrefix = "workflow" } = input;
  const validation = validateGeneratedWorkflowTemplate(template);
  if (!validation.template) {
    const err = new Error(`Generated workflow failed executable validation: ${validation.errors.join("; ")}`);
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).status = 400;
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).code = "GENERATED_WORKFLOW_VALIDATION_FAILED";
    (err as Error & { status?: number; code?: string; validationErrors?: string[] }).validationErrors = validation.errors;
    throw err;
  }
  await assertWorkflowSafetyDispatch({
    workflow: validation.template,
    safetyAdmissionId: controlPlaneContext?.safetyAdmissionId,
    context: {
      deviceId,
      accountId: accountId ?? controlPlaneContext?.accountId,
      clientId: controlPlaneContext?.clientId,
      campaignId: controlPlaneContext?.campaignId,
      source: controlPlaneContext?.source,
    },
  });
  await assertOperationalRuntimeContract(validation.template);
  if (!directWsServer.supportsEdgeExecution(deviceId)) {
    const err = new Error("Full workflow execution requires an edge-capable Android agent");
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "EDGE_WORKFLOW_V2_UNSUPPORTED";
    throw err;
  }

  const lifecycleStatusContract = await getResourceLifecycleExecutionStatusContract("workflows");
  const activeForDevice = await workflowService.countActiveByDevice(deviceId);
  if (activeForDevice >= scalabilityConfig.maxWorkflowsPerDevice) {
    const err = new Error(`Device already has ${activeForDevice} active workflow(s). Max: ${scalabilityConfig.maxWorkflowsPerDevice} per device.`);
    (err as Error & { status?: number; code?: string }).status = 409;
    (err as Error & { status?: number; code?: string }).code = "DEVICE_BUSY";
    throw err;
  }

  const globalRunning = await workflowService.countActiveGlobal();
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
    status: lifecycleStatusContract.initial,
    totalSteps: template.steps.length,
    details: {
      templateId,
      accountId,
      controlPlaneContext,
    },
  });

  const suppliedRuntimeContext = variables?._runtimeContext;
  const runtimeContext = suppliedRuntimeContext
    && typeof suppliedRuntimeContext === "object"
    && !Array.isArray(suppliedRuntimeContext)
    ? suppliedRuntimeContext as Record<string, unknown>
    : {};
  const edgeRuntimeContext = {
    ...runtimeContext,
    appId: validation.template.platform,
    deviceId,
    workflowId: templateId,
  };
  const runtimeFlags = await uiGraphRepository.resolveFlags(edgeRuntimeContext);
  const recoveryAdmission = assertRecoveryAdmission(
    validation.template.requiredRecoveryCapabilities ?? [],
    runtimeFlags,
  );
  const edgeLearningBindings = await prepareEdgeLearningBindings(validation.template, edgeRuntimeContext);
  const edgeTemplate = {
    ...attachEdgeLearningBindings(validation.template, edgeLearningBindings),
    lifecycleStatusContract,
  };
  const dispatchVariables = controlPlaneContext
    ? { ...(variables ?? {}), controlPlaneContext }
    : variables;
  const edgeVariables = {
    ...(dispatchVariables ?? {}),
    _runtimeContext: edgeRuntimeContext,
    ...(recoveryAdmission ? { _uiGraphRecoveryAdmission: recoveryAdmission } : {}),
    ...(edgeLearningBindings.length > 0 ? { _edgeLearningBindings: edgeLearningBindings } : {}),
  };

  {
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: {},
      checkpoint: createGeneratedWorkflowCheckpoint(edgeVariables),
    });
    const dispatch = await sendEdgeWorkflowToDeviceEnforced(
      deviceId,
      wf.id,
      edgeTemplate as unknown as Record<string, unknown>,
      edgeVariables,
    );

    if (dispatch.sent) {
      const started = await workflowService.markRunning(wf.id);
      if (!started) throw new Error(`Workflow ${wf.id} was cancelled before edge dispatch`);
      await scheduleEdgeWorkflowAckWatchdog(wf.id, deviceId, logPrefix);
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
        status: lifecycleStatusContract.active,
        totalSteps: template.steps.length,
        details: {
          mode: "edge",
          templateId,
          accountId,
          controlPlaneContext,
        },
      });
      console.log(`[${logPrefix}] ${wf.id} dispatched to device (edge execution, agent=${directWsServer.getAgentVersion(deviceId)})`);
      return { workflowId: wf.id, status: lifecycleStatusContract.active, mode: "edge", templateId, controlPlaneContext };
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
        status: lifecycleStatusContract.initial,
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
      return { workflowId: wf.id, status: lifecycleStatusContract.initial, mode: "edge", templateId, controlPlaneContext };
    }

    await workflowService.markFailed(wf.id, "Edge dispatch failed");
    const err = new Error("Full workflow edge dispatch failed; server step execution is forbidden");
    (err as Error & { status?: number; code?: string }).status = 503;
    (err as Error & { status?: number; code?: string }).code = "EDGE_WORKFLOW_V2_DISPATCH_FAILED";
    throw err;
  }
}
