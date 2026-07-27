import { workflowEvents } from "../workflow-events";
import { workflowService } from "./workflow.service";
import type { WorkflowStep, WorkflowTemplate } from "./types";
import { getResourceLifecycleExecutionStatusContract } from "../lifecycle/lifecycle.service";
import { getWorkflowInterpreterPolicy } from "../dispatcher/dispatcher.service";
import {
  deviceExecutionArbiter,
  isDeviceExecutionResultTerminal,
} from "../device-execution";

let progressSweepTimer: NodeJS.Timeout | null = null;

interface EdgeWatchdogPolicy {
  ackTimeoutMs: number;
  progressSweepMs: number;
  progressGraceMs: number;
  minStaleMs: number;
  maxStaleMs: number;
  localStepBudgetMs: number;
}

async function loadEdgeWatchdogPolicy(): Promise<EdgeWatchdogPolicy> {
  const interpreter = await getWorkflowInterpreterPolicy();
  const raw = interpreter.enginePolicy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PostgreSQL workflow interpreter enginePolicy is missing");
  }
  const policy = raw as Record<string, unknown>;
  const positiveInteger = (key: keyof EdgeWatchdogPolicy): number => {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new Error(`PostgreSQL workflow engine policy requires positive integer ${key}`);
    }
    return Number(value);
  };
  return {
    ackTimeoutMs: positiveInteger("ackTimeoutMs"),
    progressSweepMs: positiveInteger("progressSweepMs"),
    progressGraceMs: positiveInteger("progressGraceMs"),
    minStaleMs: positiveInteger("minStaleMs"),
    maxStaleMs: positiveInteger("maxStaleMs"),
    localStepBudgetMs: positiveInteger("localStepBudgetMs"),
  };
}

function edgeCheckpointAcknowledged(checkpoint: unknown): boolean {
  return !!checkpoint &&
    typeof checkpoint === "object" &&
    (checkpoint as Record<string, unknown>).source === "edge";
}

