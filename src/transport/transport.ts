/**
 * transport/transport.ts
 * 
 * Transport abstraction layer for device communication.
 * DirectWS only transport.
 */

import { directWsServer } from "../ws/direct-ws.server";
import { deviceExecutionArbiter } from "../modules/device-execution";
import type { JobDispatchPayload } from "../../shared/protocol/messages";

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
