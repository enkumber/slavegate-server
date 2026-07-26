/**
 * transport/transport.ts
 * 
 * Transport abstraction layer for device communication.
 * DirectWS only transport.
 */

import { directWsServer } from "../ws/direct-ws.server";
import { deviceExecutionArbiter } from "../modules/device-execution";
import { getDb } from "../db/client";
import type {
  DeviceExecutionBoundaryKind,
  DeviceExecutionOperationKind,
  DeviceExecutionObservedEgressResult,
  DeviceExecutionRootKind,
  DeviceExecutionStandaloneJobEgressResult,
} from "../modules/device-execution";
import {
  encodeDeviceExecutionHandle,
  getDeviceExecutionBoundaryPolicy,
  isDeviceExecutionResultQueued,
  isDeviceExecutionResultTerminal,
} from "../modules/device-execution";
import { isDeviceExecutionEnforced } from "../modules/device-execution/device-execution-authority";
import type { JobDispatchPayload } from "../../shared/protocol/messages";
import { promoteReplayedEdgeWorkflowToRunning } from "../modules/workflows/edge-workflow-lifecycle.service";
import { pnqV2RuntimeService } from "../modules/device-execution/pnq-v2-runtime.service";
import { isPnqV2ShadowRuntimeEnabled } from "../modules/device-execution/pnq-v2-runtime-config";

export type StandaloneJobSendResult = Pick<
  DeviceExecutionStandaloneJobEgressResult,
  "decision" | "root" | "operation" | "handle" | "reason" | "sent"
> & {
  queued: boolean;
};

