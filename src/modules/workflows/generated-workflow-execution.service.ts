import { scalabilityConfig } from "../../config/scalability.config";
import { directWsServer } from "../../ws/direct-ws.server";
import { hbeService } from "../hbe/hbe.service";
import { startWorkflow } from "./workflow.executor";
import { workflowService } from "./workflow.service";
import type { WorkflowCheckpoint, WorkflowTemplate } from "./types";

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
      mode,
    },
    checkpointAt: new Date().toISOString(),
  };
}

export async function dispatchGeneratedWorkflowTemplate(input: {
  templateId: string;
  template: WorkflowTemplate;
  deviceId: string;
  accountId?: string;
  variables?: Record<string, unknown>;
  logPrefix?: string;
}): Promise<{ workflowId: string; status: "queued" | "running"; mode: "edge" | "server"; templateId: string }> {
  const { templateId, template, deviceId, accountId, variables, logPrefix = "workflow" } = input;

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

  const accountAgeDays = (variables?.["accountAgeDays"] as number) ?? 30;
  const simulatedTimezone = (variables?.["timezone"] as string) ?? "Europe/Bucharest";
  const hbeSession = hbeService.initSession(accountAgeDays, simulatedTimezone) as unknown as Record<string, unknown>;

  if (directWsServer.supportsEdgeExecution(deviceId)) {
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: hbeSession,
      checkpoint: createGeneratedWorkflowCheckpoint(variables, hbeSession, "edge"),
    });
    await workflowService.markRunning(wf.id);

    const sent = directWsServer.sendWorkflowStart(
      deviceId,
      template as unknown as Record<string, unknown>,
      variables,
      wf.id,
    );

    if (sent) {
      console.log(`[${logPrefix}] ${wf.id} dispatched to device (edge execution, agent=${directWsServer.getAgentVersion(deviceId)})`);
      return { workflowId: wf.id, status: "running", mode: "edge", templateId };
    }

    await workflowService.markFailed(wf.id, "Edge dispatch failed");
    console.warn(`[${logPrefix}] Edge dispatch failed for ${deviceId} — falling back to server execution`);
  }

  const checkpoint = createGeneratedWorkflowCheckpoint(variables, hbeSession, "server");
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

  return { workflowId: wf.id, status: "queued", mode: "server", templateId };
}