function checkpointTimestamp(checkpoint: unknown): string | null {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const value = (checkpoint as Record<string, unknown>).checkpointAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function stepBudgetMs(step: WorkflowStep | undefined, policy: EdgeWatchdogPolicy): number {
  if (!step) return policy.localStepBudgetMs;
  if (step.type === "action") return step.timeoutMs ?? policy.localStepBudgetMs;
  if (step.type === "wait") {
    if (step.until?.timeoutMs) return step.until.timeoutMs;
    if (step.timeoutMs) return step.timeoutMs;
    if (step.duration?.max) return step.duration.max;
  }
  // Conditions/checkpoints are local and loops report progress through their
  // nested actions. Keep a bounded default if no explicit duration exists.
  return policy.localStepBudgetMs;
}

export function edgeProgressStaleAfterMs(
  template: WorkflowTemplate | null,
  currentStep: number,
  policy: EdgeWatchdogPolicy,
): number {
  const budget = stepBudgetMs(template?.steps[currentStep], policy);
  return Math.min(
    policy.maxStaleMs,
    Math.max(policy.minStaleMs, budget + policy.progressGraceMs),
  );
}

async function releaseTimedOutEdgeWorkflowOwnership(input: {
  workflowId: string;
  deviceId: string;
  reason: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const terminal = await deviceExecutionArbiter.observeTerminal({
    deviceId: input.deviceId,
    rootKind: "edge_workflow",
    externalId: input.workflowId,
    terminalSelector: {
      targetTerminal: true,
      targetRetryable: true,
      targetAdministrative: false,
      transitionAutomatic: true,
      transitionMarkCompleted: true,
    },
    actor: "edge_workflow_watchdog",
    reason: input.reason,
    metadata: input.metadata,
  });
  if (isDeviceExecutionResultTerminal(terminal)) return true;

  // After a server restart PNQ deliberately moves in-flight roots to its
  // manual reconciliation state before this watchdog runs. The workflow CAS
  // above is now exact terminal evidence, so reconcile the matching root and
  // operation through the same database-authoritative repair used at startup.
  const reconciled = await deviceExecutionArbiter.reconcileTerminalWorkflowRoots({
    actor: "edge_workflow_watchdog",
    reason: input.reason,
    metadata: input.metadata,
  });
  return reconciled.reconciledRoots > 0;
}

async function sendTimedOutEdgeWorkflowCancellation(
  deviceId: string,
  workflowId: string,
): Promise<boolean> {
  // Load lazily: transport imports this lifecycle module for replay handling.
  // A static import here would create a circular module initialization path.
  const { sendWorkflowCancellationControl } = await import("../../transport/transport");
  return sendWorkflowCancellationControl(deviceId, workflowId).catch((err) => {
    console.error(`[edge-watchdog] Cancel send failed for ${workflowId}: ${(err as Error).message}`);
    return false;
  });
}

export async function sweepStaleEdgeWorkflows(nowMs = Date.now()): Promise<{ checked: number; failed: number }> {
  const running = await workflowService.listActive(1, 500);
  const lifecycleStatusContract = await getResourceLifecycleExecutionStatusContract("workflows");
  const watchdogPolicy = await loadEdgeWatchdogPolicy();
  let checked = 0;
  let failed = 0;

  for (const workflow of running.items) {
    if (!workflow.deviceId) continue;
    const checkpointAt = checkpointTimestamp(workflow.checkpoint);
    if (!checkpointAt) continue;
    checked += 1;
    const ageMs = nowMs - Date.parse(checkpointAt);

    if (!edgeCheckpointAcknowledged(workflow.checkpoint)) {
      if (workflow.currentStep !== 0 || ageMs <= watchdogPolicy.ackTimeoutMs) continue;
      const error = `Edge workflow did not acknowledge WORKFLOW_START within ${watchdogPolicy.ackTimeoutMs}ms`;
      const terminalized = await workflowService.markFailedIfEdgeStartUnacknowledged(
        workflow.id,
        error,
      );
      if (!terminalized) continue;

      failed += 1;
      const ownershipReleased = await releaseTimedOutEdgeWorkflowOwnership({
        workflowId: workflow.id,
        deviceId: workflow.deviceId,
        reason: "edge_ack_timeout_recovered",
        metadata: { checkpointAt, ageMs, timeoutMs: watchdogPolicy.ackTimeoutMs },
      });
      const cancelSent = await sendTimedOutEdgeWorkflowCancellation(workflow.deviceId, workflow.id);
      workflowEvents.publish({
        source: "workflow_executor",
        event: "failed",
        workflowId: workflow.id,
        deviceId: workflow.deviceId,
        mode: "edge",
        status: lifecycleStatusContract.failed,
        currentStep: workflow.currentStep,
        error,
        details: {
          reason: "edge_ack_timeout_recovered",
          checkpointAt,
          ageMs,
          timeoutMs: watchdogPolicy.ackTimeoutMs,
          ownershipReleased,
          cancelSent,
        },
      });
      console.warn(
        `[edge-watchdog] Recovered unacknowledged workflow ${workflow.id}; ` +
        `ownershipReleased=${ownershipReleased} cancelSent=${cancelSent}`,
      );
      continue;
    }

    const template = workflow.templateId ? await workflowService.getTemplate(workflow.templateId) : null;
    const staleAfterMs = edgeProgressStaleAfterMs(template, workflow.currentStep, watchdogPolicy);
    if (ageMs <= staleAfterMs) continue;

    const error = `Edge workflow made no progress for ${ageMs}ms (deadline ${staleAfterMs}ms)`;
    const terminalized = await workflowService.markFailedIfEdgeProgressStale(
      workflow.id,
      checkpointAt,
      error,
    );
    if (!terminalized) continue;

    failed += 1;
    const ownershipReleased = await releaseTimedOutEdgeWorkflowOwnership({
      workflowId: workflow.id,
      deviceId: workflow.deviceId,
      reason: "edge_progress_timeout",
      metadata: { checkpointAt, ageMs, staleAfterMs },
    });
    const cancelSent = await sendTimedOutEdgeWorkflowCancellation(workflow.deviceId, workflow.id);
    workflowEvents.publish({
      source: "workflow_executor",
      event: "failed",
      workflowId: workflow.id,
      deviceId: workflow.deviceId,
      mode: "edge",
      status: lifecycleStatusContract.failed,
      currentStep: workflow.currentStep,
      error,
      details: {
        reason: "edge_progress_timeout",
        checkpointAt,
        ageMs,
        staleAfterMs,
        ownershipReleased,
        cancelSent,
      },
    });
    console.warn(
      `[edge-watchdog] Failed stale workflow ${workflow.id} at step ${workflow.currentStep}; ` +
      `ownershipReleased=${ownershipReleased} cancelSent=${cancelSent}`,
    );
  }

  return { checked, failed };
}

export async function startEdgeWorkflowProgressWatchdog(): Promise<NodeJS.Timeout> {
  if (progressSweepTimer) return progressSweepTimer;
  const policy = await loadEdgeWatchdogPolicy();
  progressSweepTimer = setInterval(() => {
    sweepStaleEdgeWorkflows().catch((err) =>
      console.error(`[edge-watchdog] Progress sweep failed: ${(err as Error).message}`),
    );
  }, policy.progressSweepMs);
  progressSweepTimer.unref?.();
  await sweepStaleEdgeWorkflows();
  return progressSweepTimer;
}

export async function scheduleEdgeWorkflowAckWatchdog(
  workflowId: string,
  deviceId: string,
  logPrefix: string,
): Promise<void> {
  const policy = await loadEdgeWatchdogPolicy();
  const timeoutError = "Edge workflow did not acknowledge WORKFLOW_START";
  const timeout = setTimeout(async () => {
    try {
      const latest = await workflowService.get(workflowId);
      if (!latest || latest.lifecycleTerminal === true || latest.currentStep !== 0) return;
      if (edgeCheckpointAcknowledged(latest.checkpoint)) return;

      const failed = await workflowService.markFailedIfEdgeStartUnacknowledged(
        workflowId,
        `${timeoutError} within ${policy.ackTimeoutMs}ms`,
      );
      if (!failed) return;
      const ownershipReleased = await releaseTimedOutEdgeWorkflowOwnership({
        workflowId,
        deviceId,
        reason: "edge_ack_timeout",
        metadata: { timeoutMs: policy.ackTimeoutMs },
      });
      const cancelSent = await sendTimedOutEdgeWorkflowCancellation(deviceId, workflowId);
      workflowEvents.publish({
        source: "workflow_executor",
        event: "failed",
        workflowId,
        deviceId,
        mode: "edge",
        status: (await getResourceLifecycleExecutionStatusContract("workflows")).failed,
        currentStep: 0,
        error: timeoutError,
        details: {
          reason: "edge_ack_timeout",
          timeoutMs: policy.ackTimeoutMs,
          ownershipReleased,
          cancelSent,
        },
      });
      console.warn(
        `[${logPrefix}] Edge workflow ${workflowId} on ${deviceId.slice(0, 8)} did not acknowledge ` +
        `start within ${policy.ackTimeoutMs}ms; ownershipReleased=${ownershipReleased} cancelSent=${cancelSent}`,
      );
    } catch (err) {
      console.error(`[${logPrefix}] Edge workflow ack watchdog failed for ${workflowId}: ${(err as Error).message}`);
    }
  }, policy.ackTimeoutMs);
  timeout.unref?.();
}

export async function promoteReplayedEdgeWorkflowToRunning(input: {
  workflowId: string;
  deviceId: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  actor: string;
}): Promise<void> {
  const { workflowId, deviceId, templateId, variables, actor } = input;
  let started = false;
  try {
    started = await workflowService.markRunning(workflowId);
    if (!started) {
      const latest = await workflowService.get(workflowId);
      if (!latest || latest.lifecycleTerminal === true) return;
      if (edgeCheckpointAcknowledged(latest.checkpoint)) return;
    }

    await scheduleEdgeWorkflowAckWatchdog(workflowId, deviceId, actor);
    const context = variables?.controlPlaneContext;
    const controlPlaneContext = context && typeof context === "object" && !Array.isArray(context)
      ? context as Record<string, unknown>
      : {};
    workflowEvents.publish({
      source: "workflow_executor",
      event: "dispatch_running",
      workflowId,
      taskId: typeof controlPlaneContext.taskId === "string" ? controlPlaneContext.taskId : undefined,
      agencyWorkflowRunId: typeof controlPlaneContext.agencyWorkflowRunId === "string"
        ? controlPlaneContext.agencyWorkflowRunId
        : undefined,
      clientId: typeof controlPlaneContext.clientId === "string" ? controlPlaneContext.clientId : undefined,
      accountId: typeof controlPlaneContext.accountId === "string" ? controlPlaneContext.accountId : undefined,
      deviceId,
      mode: "edge",
      status: (await getResourceLifecycleExecutionStatusContract("workflows")).active,
      details: {
        mode: "edge",
        templateId: templateId ?? null,
        controlPlaneContext,
        replayedFromPnq: true,
      },
    });
  } catch (err) {
    // The wire send has already happened. Never surface this as a dispatch
    // failure because the caller could issue a duplicate workflow execution.
    console.error(`[${actor}] Failed to reconcile replayed edge workflow ${workflowId} after wire dispatch: ${(err as Error).message}`);
  }
}
