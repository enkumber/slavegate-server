/**
 * transport/transport.ts
 * 
 * Transport abstraction layer for device communication.
 * DirectWS only transport.
 */

import { directWsServer } from "../ws/direct-ws.server";
import type { JobDispatchPayload } from "../../shared/protocol/messages";
import { deviceExecutionLeaseService } from "../modules/device-execution/device-execution-lease.service";

/**
 * Send a job to a device via DirectWS transport.
 * Returns true if sent successfully, false if device unreachable.
 */
export function sendJobToDevice(deviceId: string, payload: JobDispatchPayload): boolean {
  // DirectWs only
  if (directWsServer.isDeviceOnline(deviceId)) {
    try {
      const lease = deviceExecutionLeaseService.tryAcquire(deviceId, { ingress: "transport.sendJob", requestKey: payload.jobId });
      const sent = directWsServer.sendJob(deviceId, payload, lease);
      if (!sent) deviceExecutionLeaseService.release(lease);
      return sent;
    } catch (error) {
      if ((error as { code?: string }).code === "DEVICE_BUSY") return false;
      throw error;
    }
  }
  
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