export interface DeviceExecutionJobSendOptions {
  boundary?: DeviceExecutionBoundaryKind;
  rootKind?: DeviceExecutionRootKind;
  operationKind?: DeviceExecutionOperationKind;
  rootId?: string;
  rootExternalId?: string;
  requestKey?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface DeviceExecutionJobReplayEnvelopeV1 {
  schemaVersion: "pnq.job-dispatch/v1";
  deviceId: string;
  rootKind: DeviceExecutionRootKind;
  rootExternalId: string;
  operationKind: "job";
  operationId: string;
  boundary: DeviceExecutionBoundaryKind;
  payload: JobDispatchPayload;
}

export interface DeviceExecutionEdgeWorkflowReplayEnvelopeV1 {
  schemaVersion: "pnq.edge-workflow-dispatch/v1";
  deviceId: string;
  rootKind: "edge_workflow";
  rootExternalId: string;
  operationKind: "workflow";
  operationId: string;
  boundary: "edge_workflow";
  template: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

export interface EdgeWorkflowSendResult {
  decision: DeviceExecutionObservedEgressResult["decision"];
  root: DeviceExecutionObservedEgressResult["root"];
  operation: DeviceExecutionObservedEgressResult["operation"];
  handle: DeviceExecutionObservedEgressResult["handle"];
  reason?: string;
  sent: boolean;
  queued: boolean;
}

export type LegacyGeneratedWorkflowJobSendResult = Pick<
  StandaloneJobSendResult,
  "decision" | "root" | "operation" | "handle" | "reason" | "sent" | "queued"
> & {
  resultPromise: Promise<unknown>;
};

export const LEGACY_GENERATED_WORKFLOW_RESULT_GRACE_MS = 5_000;

export interface LegacyGeneratedWorkflowJobSendOptions {
  resultTimeoutMs?: number;
}

/**
 * Send a job to a device via DirectWS transport.
 * Returns true if sent successfully, false if device unreachable.
 */
export function sendJobToDevice(deviceId: string, payload: JobDispatchPayload): boolean {
  if (!isDeviceExecutionEnforced()) {
    return sendObserveOnlyJobToDevice(deviceId, payload);
  }
  console.error(
    `[device-execution] blocked unauthorized raw JOB egress: device=${deviceId.slice(0, 8)} job=${payload.jobId.slice(0, 8)}`
  );
  deviceExecutionArbiter.recordRejectedEgress({
    deviceId,
    operationId: payload.jobId,
    wireType: "JOB",
    actor: "transport.raw_sender_guard",
    reason: "raw_job_sender_disabled_use_permit_path",
    metadata: { jobType: payload.type },
  }).catch((err) => console.error("[device-execution] raw sender rejection audit failed:", (err as Error).message));
  return false;
}

function assertObserveOnlyTransportBoundary(boundary: string): void {
  if (isDeviceExecutionEnforced()) {
    throw new Error(`${boundary} is available only while device execution authority is observe-only`);
  }
}

function sendObserveOnlyJobToDevice(deviceId: string, payload: JobDispatchPayload): boolean {
  assertObserveOnlyTransportBoundary("observe-only JOB transport compatibility");
  if (isPnqV2ShadowRuntimeEnabled()) {
    pnqV2RuntimeService.prepareShadowDispatch(
      payload.jobId,
      directWsServer.getConnectionEpoch(deviceId),
    ).catch((err) => console.error("[pnq-v2-runtime] prepare shadow dispatch failed:", (err as Error).message));
  }
  const sent = directWsServer.sendJob(deviceId, payload);
  observeJobDispatch(deviceId, payload, sent);
  return sent;
}

/**
 * G2 production lane for standalone JOB roots.
 *
 * PostgreSQL authorizes and moves the job root into dispatching before DirectWS
 * receives a typed permit. The waiter is registered before the raw frame is
 * serialized, and the arbiter CASes the root into dispatched only after send.
 */
export async function sendStandaloneJobToDevice(
  deviceId: string,
  payload: JobDispatchPayload,
): Promise<StandaloneJobSendResult> {
  return sendDeviceExecutionJobToDevice(deviceId, payload, {
    boundary: "standalone_job",
    rootKind: "job",
    requestKey: payload.jobId,
    actor: "transport.g2",
    metadata: { observeSource: "transport.sendStandaloneJobToDevice" },
  });
}

export async function sendLegacyGeneratedWorkflowJobToDevice(
  deviceId: string,
  payload: JobDispatchPayload,
  options: LegacyGeneratedWorkflowJobSendOptions = {},
): Promise<LegacyGeneratedWorkflowJobSendResult> {
  const executionTimeoutMs = payload.timeoutMs ?? 300_000;
  const { sent, resultPromise } = directWsServer.sendLegacyGeneratedWorkflowJob(
    deviceId,
    payload,
    options.resultTimeoutMs ?? executionTimeoutMs + LEGACY_GENERATED_WORKFLOW_RESULT_GRACE_MS,
  );
  return {
    decision: sent ? "dispatched" : "offline",
    root: null,
    operation: undefined,
    handle: undefined,
    reason: sent ? undefined : "device_offline",
    sent,
    queued: false,
    resultPromise,
  };
}

/**
 * G3 production JOB egress for roots that are admitted to the PNQ ledger.
 *
 * This keeps the DB as the source of truth for FIFO, ownership generation,
 * operation identity, waiter registration, send completion, and terminal CAS.
 */
export async function sendDeviceExecutionJobToDevice(
  deviceId: string,
  payload: JobDispatchPayload,
  options: DeviceExecutionJobSendOptions = {},
): Promise<StandaloneJobSendResult> {
  if (!isDeviceExecutionEnforced()) {
    const sent = sendJobToDevice(deviceId, payload);
    return { decision: sent ? "dispatched" : "offline", root: null, operation: undefined, handle: undefined, sent, queued: false };
  }
  const boundaryPolicy = options.boundary ? await getDeviceExecutionBoundaryPolicy(options.boundary) : undefined;
  const effectiveRootKind = boundaryPolicy?.requiresExistingRootHandle ? boundaryPolicy.rootKind : (options.rootKind ?? boundaryPolicy?.rootKind ?? "job");
  const rootExternalId = options.rootExternalId ?? payload.jobId;
  const replayEnvelope: DeviceExecutionJobReplayEnvelopeV1 = {
    schemaVersion: "pnq.job-dispatch/v1",
    deviceId,
    rootKind: effectiveRootKind,
    rootExternalId,
    operationKind: "job",
    operationId: payload.jobId,
    boundary: options.boundary ?? "standalone_job",
    payload: structuredClone(payload),
  };
  const result = await deviceExecutionArbiter.runStandaloneJobEgress({
    deviceId,
    jobId: payload.jobId,
    rootId: options.rootId,
    rootExternalId: options.rootExternalId,
    rootKind: effectiveRootKind,
    operationKind: options.operationKind ?? "job",
    boundary: options.boundary,
    requestKey: options.requestKey ?? payload.jobId,
    actor: options.actor ?? "transport.g3",
    metadata: {
      ...(options.metadata ?? {}),
      jobType: payload.type,
      timeoutMs: payload.timeoutMs ?? null,
      requiresRoot: payload.requiresRoot ?? false,
      dispatchEnvelope: replayEnvelope,
      observeSource: options.metadata?.observeSource ?? "transport.sendDeviceExecutionJobToDevice",
    },
    registerWaiter: (permit) => {
      directWsServer.registerJobWaiterWithPermit(permit, payload.timeoutMs ?? 300_000);
    },
    wireDispatch: (permit) => directWsServer.sendJobWithPermit(permit, payload),
  });

  if (!result.sent && result.permit) {
    directWsServer.rejectJobWaiterWithPermit(
      result.permit,
      `Job ${payload.jobId} was not sent (${result.decision}${result.reason ? `: ${result.reason}` : ""})`,
    );
  }

  return {
    decision: result.decision,
    root: result.root,
    operation: result.operation,
    handle: result.handle,
    reason: result.reason,
    sent: result.sent,
    queued: !result.sent && await isDeviceExecutionResultQueued(result),
  };
}

export async function dispatchQueuedJobsForDevice(
  deviceId: string,
  actor = "transport.queue_pump",
): Promise<{ attempted: number; sent: number }> {
  if (!isDeviceExecutionEnforced()) return { attempted: 0, sent: 0 };
  if (!directWsServer.isDeviceOnline(deviceId)) return { attempted: 0, sent: 0 };

  let attempted = 0;
  let sent = 0;
  while (directWsServer.isDeviceOnline(deviceId)) {
    const envelope = await nextQueuedDispatchEnvelope(deviceId);
    if (!envelope) break;
    attempted += 1;
    const result = envelope.schemaVersion === "pnq.job-dispatch/v1"
      ? await sendDeviceExecutionJobToDevice(deviceId, envelope.payload, {
          boundary: envelope.boundary,
          rootKind: envelope.rootKind,
          rootExternalId: envelope.rootExternalId,
          requestKey: envelope.rootExternalId,
          actor,
          metadata: { observeSource: "transport.dispatchQueuedJobsForDevice" },
        })
      : await sendEdgeWorkflowToDeviceEnforced(
          deviceId,
          envelope.operationId,
          envelope.template,
          envelope.variables,
          { actor, observeSource: "transport.dispatchQueuedJobsForDevice" },
        );
    if (!result.sent) break;
    if (envelope.schemaVersion === "pnq.edge-workflow-dispatch/v1") {
      await promoteReplayedEdgeWorkflowToRunning({
        workflowId: envelope.operationId,
        deviceId,
        templateId: typeof envelope.template.id === "string" ? envelope.template.id : undefined,
        variables: envelope.variables,
        actor,
      });
    }
    sent += 1;
  }
  return { attempted, sent };
}

export async function sweepQueuedJobsForOnlineDevices(
  actor = "transport.queue_sweep",
): Promise<{ devices: number; attempted: number; sent: number }> {
  if (!isDeviceExecutionEnforced()) return { devices: 0, attempted: 0, sent: 0 };
  const deviceIds = directWsServer.getConnectedDeviceIds();
  let attempted = 0;
  let sent = 0;
  for (const deviceId of deviceIds) {
    const result = await dispatchQueuedJobsForDevice(deviceId, actor);
    attempted += result.attempted;
    sent += result.sent;
  }
  return { devices: deviceIds.length, attempted, sent };
}

export async function sendBatchToDeviceEnforced(
  deviceId: string,
  batchPayload: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  return sendBatchThroughBoundary(deviceId, batchPayload, timeoutMs, {
    boundary: "edge_batch",
    actor: "transport.g3.batch",
  });
}

export async function sendServerWorkflowBatchChildToDevice(
  deviceId: string,
  workflowRootExternalId: string,
  batchPayload: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  if (!workflowRootExternalId) throw new Error("Server workflow batch child requires canonical workflow root identity");
  if (batchPayload.workflowId !== workflowRootExternalId) {
    throw new Error("Server workflow BATCH payload workflowId does not match canonical workflow root identity");
  }
  return sendBatchThroughBoundary(deviceId, batchPayload, timeoutMs, {
    boundary: "server_workflow_batch_child",
    rootExternalId: workflowRootExternalId,
    actor: "transport.g3.server_workflow_batch_child",
  });
}

async function sendBatchThroughBoundary(
  deviceId: string,
  batchPayload: Record<string, unknown>,
  timeoutMs: number,
  options: {
    boundary: "edge_batch" | "server_workflow_batch_child";
    rootExternalId?: string;
    actor: string;
  },
): Promise<any> {
  const batchId = batchPayload.batchId;
  if (typeof batchId !== "string" || !batchId) throw new Error("BATCH_START requires batchId");
  if (!isDeviceExecutionEnforced()) {
    const resultPromise = directWsServer.waitForBatchResult(batchId, timeoutMs, deviceId);
    const sent = sendObserveOnlyBatchToDevice(deviceId, batchPayload);
    void deviceExecutionArbiter.observeDispatch({ deviceId, rootKind: options.boundary === "edge_batch" ? "batch" : "server_workflow", externalId: options.rootExternalId ?? batchId, requestKey: options.rootExternalId ?? batchId, sent, actor: options.actor, metadata: { authorityMode: "observe_only" } });
    if (!sent) {
      directWsServer.rejectObserveOnlyBatchWaiter(batchId, deviceId, "batch_not_sent_offline");
      throw new Error(`Batch ${batchId} was not sent: offline`);
    }
    return resultPromise;
  }
  let resultPromise: Promise<any> | undefined;
  const dispatch = await deviceExecutionArbiter.runObservedEgress({
    deviceId,
    boundary: options.boundary,
    rootExternalId: options.rootExternalId,
    operationId: batchId,
    wireType: "BATCH_START",
    actor: options.actor,
    metadata: { workflowId: batchPayload.workflowId ?? null },
    registerWaiter: (handle) => {
      resultPromise = directWsServer.registerBatchWaiterWithHandle(handle, timeoutMs);
    },
    wireDispatch: (handle) => directWsServer.sendBatchWithHandle(handle, batchPayload),
  });
  if (!dispatch.sent || !dispatch.handle || !resultPromise) {
    if (dispatch.handle) directWsServer.rejectBatchWaiterWithHandle(dispatch.handle, dispatch.reason ?? "batch_not_sent");
    if (
      options.boundary === "edge_batch" &&
      await isDeviceExecutionResultQueued(dispatch) &&
      dispatch.handle
    ) {
      await cancelUnreplayableObservedAttempt(dispatch.handle, "queued_edge_batch_not_replayable");
    }
    throw new Error(`Batch ${batchId} was not sent: ${dispatch.reason ?? dispatch.decision}`);
  }
  return resultPromise;
}

function sendObserveOnlyBatchToDevice(deviceId: string, batchPayload: Record<string, unknown>): boolean {
  assertObserveOnlyTransportBoundary("observe-only BATCH transport compatibility");
  return directWsServer.sendBatch(deviceId, batchPayload);
}

export async function sendEdgeWorkflowToDeviceEnforced(
  deviceId: string,
  workflowId: string,
  template: Record<string, unknown>,
  variables?: Record<string, unknown>,
  options: { actor?: string; observeSource?: string } = {},
): Promise<EdgeWorkflowSendResult> {
  if (!isDeviceExecutionEnforced()) {
    const sent = sendObserveOnlyWorkflowStartToDevice(deviceId, workflowId, template, variables);
    void deviceExecutionArbiter.observeDispatch({ deviceId, rootKind: "edge_workflow", externalId: workflowId, requestKey: workflowId, sent, actor: options.actor ?? "transport.observe_only.edge_workflow", metadata: { authorityMode: "observe_only" } });
    return { decision: sent ? "dispatched" : "offline", root: null, operation: undefined, handle: undefined, sent, queued: false };
  }
  const replayEnvelope: DeviceExecutionEdgeWorkflowReplayEnvelopeV1 = {
    schemaVersion: "pnq.edge-workflow-dispatch/v1",
    deviceId,
    rootKind: "edge_workflow",
    rootExternalId: workflowId,
    operationKind: "workflow",
    operationId: workflowId,
    boundary: "edge_workflow",
    template: structuredClone(template),
    variables: variables === undefined ? undefined : structuredClone(variables),
  };
  const dispatch = await deviceExecutionArbiter.runObservedEgress({
    deviceId,
    boundary: "edge_workflow",
    operationId: workflowId,
    wireType: "WORKFLOW_START",
    actor: options.actor ?? "transport.g3.edge_workflow",
    metadata: {
      templateId: template.id ?? null,
      dispatchEnvelope: replayEnvelope,
      observeSource: options.observeSource ?? "transport.sendEdgeWorkflowToDeviceEnforced",
    },
    wireDispatch: (handle) => directWsServer.sendWorkflowStartWithHandle(handle, template, variables),
  });
  return {
    decision: dispatch.decision,
    root: dispatch.root,
    operation: dispatch.operation,
    handle: dispatch.handle,
    reason: dispatch.reason,
    sent: dispatch.sent,
    queued: !dispatch.sent && await isDeviceExecutionResultQueued(dispatch),
  };
}

function sendObserveOnlyWorkflowStartToDevice(
  deviceId: string,
  workflowId: string,
  template: Record<string, unknown>,
  variables?: Record<string, unknown>,
): boolean {
  assertObserveOnlyTransportBoundary("observe-only WORKFLOW transport compatibility");
  return directWsServer.sendWorkflowStart(deviceId, template, variables, workflowId);
}

async function cancelUnreplayableObservedAttempt(
  handle: import("../modules/device-execution").DeviceExecutionHandle,
  reason: string,
): Promise<void> {
  const target = await getDb().query<{ status: string }>(
    `SELECT target.status
       FROM device_execution_roots root
       JOIN lifecycle_resource_bindings binding
         ON binding.resource_table = to_regclass('device_execution_roots')
        AND binding.state_column = 'state'::name
       JOIN lifecycle_transitions transition
         ON transition.lifecycle_key = binding.lifecycle_key
        AND transition.from_status = root.state
       JOIN lifecycle_state_definitions target
         ON target.lifecycle_key = transition.lifecycle_key
        AND target.status = transition.to_status
      WHERE root.id = $1
        AND target.terminal
        AND target.administrative
      ORDER BY target.sort_order, transition.action_key
      LIMIT 1`,
    [handle.rootId],
  );
  const terminalStatus = target.rows[0]?.status;
  if (!terminalStatus) {
    throw new Error(`No administrative terminal transition is configured for PNQ attempt ${handle.operationId}`);
  }
  const cancelled = await deviceExecutionArbiter.observeTerminal({
    deviceId: handle.deviceId,
    handle,
    status: terminalStatus,
    actor: "transport.unreplayable_observed_attempt",
    reason,
    metadata: { queueDisposition: "cancelled_before_fallback", handle: encodeDeviceExecutionHandle(handle) },
  });
  if (!(await isDeviceExecutionResultTerminal(cancelled))) {
    throw new Error(`Failed to cancel unreplayable PNQ attempt ${handle.operationId}: ${cancelled.reason ?? cancelled.decision}`);
  }
}

export async function sendWorkflowCancellationControl(deviceId: string, workflowId: string): Promise<boolean> {
  await deviceExecutionArbiter.recordControlEgress({
    deviceId,
    operationId: workflowId,
    controlKind: "workflow_cancel",
    actor: "transport.control.workflow_cancel",
  });
  return directWsServer.sendWorkflowCancel(deviceId, workflowId);
}

/**
 * Wait for a job result with timeout.
 */
export function waitForResult(jobId: string, timeoutMs: number): Promise<any> {
  return directWsServer.waitForJobResult(jobId, timeoutMs);
}

/**
 * Check if device is online via DirectWS transport.
 */
export function isDeviceOnline(deviceId: string): boolean {
  return directWsServer.isDeviceOnline(deviceId);
}

/**
 * Get list of devices online via DirectWS transport.
 */
export function getOnlineDevices(): string[] {
  return directWsServer.getConnectedDeviceIds();
}

function observeJobDispatch(deviceId: string, payload: JobDispatchPayload, sent: boolean): void {
  deviceExecutionArbiter.observeDispatch({
    deviceId,
    rootKind: "job",
    externalId: payload.jobId,
    requestKey: payload.jobId,
    sent,
    actor: "transport",
    metadata: {
      jobType: payload.type,
      timeoutMs: payload.timeoutMs ?? null,
      requiresRoot: payload.requiresRoot ?? false,
      observeSource: "transport.sendJobToDevice",
    },
  }).catch((err) => {
    console.error("[device-execution] observe job dispatch failed:", (err as Error).message);
  });
}

type QueuedDispatchEnvelope = DeviceExecutionJobReplayEnvelopeV1 | DeviceExecutionEdgeWorkflowReplayEnvelopeV1;

async function nextQueuedDispatchEnvelope(deviceId: string): Promise<QueuedDispatchEnvelope | null> {
  const result = await getDb().query<{
    root_id: string;
    root_kind: DeviceExecutionRootKind;
    root_external_id: string;
    operation_id: string;
    owner_generation: string | number;
    metadata: Record<string, unknown>;
  }>(
    `
    SELECT roots.id AS root_id,
           roots.root_kind,
           roots.external_id AS root_external_id,
           roots.owner_generation,
           operations.operation_id,
           operations.metadata
    FROM device_execution_roots roots
    JOIN device_execution_operations operations ON operations.root_id = roots.id
    JOIN lifecycle_resource_bindings root_binding
      ON root_binding.resource_table = to_regclass('device_execution_roots')
     AND root_binding.state_column = 'state'::name
    JOIN lifecycle_state_definitions root_state
      ON root_state.lifecycle_key = root_binding.lifecycle_key
     AND root_state.status = roots.state
    WHERE roots.device_id = $1
      AND roots.root_kind IN ('job', 'server_workflow', 'edge_workflow')
      AND root_state.initial
      AND NOT root_state.terminal
      AND operations.operation_kind IN ('job', 'workflow')
    ORDER BY roots.fifo_sequence ASC
    LIMIT 1
    `,
    [deviceId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const envelope = row.metadata?.dispatchEnvelope;
  if (isJobReplayEnvelope(envelope, {
    deviceId,
    rootKind: row.root_kind,
    rootExternalId: row.root_external_id,
    operationId: row.operation_id,
  })) {
    return structuredClone(envelope);
  }
  if (isEdgeWorkflowReplayEnvelope(envelope, {
    deviceId,
    rootKind: row.root_kind,
    rootExternalId: row.root_external_id,
    operationId: row.operation_id,
  })) {
    return structuredClone(envelope);
  }
  await deviceExecutionArbiter.markCorruptQueueHead({
    deviceId,
    rootId: row.root_id,
    rootKind: row.root_kind,
    ownerGeneration: Number(row.owner_generation),
    operationId: row.operation_id,
    actor: "transport.queue_replay",
    reason: "invalid_or_mismatched_dispatch_envelope",
    metadata: { envelope: envelope ?? null },
  });
  return null;
}

export function isJobReplayEnvelope(
  value: unknown,
  identity: Pick<DeviceExecutionJobReplayEnvelopeV1, "deviceId" | "rootKind" | "rootExternalId" | "operationId">,
): value is DeviceExecutionJobReplayEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<DeviceExecutionJobReplayEnvelopeV1>;
  return envelope.schemaVersion === "pnq.job-dispatch/v1" &&
    envelope.deviceId === identity.deviceId &&
    envelope.rootKind === identity.rootKind &&
    envelope.rootExternalId === identity.rootExternalId &&
    envelope.operationKind === "job" &&
    envelope.operationId === identity.operationId &&
    typeof envelope.boundary === "string" &&
    !!envelope.payload &&
    typeof envelope.payload === "object" &&
    envelope.payload.jobId === identity.operationId &&
    typeof envelope.payload.type === "string";
}

export function isEdgeWorkflowReplayEnvelope(
  value: unknown,
  identity: {
    deviceId: string;
    rootKind: DeviceExecutionRootKind;
    rootExternalId: string | null;
    operationId: string;
  },
): value is DeviceExecutionEdgeWorkflowReplayEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<DeviceExecutionEdgeWorkflowReplayEnvelopeV1>;
  return envelope.schemaVersion === "pnq.edge-workflow-dispatch/v1" &&
    envelope.deviceId === identity.deviceId &&
    identity.rootKind === "edge_workflow" &&
    envelope.rootKind === "edge_workflow" &&
    envelope.rootExternalId === identity.rootExternalId &&
    envelope.operationKind === "workflow" &&
    envelope.operationId === identity.operationId &&
    envelope.boundary === "edge_workflow" &&
    !!envelope.template &&
    typeof envelope.template === "object";
}
