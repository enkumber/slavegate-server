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
  DeviceExecutionRootKind,
  DeviceExecutionStandaloneJobEgressResult,
} from "../modules/device-execution";
import type { JobDispatchPayload } from "../../shared/protocol/messages";

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
  requestKey?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Send a job to a device via DirectWS transport.
 * Returns true if sent successfully, false if device unreachable.
 */
export function sendJobToDevice(deviceId: string, payload: JobDispatchPayload): boolean {
  // DirectWs only
  if (directWsServer.isDeviceOnline(deviceId)) {
    const sent = directWsServer.sendJob(deviceId, payload);
    observeJobDispatch(deviceId, payload, sent);
    return sent;
  }

  observeJobDispatch(deviceId, payload, false);
  return false;
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
  const result = await deviceExecutionArbiter.runStandaloneJobEgress({
    deviceId,
    jobId: payload.jobId,
    rootKind: options.rootKind,
    operationKind: options.operationKind ?? "job",
    boundary: options.boundary,
    requestKey: options.requestKey ?? payload.jobId,
    actor: options.actor ?? "transport.g3",
    metadata: {
      ...(options.metadata ?? {}),
      jobType: payload.type,
      timeoutMs: payload.timeoutMs ?? null,
      requiresRoot: payload.requiresRoot ?? false,
      dispatchEnvelope: payload,
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
    queued: result.decision === "would_wait" || (result.root?.state === "queued" && !result.sent),
  };
}

export async function dispatchQueuedJobsForDevice(
  deviceId: string,
  actor = "transport.queue_pump",
): Promise<{ attempted: number; sent: number }> {
  if (!directWsServer.isDeviceOnline(deviceId)) return { attempted: 0, sent: 0 };

  let attempted = 0;
  let sent = 0;
  while (directWsServer.isDeviceOnline(deviceId)) {
    const envelope = await nextQueuedJobEnvelope(deviceId);
    if (!envelope) break;
    attempted += 1;
    const result = await sendDeviceExecutionJobToDevice(deviceId, envelope, {
      boundary: "standalone_job",
      rootKind: "job",
      requestKey: envelope.jobId,
      actor,
      metadata: { observeSource: "transport.dispatchQueuedJobsForDevice" },
    });
    if (!result.sent) break;
    sent += 1;
  }
  return { attempted, sent };
}

export async function sweepQueuedJobsForOnlineDevices(
  actor = "transport.queue_sweep",
): Promise<{ devices: number; attempted: number; sent: number }> {
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

async function nextQueuedJobEnvelope(deviceId: string): Promise<JobDispatchPayload | null> {
  const result = await getDb().query<{ metadata: Record<string, unknown> }>(
    `
    SELECT operations.metadata
    FROM device_execution_roots roots
    JOIN device_execution_operations operations ON operations.root_id = roots.id
    WHERE roots.device_id = $1
      AND roots.root_kind = 'job'
      AND roots.state = 'queued'
      AND operations.operation_kind = 'job'
    ORDER BY roots.fifo_sequence ASC
    LIMIT 1
    `,
    [deviceId]
  );
  const envelope = result.rows[0]?.metadata?.dispatchEnvelope;
  return isJobDispatchPayload(envelope) ? envelope : null;
}

function isJobDispatchPayload(value: unknown): value is JobDispatchPayload {
  return !!value && typeof value === "object" && typeof (value as JobDispatchPayload).jobId === "string";
}
