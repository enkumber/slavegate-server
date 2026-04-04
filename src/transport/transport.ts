/**
 * transport/transport.ts
 * 
 * Transport abstraction layer for device communication.
 * Handles fallback between DirectWS (primary) and Nostr (fallback).
 */

import { directWsServer } from "../ws/direct-ws.server";
import { getNostrAdapter } from "../nostr/adapter";
import type { JobDispatchPayload } from "../../shared/protocol/messages";

/**
 * Send a job to a device via the best available transport.
 * Priority: DirectWS first (instant), then Nostr fallback.
 * Returns true if sent via any transport, false if device unreachable.
 */
export function sendJobToDevice(deviceId: string, payload: JobDispatchPayload): boolean {
  // Priority 1: DirectWs (sub-second latency)
  if (directWsServer.isDeviceOnline(deviceId)) {
    return directWsServer.sendJob(deviceId, payload);
  }
  
  // Priority 2: Nostr (8-10s latency, but reliable fallback)
  const nostr = getNostrAdapter();
  if (nostr) {
    nostr.sendJob(deviceId, payload as unknown as Parameters<typeof nostr.sendJob>[1]);
    return true;
  }
  
  return false;
}

/**
 * Wait for a job result with timeout.
 * Currently only DirectWS supports waiting for results.
 * Nostr results come via callbacks to dispatcherService.
 */
export function waitForResult(jobId: string, timeoutMs: number): Promise<any> {
  return directWsServer.waitForJobResult(jobId, timeoutMs);
}

/**
 * Check if device is online via any transport.
 */
export function isDeviceOnline(deviceId: string): boolean {
  return directWsServer.isDeviceOnline(deviceId) || 
         (getNostrAdapter()?.isDeviceOnline(deviceId) ?? false);
}

/**
 * Get list of devices online via any transport.
 */
export function getOnlineDevices(): string[] {
  const directWsDevices = directWsServer.getConnectedDeviceIds();
  const nostrDevices = getNostrAdapter()?.getOnlineDeviceIds() ?? [];
  
  // Deduplicate
  const allDevices = new Set([...directWsDevices, ...nostrDevices]);
  return Array.from(allDevices);
}