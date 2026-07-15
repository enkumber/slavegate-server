/**
 * transport/transport.ts
 * 
 * Transport abstraction layer for device communication.
 * DirectWS only transport.
 */

import { directWsServer } from "../ws/direct-ws.server";
import { deviceExecutionArbiter } from "../modules/device-execution";
import type { DeviceExecutionStandaloneJobEgressResult } from "../modules/device-execution";
import type { JobDispatchPayload } from "../../shared/protocol/messages";

export type StandaloneJobSendResult = Pick<
  DeviceExecutionStandaloneJobEgressResult,
  "decision" | "root" | "operation" | "handle" | "reason" | "sent"
> & {
  queued: boolean;
};

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
  const result = await deviceExecutionArbiter.runStandaloneJobEgress({
    deviceId,
    jobId: payload.jobId,
    requestKey: payload.jobId,
    actor: "transport.g2",
    metadata: {
      jobType: payload.type,
      timeoutMs: payload.timeoutMs ?? null,
      requiresRoot: payload.requiresRoot ?? false,
      observeSource: "transport.sendStandaloneJobToDevice",
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
