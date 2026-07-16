/**
 * ws/direct-ws.server.ts
 * Direct WebSocket transport for device communication.
 *
 * Designed for phones behind DDNS + port-forward where sub-second latency matters.
 *
 * Auth flow:
 *   1. Device connects: ws://host:21211/ws-direct
 *   2. Device → { type: "AUTH", deviceKey: "<token>", deviceId: "<uuid>" }
 *   3. Server validates token from DB (devices.device_key column)
 *   4. Server → { type: "AUTH_OK", deviceId }  or  { type: "AUTH_FAIL", reason }
 *
 * Protocol:
 *   Server → Device: { type: "JOB",        jobId, jobType, params }
 *   Device → Server: { type: "JOB_RESULT", jobId, success, output, error }
 *   Device → Server: { type: "HEARTBEAT",  battery, charging, foregroundApp, timestamp }
 *   Server → Device: { type: "ACK",        ref }
 *   Both ways:       { type: "PING" } / { type: "PONG" }
 *
 * Transport interface compatible with routes.ts.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { getDb } from "../db/client";
import { scalabilityConfig } from "../config/scalability.config";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import {
  decodeDeviceExecutionHandle,
  encodeDeviceExecutionHandle,
  deviceExecutionArbiter,
  type DeviceExecutionJobDispatchPermit,
  type DeviceExecutionHandle,
  type DeviceExecutionRootKind,
} from "../modules/device-execution";
import { devicesService } from "../modules/devices/devices.service";
import { devicesConnected, deviceOfflineEvents, recordDeviceHealth } from "../modules/observability/metrics";
import { alerting } from "../modules/observability/alerts";
import { visionService } from "../modules/vision/vision.service";
import { workflowEvents } from "../modules/workflow-events";
import { llmComplete } from "../utils/llm";
import type { JobDispatchPayload, DeviceHealth } from "../../shared/protocol/messages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function handlesEqual(left: DeviceExecutionHandle, right: DeviceExecutionHandle): boolean {
  return left.rootId === right.rootId &&
    left.deviceId === right.deviceId &&
    left.rootKind === right.rootKind &&
    left.ownerGeneration === right.ownerGeneration &&
    left.operationKind === right.operationKind &&
    left.operationId === right.operationId;
}

export interface DirectWsResultHandleResolution {
  accepted: boolean;
  reportedHandle: DeviceExecutionHandle | null;
  compatibility: "echoed_handle" | "authenticated_pending_handle" | "rejected";
  reason?: "reported_handle_invalid" | "reported_handle_mismatch";
}

/**
 * Android agents deployed before PNQ handles do not echo the extra `pnqHandle`
 * property. The authenticated socket plus the exact server-side pending handle
 * is therefore the compatibility identity. If a device does report a handle,
 * it must decode and match every field; callers still perform the DB CAS.
 */
export function resolveDirectWsResultHandle(
  expectedHandle: DeviceExecutionHandle,
  message: Record<string, unknown>,
): DirectWsResultHandleResolution {
  if (!("pnqHandle" in message) || message.pnqHandle == null) {
    return {
      accepted: true,
      reportedHandle: null,
      compatibility: "authenticated_pending_handle",
    };
  }
  const reportedHandle = decodeDeviceExecutionHandle(message.pnqHandle);
  if (!reportedHandle) {
    return {
      accepted: false,
      reportedHandle: null,
      compatibility: "rejected",
      reason: "reported_handle_invalid",
    };
  }
  if (!handlesEqual(expectedHandle, reportedHandle)) {
    return {
      accepted: false,
      reportedHandle,
      compatibility: "rejected",
      reason: "reported_handle_mismatch",
    };
  }
  return {
    accepted: true,
    reportedHandle,
    compatibility: "echoed_handle",
  };
}

function observeRootDispatch(
  rootKind: DeviceExecutionRootKind,
  deviceId: string,
  externalId: string,
  sent: boolean,
  metadata: Record<string, unknown>,
): void {
  if (!externalId || externalId === "?") return;
  deviceExecutionArbiter.observeDispatch({
    deviceId,
    rootKind,
    externalId,
    requestKey: typeof metadata.workflowId === "string" ? metadata.workflowId : externalId,
    sent,
    actor: "direct_ws",
    metadata,
  }).catch((err) => {
    console.error("[device-execution] observe direct-ws dispatch failed:", (err as Error).message);
  });
}

function observeRootTerminal(
  rootKind: DeviceExecutionRootKind,
  deviceId: string,
  externalId: string | undefined,
  status: string,
  reason: string | undefined,
  metadata: Record<string, unknown>,
): void {
  if (!externalId) return;
  deviceExecutionArbiter.observeTerminal({
    deviceId,
    rootKind,
    externalId,
    status,
    actor: "direct_ws",
    reason: reason ?? status,
    metadata,
  }).catch((err) => {
    console.error("[device-execution] observe direct-ws terminal failed:", (err as Error).message);
  });
}

export function mergeWorkflowStatusVariables(
  existingCheckpoint: unknown,
  reportedVariables: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const existingVariables = isRecord(existingCheckpoint)
    && isRecord(existingCheckpoint.variables)
    ? existingCheckpoint.variables
    : {};
  const merged: Record<string, unknown> = { ...existingVariables };
  if (reportedVariables) {
    for (const [key, value] of Object.entries(reportedVariables)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS       = scalabilityConfig.wsAuthTimeout;
const PONG_TIMEOUT_MS       = scalabilityConfig.wsPongTimeout;
const PING_INTERVAL_MS      = scalabilityConfig.wsPingInterval;
const OFFLINE_THRESHOLD_MS  = scalabilityConfig.wsPongTimeout;
const MAX_MSG_BYTES         = scalabilityConfig.wsMaxMessageSize;
const RATE_LIMIT            = scalabilityConfig.wsRateLimitPerSecond;
const RATE_WINDOW_MS        = 1_000;
const MAX_WS_CONNECTIONS    = scalabilityConfig.maxWsConnections;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectedDevice {
  ws:           WebSocket;
  deviceId:     string;
  connectedAt:  number;
  lastSeenAt:   number;
  lastPongAt:   number;
  msgCount:     number;
  windowStart:  number;
  agentVersion: string;  // For backward compat routing (ADR-001)
}

interface PendingJob {
  promise: Promise<JobResult>;
  resolve: (result: JobResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
  deviceId?: string;
  permit?: DeviceExecutionJobDispatchPermit;
}

interface PendingBatch {
  promise: Promise<BatchResult>;
  resolve: (result: BatchResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
  handle: DeviceExecutionHandle;
}

interface PendingWorkflow {
  handle: DeviceExecutionHandle;
  timer: ReturnType<typeof setTimeout>;
}

interface OtaDeviceStatus {
  deviceId: string;
  status: string;
  version?: string;
  versionCode?: number;
  apkSha256?: string;
  error?: string;
  updatedAt: string;
}

interface JobResult {
  jobId:    string;
  success:  boolean;
  status:   string;
  output:   unknown;
  error?:   string;
}

interface BatchResult {
  batchId:         string;
  workflowId:      string;
  status:          string;
  results:         unknown[];
  executedAt:       string;
  totalDurationMs: number;
  error?:          string;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  private windows = new Map<string, number[]>();
  allow(key: string, limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS): boolean {
    const now   = Date.now();
    const times = (this.windows.get(key) ?? []).filter(t => now - t < windowMs);
    if (times.length >= limit) return false;
    times.push(now);
    this.windows.set(key, times);
    return true;
  }
  delete(key: string): void { this.windows.delete(key); }
}

// ─── DirectWsServer ───────────────────────────────────────────────────────────

export class DirectWsServer {
  private wss:          WebSocketServer | null = null;
  private connections = new Map<string, ConnectedDevice>();   // deviceId → conn
  private pendingJobs = new Map<string, PendingJob>();        // jobId → awaiter
  private pendingBatches = new Map<string, PendingBatch>();   // batchId → awaiter
  private pendingWorkflows = new Map<string, PendingWorkflow>();
  private otaStatuses = new Map<string, OtaDeviceStatus>();   // deviceId → last OTA status
  private rateLimiter = new RateLimiter();
  private pingTimer:    ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  attach(): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    this.wss.on("error", (err) => console.error("[direct-ws] WSS error:", err.message));

    // Periodic PING + stale connection cleanup
    this.pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
    console.log("[direct-ws] Ready for HTTP upgrade routing on /ws-direct");
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit("connection", ws, req);
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss?.close();
    const ambiguityWrites: Promise<unknown>[] = [];
    // Reject all pending jobs
    for (const [jobId, pending] of this.pendingJobs) {
      clearTimeout(pending.timer);
      if (pending.permit) {
        ambiguityWrites.push(deviceExecutionArbiter.markAmbiguous({
          deviceId: pending.permit.handle.deviceId,
          handle: pending.permit.handle,
          reason: "direct_ws_server_shutdown_before_result",
          actor: "direct_ws_close",
          state: "blocked",
          metadata: { handle: pending.permit.wireHandle },
        }));
      }
      pending.reject(new Error("Server shutting down"));
      this.pendingJobs.delete(jobId);
    }
    // Reject all pending batches
    for (const [batchId, pending] of this.pendingBatches) {
      clearTimeout(pending.timer);
      ambiguityWrites.push(deviceExecutionArbiter.markAmbiguous({
        deviceId: pending.handle.deviceId,
        handle: pending.handle,
        reason: "direct_ws_server_shutdown_before_batch_result",
        actor: "direct_ws_close",
        state: "blocked",
      }));
      pending.reject(new Error("Server shutting down"));
      this.pendingBatches.delete(batchId);
    }
    for (const [workflowId, pending] of this.pendingWorkflows) {
      clearTimeout(pending.timer);
      ambiguityWrites.push(deviceExecutionArbiter.markAmbiguous({
        deviceId: pending.handle.deviceId,
        handle: pending.handle,
        reason: "direct_ws_server_shutdown_before_workflow_terminal",
        actor: "direct_ws_close",
        state: "blocked",
      }));
      this.pendingWorkflows.delete(workflowId);
    }
    const ambiguityResults = await Promise.allSettled(ambiguityWrites);
    for (const result of ambiguityResults) {
      if (result.status === "rejected") {
        console.error("[device-execution] shutdown ambiguity mark failed:", (result.reason as Error).message);
      }
    }
  }

  // ─── Public API (transport interface) ────────────────────────────────────

  /**
   * Send a job to a device. Returns true if sent, false if device not connected.
   * Does NOT wait for result — use waitForJobResult() for that.
   */
  sendJob(deviceId: string, payload: JobDispatchPayload): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    this._send(conn.ws, {
      type:    "JOB",
      jobId:   payload.jobId,
      jobType: payload.type,
      params:  payload.params,
      timeoutMs: payload.timeoutMs,
      requiresRoot: payload.requiresRoot,
    });
    console.log(`[direct-ws] sendJob: device=${deviceId.slice(0,8)} jobId=${payload.jobId?.slice(0,8)} type=${payload.type}`);
    return true;
  }

  sendJobWithPermit(permit: DeviceExecutionJobDispatchPermit, payload: JobDispatchPayload): boolean {
    if (permit.kind !== "device_execution_job_dispatch_permit") {
      throw new Error("DirectWS JOB send requires a PNQ device-execution permit");
    }
    if (
      permit.handle.operationKind !== "job" ||
      (permit.handle.rootKind !== "job" && permit.handle.rootKind !== "server_workflow")
    ) {
      throw new Error("DirectWS JOB permit must target a standalone job or server-workflow child operation");
    }
    if (permit.handle.operationId !== payload.jobId) {
      throw new Error("DirectWS JOB permit operation id does not match payload jobId");
    }

    const deviceId = permit.handle.deviceId;
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    this._send(conn.ws, {
      type:    "JOB",
      jobId:   payload.jobId,
      jobType: payload.type,
      params:  payload.params,
      timeoutMs: payload.timeoutMs,
      requiresRoot: payload.requiresRoot,
      pnqHandle: permit.wireHandle,
    });
    console.log(`[direct-ws] sendJobWithPermit: device=${deviceId.slice(0,8)} jobId=${payload.jobId?.slice(0,8)} type=${payload.type} gen=${permit.handle.ownerGeneration}`);
    return true;
  }

  registerJobWaiterWithPermit(
    permit: DeviceExecutionJobDispatchPermit,
    timeoutMs = 300_000,
  ): Promise<JobResult> {
    return this.registerJobWaiter(permit.handle.operationId, timeoutMs, permit);
  }

  rejectJobWaiterWithPermit(permit: DeviceExecutionJobDispatchPermit, reason: string): boolean {
    const jobId = permit.handle.operationId;
    const pending = this.pendingJobs.get(jobId);
    if (
      !pending?.permit ||
      pending.permit.handle.rootId !== permit.handle.rootId ||
      pending.permit.handle.ownerGeneration !== permit.handle.ownerGeneration
    ) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingJobs.delete(jobId);
    pending.reject(new Error(reason));
    return true;
  }

  /**
   * Returns a Promise that resolves when JOB_RESULT arrives for this jobId.
   * Rejects after timeoutMs (default: 5 min).
   */
  waitForJobResult(jobId: string, timeoutMs = 300_000): Promise<JobResult> {
    return this.registerJobWaiter(jobId, timeoutMs);
  }

  private registerJobWaiter(
    jobId: string,
    timeoutMs: number,
    permit?: DeviceExecutionJobDispatchPermit,
  ): Promise<JobResult> {
    const existing = this.pendingJobs.get(jobId);
    if (existing) {
      if (permit) {
        const samePermit = existing.permit &&
          existing.permit.handle.rootId === permit.handle.rootId &&
          existing.permit.handle.deviceId === permit.handle.deviceId &&
          existing.permit.handle.ownerGeneration === permit.handle.ownerGeneration &&
          existing.permit.handle.operationKind === permit.handle.operationKind &&
          existing.permit.handle.operationId === permit.handle.operationId;
        if (!samePermit) {
          throw new Error(`Job waiter collision for ${jobId}`);
        }
      }
      return existing.promise;
    }

    let resolve!: (result: JobResult) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<JobResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    promise.catch(() => {});

    const timer = this.createJobTimeout(jobId, timeoutMs, reject, permit);

    this.pendingJobs.set(jobId, {
      promise,
      resolve,
      reject,
      timer,
      deviceId: permit?.handle.deviceId,
      permit,
    });
    return promise;
  }

  private createJobTimeout(
    jobId: string,
    timeoutMs: number,
    reject: (err: Error) => void,
    permit?: DeviceExecutionJobDispatchPermit,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.pendingJobs.delete(jobId);
      if (permit) {
        deviceExecutionArbiter.markAmbiguous({
          deviceId: permit.handle.deviceId,
          handle: permit.handle,
          reason: "job_result_timeout",
          actor: "direct_ws_waiter_timeout",
          state: "blocked",
          metadata: {
            timeoutMs,
            handle: permit.wireHandle,
          },
        }).catch((err) => {
          console.error("[device-execution] timeout ambiguity mark failed:", (err as Error).message);
        });
      }
      reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    return timer;
  }

  /**
   * Send a BATCH_START message to a device.
   * Returns true if sent, false if device not connected.
   */
  sendBatch(deviceId: string, batchPayload: Record<string, unknown>): boolean {
    console.error(`[device-execution] blocked raw BATCH egress: device=${deviceId.slice(0, 8)} batch=${String(batchPayload.batchId ?? "?").slice(0, 8)}`);
    void deviceExecutionArbiter.recordRejectedEgress({
      deviceId,
      operationId: String(batchPayload.batchId ?? "missing"),
      wireType: "BATCH_START",
      actor: "direct_ws.raw_sender_guard",
      reason: "raw_batch_sender_disabled_use_permit_path",
    }).catch((err) => console.error("[device-execution] raw BATCH rejection audit failed:", (err as Error).message));
    return false;
  }

  sendBatchWithHandle(handle: DeviceExecutionHandle, batchPayload: Record<string, unknown>): boolean {
    if (handle.rootKind !== "batch" || handle.operationKind !== "batch" || handle.operationId !== batchPayload.batchId) {
      throw new Error("DirectWS BATCH handle does not match payload identity");
    }
    const conn = this.connections.get(handle.deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    this._send(conn.ws, { ...batchPayload, pnqHandle: encodeDeviceExecutionHandle(handle) });
    return true;
  }

  /**
   * Send WORKFLOW_START to a device for edge execution (ADR-001).
   * Device will execute the entire workflow locally.
   */
  sendWorkflowStart(
    deviceId: string,
    template: Record<string, unknown>,
    variables?: Record<string, unknown>,
    workflowId?: string,
  ): boolean {
    console.error(`[device-execution] blocked raw WORKFLOW_START egress: device=${deviceId.slice(0, 8)} workflow=${workflowId?.slice(0, 8) ?? "missing"}`);
    void deviceExecutionArbiter.recordRejectedEgress({
      deviceId,
      operationId: workflowId ?? "missing",
      wireType: "WORKFLOW_START",
      actor: "direct_ws.raw_sender_guard",
      reason: "raw_workflow_sender_disabled_use_permit_path",
    }).catch((err) => console.error("[device-execution] raw WORKFLOW rejection audit failed:", (err as Error).message));
    return false;
  }

  sendWorkflowStartWithHandle(
    handle: DeviceExecutionHandle,
    template: Record<string, unknown>,
    variables?: Record<string, unknown>,
  ): boolean {
    if (handle.rootKind !== "edge_workflow" || handle.operationKind !== "workflow") {
      throw new Error("DirectWS WORKFLOW handle must target an edge workflow root");
    }
    const conn = this.connections.get(handle.deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    const existing = this.pendingWorkflows.get(handle.operationId);
    if (existing && !handlesEqual(existing.handle, handle)) throw new Error(`Workflow handle collision for ${handle.operationId}`);
    if (!existing) {
      const timer = setTimeout(() => {
        void this.expirePendingWorkflow(handle);
      }, 600_000);
      timer.unref();
      this.pendingWorkflows.set(handle.operationId, { handle, timer });
    }
    this._send(conn.ws, {
      ...template,
      type: "WORKFLOW_START",
      workflowId: handle.operationId,
      variables: variables ?? {},
      pnqHandle: encodeDeviceExecutionHandle(handle),
    });
    return true;
  }

  private async expirePendingWorkflow(handle: DeviceExecutionHandle): Promise<void> {
    const pending = this.pendingWorkflows.get(handle.operationId);
    if (!pending || !handlesEqual(pending.handle, handle)) return;
    await deviceExecutionArbiter.markAmbiguous({
      deviceId: handle.deviceId,
      handle,
      reason: "workflow_status_timeout",
      actor: "direct_ws_workflow_timeout",
      state: "blocked",
    }).catch((err) => console.error("[device-execution] workflow timeout ambiguity mark failed:", (err as Error).message));
    if (this.pendingWorkflows.get(handle.operationId) === pending) {
      this.pendingWorkflows.delete(handle.operationId);
    }
  }

  /**
   * Send WORKFLOW_CANCEL to a device for local edge cancellation.
   */
  sendWorkflowCancel(deviceId: string, workflowId: string): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    this._send(conn.ws, {
      type: 'WORKFLOW_CANCEL',
      workflowId,
    });
    console.log(`[direct-ws] sendWorkflowCancel: device=${deviceId.slice(0,8)} workflow=${workflowId.slice(0,8)}`);
    return true;
  }

  /**
   * Check if a device supports edge workflow execution (ADR-001).
   * Devices with agent >= 4.0 support WORKFLOW_START.
   * Older devices must use legacy server-side execution.
   */
  supportsEdgeExecution(deviceId: string): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;
    return parseAgentVersion(conn.agentVersion) >= parseAgentVersion("4.0.0");
  }

  /**
   * Get agent version for a connected device.
   */
  getAgentVersion(deviceId: string): string {
    return this.connections.get(deviceId)?.agentVersion ?? "unknown";
  }

  /**
   * Returns a Promise that resolves when BATCH_RESULT arrives for this batchId.
   * Rejects after timeoutMs (default: 10 min — batches can be long).
   */
  waitForBatchResult(batchId: string, timeoutMs = 600_000): Promise<BatchResult> {
    const existing = this.pendingBatches.get(batchId);
    if (existing) return existing.promise;
    throw new Error(`Batch ${batchId} has no typed PNQ waiter`);
  }

  registerBatchWaiterWithHandle(handle: DeviceExecutionHandle, timeoutMs = 600_000): Promise<BatchResult> {
    const batchId = handle.operationId;
    const existing = this.pendingBatches.get(batchId);
    if (existing) {
      if (!handlesEqual(existing.handle, handle)) throw new Error(`Batch waiter collision for ${batchId}`);
      return existing.promise;
    }
    let resolve!: (result: BatchResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<BatchResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      void this.expirePendingBatch(handle, timeoutMs);
    }, timeoutMs);
    timer.unref();
    this.pendingBatches.set(batchId, { promise, resolve, reject, timer, handle });
    return promise;
  }

  rejectBatchWaiterWithHandle(handle: DeviceExecutionHandle, reason: string): void {
    const pending = this.pendingBatches.get(handle.operationId);
    if (!pending || !handlesEqual(pending.handle, handle)) return;
    clearTimeout(pending.timer);
    this.pendingBatches.delete(handle.operationId);
    pending.reject(new Error(reason));
  }

  private async expirePendingBatch(handle: DeviceExecutionHandle, timeoutMs: number): Promise<void> {
    const pending = this.pendingBatches.get(handle.operationId);
    if (!pending || !handlesEqual(pending.handle, handle)) return;
    await deviceExecutionArbiter.markAmbiguous({
      deviceId: handle.deviceId,
      handle,
      reason: "batch_result_timeout",
      actor: "direct_ws_batch_timeout",
      state: "blocked",
      metadata: { timeoutMs },
    }).catch((err) => console.error("[device-execution] batch timeout ambiguity mark failed:", (err as Error).message));
    if (this.pendingBatches.get(handle.operationId) !== pending) return;
    this.pendingBatches.delete(handle.operationId);
    pending.reject(new Error(`Batch ${handle.operationId} timed out after ${timeoutMs}ms`));
  }

  isDeviceOnline(deviceId: string): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;
    return conn.ws.readyState === WebSocket.OPEN &&
           Date.now() - conn.lastSeenAt < OFFLINE_THRESHOLD_MS;
  }

  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys()).filter(id => this.isDeviceOnline(id));
  }

  /**
   * Broadcast a template update to all online devices (ADR-001 Phase 3).
   * Uses CONFIG_UPDATE message type — devices cache the template locally.
   */
  broadcastTemplate(template: Record<string, unknown>): number {
    const deviceIds = this.getConnectedDeviceIds();
    let sent = 0;
    for (const deviceId of deviceIds) {
      const conn = this.connections.get(deviceId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        this._send(conn.ws, {
          type: 'CONFIG_UPDATE',
          template,
        });
        sent++;
      }
    }
    console.log(`[direct-ws] Template broadcast: sent to ${sent}/${deviceIds.length} devices (template=${(template.id as string)?.slice(0, 20)})`);
    return sent;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  sendToDevice(deviceId: string, msg: Record<string, unknown>): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    this._send(conn.ws, msg);
    return true;
  }

  getOnlineDevices(): Array<{ deviceId: string }> {
    return this.getConnectedDeviceIds().map(id => ({ deviceId: id }));
  }

  recordOtaStatus(deviceId: string, patch: Omit<Partial<OtaDeviceStatus>, "deviceId" | "updatedAt"> & { status: string }): void {
    const existing = this.otaStatuses.get(deviceId) ?? { deviceId, status: "unknown", updatedAt: new Date(0).toISOString() };
    this.otaStatuses.set(deviceId, {
      ...existing,
      ...patch,
      deviceId,
      updatedAt: new Date().toISOString(),
    });
  }

  getOtaStatuses(): OtaDeviceStatus[] {
    return Array.from(this.otaStatuses.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ─── Connection handler ───────────────────────────────────────────────────

  private _onConnection(ws: WebSocket, _req: IncomingMessage): void {
    // ── Connection limit guard ─────────────────────────────────────────────
    if (this.connections.size >= MAX_WS_CONNECTIONS) {
      const remoteIp = (_req.socket.remoteAddress ?? "unknown");
      console.warn(`[direct-ws] Rejected connection from ${remoteIp}: max connections (${MAX_WS_CONNECTIONS}) reached`);
      ws.close(4029, "Server at max capacity");
      return;
    }

    const remoteIp = (_req.socket.remoteAddress ?? "unknown");
    console.log(`[direct-ws] New connection from ${remoteIp}`);

    let deviceConn: ConnectedDevice | null = null;
    let authTimeout: ReturnType<typeof setTimeout> | null = null;

    // Close if not authenticated within AUTH_TIMEOUT_MS
    authTimeout = setTimeout(() => {
      if (!deviceConn) {
        console.warn(`[direct-ws] Auth timeout from ${remoteIp} — closing`);
        ws.close(4001, "Auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", async (raw) => {
      // Size guard
      if (Buffer.byteLength(raw as Buffer) > MAX_MSG_BYTES) {
        console.warn("[direct-ws] Oversized message — closing connection");
        ws.close(4008, "Message too large");
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn("[direct-ws] Invalid JSON from", remoteIp);
        return;
      }

      const type = msg.type as string;

      // ── Not yet authenticated ─────────────────────────────────────────
      if (!deviceConn) {
        if (type === "AUTH") {
          await this._handleAuth(ws, msg, remoteIp, (conn) => {
            deviceConn = conn;
            if (authTimeout) { clearTimeout(authTimeout); authTimeout = null; }
          });
        } else {
          ws.close(4001, "Must authenticate first");
        }
        return;
      }

      // ── Rate limit ────────────────────────────────────────────────────
      if (!this.rateLimiter.allow(deviceConn.deviceId)) {
        console.warn(`[direct-ws] Rate limit exceeded for device ${deviceConn.deviceId.slice(0,8)}`);
        return;
      }

      deviceConn.lastSeenAt = Date.now();
      deviceConn.msgCount++;

      // ── Route by type ─────────────────────────────────────────────────
      switch (type) {
        case "JOB_RESULT":      await this._handleJobResult(deviceConn, msg);   break;
        case "BATCH_RESULT":    await this._handleBatchResult(deviceConn, msg); break;
        case "HEARTBEAT":       await this._handleHeartbeat(deviceConn, msg); break;
        case "PING":            this._send(ws, { type: "PONG" });          break;
        case "PONG":            deviceConn.lastPongAt = Date.now();         break;
        // ── Edge Workflow Execution (ADR-001) ──
        case "WORKFLOW_STATUS": await this._handleWorkflowStatus(deviceConn, msg); break;
        case "LLM_REQUEST":    this._handleLlmRequest(deviceConn, ws, msg); break;
        case "OTA_RESULT":     this._handleOtaResult(deviceConn, msg); break;
        default:                console.warn(`[direct-ws] Unknown message type: ${type}`); break;
      }
    });

    ws.on("close", async (code, reason) => {
      if (deviceConn) {
        console.log(`[direct-ws] Device ${deviceConn.deviceId.slice(0,8)} disconnected: ${code} ${reason}`);
        this.connections.delete(deviceConn.deviceId);
        this.rateLimiter.delete(deviceConn.deviceId);
        devicesConnected?.set(this.connections.size);
        deviceOfflineEvents?.inc();

        await this.blockPendingForDisconnectedDevice(deviceConn.deviceId, code, String(reason));

        // Update DB
        devicesService.markOffline(deviceConn.deviceId).catch(err =>
          console.error("[direct-ws] markOffline error:", err)
        );

        alerting.deviceOffline(deviceConn.deviceId, "direct-ws").catch(() => {});
      }
      if (authTimeout) clearTimeout(authTimeout);
    });

    ws.on("error", (err) => {
      console.error(`[direct-ws] WebSocket error (device=${deviceConn?.deviceId?.slice(0,8) ?? "unauth"}):`, err.message);
    });
  }

  private async blockPendingForDisconnectedDevice(
    deviceId: string,
    closeCode: number,
    closeReason: string,
  ): Promise<{ jobs: number; batches: number; workflows: number }> {
    const jobs = [...this.pendingJobs.entries()].filter(([, pending]) => pending.deviceId === deviceId);
    const batches = [...this.pendingBatches.entries()].filter(([, pending]) => pending.handle.deviceId === deviceId);
    const workflows = [...this.pendingWorkflows.entries()].filter(([, pending]) => pending.handle.deviceId === deviceId);
    const transitions: Promise<unknown>[] = [];

    for (const [, pending] of jobs) {
      if (!pending.permit) continue;
      transitions.push(deviceExecutionArbiter.markAmbiguous({
        deviceId,
        handle: pending.permit.handle,
        reason: "device_disconnected_before_job_result",
        actor: "direct_ws_disconnect",
        state: "blocked",
        metadata: { handle: pending.permit.wireHandle, closeCode, closeReason },
      }));
    }
    for (const [, pending] of batches) {
      transitions.push(deviceExecutionArbiter.markAmbiguous({
        deviceId,
        handle: pending.handle,
        reason: "device_disconnected_before_batch_result",
        actor: "direct_ws_disconnect",
        state: "blocked",
        metadata: { closeCode, closeReason },
      }));
    }
    for (const [, pending] of workflows) {
      transitions.push(deviceExecutionArbiter.markAmbiguous({
        deviceId,
        handle: pending.handle,
        reason: "device_disconnected_before_workflow_terminal",
        actor: "direct_ws_disconnect",
        state: "blocked",
        metadata: { closeCode, closeReason },
      }));
    }
    const settled = await Promise.allSettled(transitions);
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error("[device-execution] disconnect ambiguity mark failed:", (result.reason as Error).message);
      }
    }

    for (const [jobId, pending] of jobs) {
      clearTimeout(pending.timer);
      if (this.pendingJobs.get(jobId) === pending) this.pendingJobs.delete(jobId);
      pending.reject(new Error(`Device ${deviceId} disconnected`));
    }
    for (const [batchId, pending] of batches) {
      clearTimeout(pending.timer);
      if (this.pendingBatches.get(batchId) === pending) this.pendingBatches.delete(batchId);
      pending.reject(new Error(`Device ${deviceId} disconnected during batch ${batchId}`));
    }
    for (const [workflowId, pending] of workflows) {
      clearTimeout(pending.timer);
      if (this.pendingWorkflows.get(workflowId) === pending) this.pendingWorkflows.delete(workflowId);
    }
    return { jobs: jobs.length, batches: batches.length, workflows: workflows.length };
  }

  // ─── Auth handler ─────────────────────────────────────────────────────────

  private async _handleAuth(
    ws: WebSocket,
    msg: Record<string, unknown>,
    remoteIp: string,
    onAuth: (conn: ConnectedDevice) => void,
  ): Promise<void> {
    const { deviceId, deviceKey, fingerprint, deviceInfo } = msg as { 
      deviceId?: string; 
      deviceKey?: string; 
      fingerprint?: string;
      deviceInfo?: { model?: string; manufacturer?: string; androidVersion?: string; sdkVersion?: number; agentVersion?: string };
    };

    try {
      const db = getDb();
      let device: { id: string; status: string; device_key: string | null } | null = null;
      
      // 1. Normal auth: deviceId + deviceKey
      if (deviceId && deviceKey) {
        const result = await db.query<{ id: string; status: string; device_key: string | null }>(
          `SELECT id, status, device_key FROM devices WHERE id = $1 AND device_key = $2`,
          [deviceId, deviceKey]
        );
        device = result.rows[0] || null;
        if (device) {
          console.log(`[direct-ws] Normal auth for ${device.id.slice(0,8)}`);
        }
      }

      // 1b. Device ID match with new key (reinstalled app, same hardware)
      //     Device sends stable hardware-derived ID but lost stored deviceKey.
      //     Accept it, generate new key, and re-approve automatically.
      if (!device && deviceId && !deviceKey) {
        const result = await db.query<{ id: string; status: string; device_key: string | null }>(
          `SELECT id, status, device_key FROM devices WHERE id = $1`,
          [deviceId]
        );
        if (result.rows[0]) {
          const row = result.rows[0];
          const crypto = require('crypto');
          const newKey = crypto.randomBytes(32).toString('hex');
          await db.query(`UPDATE devices SET device_key = $1, status = CASE WHEN status = 'pending' THEN 'approved' ELSE status END WHERE id = $2`, [newKey, row.id]);
          device = { id: row.id, status: row.status === 'blocked' ? 'blocked' : 'approved', device_key: newKey };
          console.log(`[direct-ws] Re-auth via stable deviceId: ${row.id.slice(0,8)} (new key issued, was ${row.status})`);
        }
      }
      
      // 2. Enrollment: fingerprint (UUID generated by device)
      if (!device && fingerprint) {
        console.log(`[direct-ws] Enrollment attempt with fingerprint: ${fingerprint.slice(0,8)}...`);
        
        // Check if device already enrolled with this fingerprint
        const existing = await db.query<{ id: string; status: string; device_key: string | null }>(
          `SELECT id, status, device_key FROM devices WHERE fingerprint = $1`,
          [fingerprint]
        );
        
        if (existing.rows[0]) {
          device = existing.rows[0];
          console.log(`[direct-ws] Found existing device by fingerprint: ${device.id.slice(0,8)}`);
        } else {
          // Create new device
          const crypto = require('crypto');
          const newDeviceId = crypto.randomUUID();
          const newDeviceKey = crypto.randomBytes(32).toString('hex');
          
          await db.query(
            `INSERT INTO devices (id, fingerprint, device_key, status, created_at, last_seen_at) 
             VALUES ($1, $2, $3, 'pending', NOW(), NOW())`,
            [newDeviceId, fingerprint, newDeviceKey]
          );
          
          device = { id: newDeviceId, status: 'pending', device_key: newDeviceKey };
          console.log(`[direct-ws] NEW device created: ${newDeviceId.slice(0,8)} status=pending`);
        }
      }

      if (!device) {
        console.warn(`[direct-ws] AUTH failed: no credentials from ${remoteIp}`);
        this._send(ws, { type: "AUTH_FAIL", reason: "No valid credentials" });
        ws.close(4003, "Auth failed");
        return;
      }

      if (device.status === "blocked") {
        console.warn(`[direct-ws] AUTH failed: device ${device.id.slice(0,8)} is blocked`);
        this._send(ws, { type: "AUTH_FAIL", reason: "Device blocked" });
        ws.close(4003, "Blocked");
        return;
      }
      
      // Use the resolved device ID
      const finalDeviceId = device.id;
      const finalDeviceKey = device.device_key!;
      const finalStatus = device.status;

      // Kick existing connection for same device
      const existing = this.connections.get(finalDeviceId);
      if (existing && existing.ws.readyState === WebSocket.OPEN) {
        console.log(`[direct-ws] Superseding existing connection for device ${finalDeviceId.slice(0,8)}`);
        existing.ws.close(4000, "Replaced by newer connection");
      }

      // Register connection
      const now = Date.now();
      const conn: ConnectedDevice = {
        ws,
        deviceId: finalDeviceId,
        connectedAt: now,
        lastSeenAt:  now,
        lastPongAt:  now,
        msgCount:    0,
        windowStart: now,
        agentVersion: deviceInfo?.agentVersion ?? "unknown",
      };
      this.connections.set(finalDeviceId, conn);
      devicesConnected?.set(this.connections.size);

      // Update DB — mark online + device info
      await devicesService.markOnline(finalDeviceId, remoteIp).catch(err =>
        console.warn("[direct-ws] markOnline error:", err.message)
      );

      // Save device info (model, android version, agent version)
      if (deviceInfo) {
        const friendlyName = deviceInfo.manufacturer && deviceInfo.model
          ? `${deviceInfo.manufacturer} ${deviceInfo.model}` : undefined;
        const androidVer = deviceInfo.androidVersion || undefined;
        const agentVersion = deviceInfo.agentVersion;
        const modelStr = deviceInfo.model;
        const updates: string[] = [];
        const vals: unknown[] = [];
        let idx = 1;

        // Only set friendly_name if not already set (preserve user-defined names)
        const existingDevice = await db.query<{ friendly_name: string | null }>(
          `SELECT friendly_name FROM devices WHERE id = $1`, [finalDeviceId]
        ).catch(() => null);
        const hasCustomName = existingDevice?.rows[0]?.friendly_name && existingDevice.rows[0].friendly_name !== '';
        if (friendlyName && !hasCustomName) {
          updates.push(`friendly_name = $${idx++}`); vals.push(friendlyName);
        }
        if (modelStr) { updates.push(`model = $${idx++}`); vals.push(modelStr); }
        if (androidVer) { updates.push(`android_version = $${idx++}`); vals.push(androidVer); }
        if (agentVersion) { updates.push(`agent_version = $${idx++}`); vals.push(agentVersion); }
        if (updates.length > 0) {
          vals.push(finalDeviceId);
          await db.query(`UPDATE devices SET ${updates.join(', ')} WHERE id = $${idx}`, vals).catch(err =>
            console.warn("[direct-ws] deviceInfo update error:", err.message)
          );
          console.log(`[direct-ws] Device info: ${friendlyName} Android ${androidVer} agent=${agentVersion}`);
        }
      }

      // Send AUTH_OK with deviceId + deviceKey (so device can save for future reconnects)
      this._send(ws, { 
        type: "AUTH_OK", 
        deviceId: finalDeviceId,
        deviceKey: finalDeviceKey,
        status: finalStatus
      });
      console.log(`[direct-ws] Device ${finalDeviceId.slice(0,8)} authenticated (status=${finalStatus}) from ${remoteIp}`);
      onAuth(conn);
      void import("../transport/transport")
        .then(({ dispatchQueuedJobsForDevice }) => dispatchQueuedJobsForDevice(finalDeviceId, "direct_ws.reconnect_queue_pump"))
        .catch(err => console.error("[device-execution] reconnect queue pump error:", (err as Error).message));

    } catch (err) {
      console.error("[direct-ws] Auth DB error:", (err as Error).message);
      this._send(ws, { type: "AUTH_FAIL", reason: "Server error" });
      ws.close(4003, "Server error");
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────

  private async _handleJobResult(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    const jobId = msg.jobId as string;
    if (!jobId) return;
    console.log(`[direct-ws] JOB_RESULT received: jobId=${jobId.slice(0,8)} success=${msg.success} error=${msg.error || 'none'} device=${conn.deviceId.slice(0,8)}`);

    const pending = this.pendingJobs.get(jobId);
    const status = Boolean(msg.success) ? "completed" : "failed";
    const durationMs = (msg.durationMs as number | undefined) ?? 0;
    const wireHandle = isRecord(msg.pnqHandle) ? msg.pnqHandle : null;
    const handleResolution = pending?.permit
      ? resolveDirectWsResultHandle(pending.permit.handle, msg)
      : null;
    const reportedHandle = handleResolution?.reportedHandle ?? decodeDeviceExecutionHandle(wireHandle);

    try {
      const accepted = await deviceExecutionArbiter.acceptJobResult({
        deviceId: conn.deviceId,
        jobId,
        handle: pending?.permit?.handle,
        reportedHandle,
        allowLegacyMissingHandle: handleResolution?.compatibility === "authenticated_pending_handle",
        status,
        actor: "direct_ws",
        reason: (msg.error as string | undefined) ?? status,
        metadata: {
          durationMs,
          observeSource: "directWsServer.handleJobResult",
          expectedHandle: pending?.permit?.wireHandle ?? null,
          reportedHandle: wireHandle,
          legacyMissingHandleAllowed: handleResolution?.compatibility === "authenticated_pending_handle",
          handleCompatibility: handleResolution?.compatibility ?? "no_pending_handle",
        },
      });
      if (!accepted.accepted) {
        console.warn(
          `[direct-ws] JOB_RESULT rejected by PNQ ingress: jobId=${jobId.slice(0,8)} decision=${accepted.decision} reason=${accepted.reason ?? "none"}`
        );
        this._send(conn.ws, { type: "ACK", ref: jobId });
        return;
      }
    } catch (err) {
      console.error("[device-execution] enforced JOB result ingress failed:", (err as Error).message);
      return;
    }

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingJobs.delete(jobId);
      pending.resolve({
        jobId,
        success: Boolean(msg.success),
        status,
        output:  msg.output,
        error:   msg.error as string | undefined,
      });
    }

    // ── Resolve workflow executor's pending promise (critical for blocking workflows) ──
    const { resolveJobResult } = require("../modules/workflows/workflow.executor");
    const resolved = resolveJobResult(jobId, {
      status,
      output:     msg.output,
      error:      msg.error as string | undefined,
      durationMs,
    });
    if (resolved) {
      console.log(`[direct-ws] JOB_RESULT resolved for workflow executor: jobId=${jobId.slice(0,8)}`);
    }

    // Forward to dispatcherService for DB update + metrics
    dispatcherService.handleJobResult({
      jobId,
      deviceId:   conn.deviceId,
      status,
      output:     msg.output as Record<string, unknown>,
      error:      msg.error as string | undefined,
      durationMs,
    }).catch(err => console.error("[direct-ws] handleJobResult error:", err.message));

    // ACK
    this._send(conn.ws, { type: "ACK", ref: jobId });
    void import("../transport/transport")
      .then(({ dispatchQueuedJobsForDevice }) => dispatchQueuedJobsForDevice(conn.deviceId, "direct_ws.job_result_queue_pump"))
      .catch(err => console.error("[device-execution] direct-ws queue pump error:", (err as Error).message));
  }

  // ─── Batch result handler ────────────────────────────────────────────────

  private async _handleBatchResult(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    const batchId = msg.batchId as string;
    if (!batchId) {
      console.warn("[direct-ws] BATCH_RESULT missing batchId — ignoring");
      return;
    }

    const status = msg.status as string;
    const results = (msg.results as unknown[]) ?? [];
    const totalDurationMs = (msg.totalDurationMs as number) ?? 0;

    console.log(`[direct-ws] BATCH_RESULT received: batchId=${batchId.slice(0,8)} status=${status} steps=${results.length} totalMs=${totalDurationMs} device=${conn.deviceId.slice(0,8)}`);

    const pending = this.pendingBatches.get(batchId);
    const handleResolution = pending ? resolveDirectWsResultHandle(pending.handle, msg) : null;
    const reportedHandle = handleResolution?.reportedHandle ?? pending?.handle ?? null;
    if (!pending || !handleResolution?.accepted || !reportedHandle || reportedHandle.deviceId !== conn.deviceId) {
      await deviceExecutionArbiter.recordRejectedEgress({
        deviceId: conn.deviceId,
        operationId: batchId,
        wireType: "BATCH_RESULT",
        actor: "direct_ws",
        reason: !pending ? "batch_result_without_waiter" : handleResolution?.reason ?? "batch_result_handle_mismatch",
        metadata: { reportedHandle: msg.pnqHandle ?? null, handleCompatibility: handleResolution?.compatibility ?? null },
      });
      return;
    }
    const terminal = await deviceExecutionArbiter.observeTerminal({
      deviceId: conn.deviceId,
      handle: reportedHandle,
      status,
      actor: "direct_ws",
      reason: msg.error as string | undefined,
      metadata: { totalDurationMs, resultCount: results.length, handleCompatibility: handleResolution.compatibility },
    });
    if (terminal.decision !== "terminal") return;

    clearTimeout(pending.timer);
    this.pendingBatches.delete(batchId);
    pending.resolve({
      batchId,
      workflowId: msg.workflowId as string ?? "",
      status,
      results,
      executedAt: msg.executedAt as string ?? new Date().toISOString(),
      totalDurationMs,
      error: msg.error as string | undefined,
    });

    // ACK
    this._send(conn.ws, { type: "ACK", ref: batchId });
  }

  private async _handleHeartbeat(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    // Direct-WS heartbeat uses a simplified format; map to DeviceHealth
    const health: DeviceHealth = {
      batteryLevel:      (msg.battery as number)          ?? 0,
      charging:          Boolean(msg.charging),
      storageFreeBytes:  (msg.storageFreeBytes as number) ?? 0,
      thermalStatus:     "nominal",
      networkType:       (msg.networkType as DeviceHealth["networkType"])    ?? "none",
      networkQuality:    (msg.networkQuality as DeviceHealth["networkQuality"]) ?? "none",
      activeApp:         msg.foregroundApp as string | undefined,
      agentVersion:      (msg.agentVersion as string) ?? "unknown",
    };

    try {
      await devicesService.updateHealth(conn.deviceId, health);
      recordDeviceHealth(conn.deviceId, {
        batteryLevel: health.batteryLevel,
        memoryAvailableMb: msg.memoryAvailableMb as number | undefined,
      });
    } catch (err) {
      console.warn("[direct-ws] heartbeat update error:", (err as Error).message);
    }

    this._send(conn.ws, { type: "ACK", ref: "heartbeat" });
  }

  // ─── Keepalive ────────────────────────────────────────────────────────────

  private _pingAll(): void {
    const now = Date.now();
    for (const [deviceId, conn] of this.connections) {
      if (conn.ws.readyState !== WebSocket.OPEN) {
        this.connections.delete(deviceId);
        continue;
      }

      // PONG timeout — zombie connection
      if (now - conn.lastPongAt > PONG_TIMEOUT_MS) {
        console.warn(`[direct-ws] PONG timeout for device ${deviceId.slice(0,8)} — closing`);
        conn.ws.close(4002, "PONG timeout");
        this.connections.delete(deviceId);
        continue;
      }

      this._send(conn.ws, { type: "PING" });
    }
  }

  // ─── Edge Workflow Execution handlers (ADR-001) ──────────────────────────

  /**
   * Handle WORKFLOW_STATUS from device.
   * Fire-and-forget: log + update DB. No response needed.
   */
  private async _handleWorkflowStatus(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    const workflowId = msg.workflowId as string;
    const status     = msg.status as string;
    const step       = msg.currentStep as number;
    const total      = msg.totalSteps as number;
    const error      = msg.error as string | undefined;
    const variables  = msg.variables as Record<string, unknown> | undefined;
    const pendingWorkflow = this.pendingWorkflows.get(workflowId);
    const expectedHandle = pendingWorkflow?.handle;
    const handleResolution = expectedHandle ? resolveDirectWsResultHandle(expectedHandle, msg) : null;
    const reportedHandle = handleResolution?.reportedHandle ?? expectedHandle ?? null;
    if (!expectedHandle || !handleResolution?.accepted || !reportedHandle || reportedHandle.deviceId !== conn.deviceId) {
      await deviceExecutionArbiter.recordRejectedEgress({
        deviceId: conn.deviceId,
        operationId: workflowId || "missing",
        wireType: "WORKFLOW_STATUS",
        actor: "direct_ws",
        reason: !expectedHandle ? "workflow_status_without_pending_handle" : handleResolution?.reason ?? "workflow_status_handle_mismatch",
        metadata: { reportedHandle: msg.pnqHandle ?? null, status, handleCompatibility: handleResolution?.compatibility ?? null },
      });
      return;
    }
    const controlPlaneContext = variables?.controlPlaneContext &&
      typeof variables.controlPlaneContext === "object" &&
      !Array.isArray(variables.controlPlaneContext)
      ? variables.controlPlaneContext as Record<string, unknown>
      : {};

    console.log(
      `[direct-ws] WORKFLOW_STATUS: device=${conn.deviceId.slice(0,8)} ` +
      `workflow=${workflowId?.slice(0,8)} status=${status} step=${step}/${total}` +
      (error ? ` error=${error}` : '')
    );

    if (workflowId) {
      workflowEvents.publish({
        source: "edge_device",
        event: status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : "checkpoint_updated",
        workflowId,
        taskId: typeof controlPlaneContext.taskId === "string" ? controlPlaneContext.taskId : undefined,
        agencyWorkflowRunId: typeof controlPlaneContext.agencyWorkflowRunId === "string" ? controlPlaneContext.agencyWorkflowRunId : undefined,
        clientId: typeof controlPlaneContext.clientId === "string" ? controlPlaneContext.clientId : undefined,
        accountId: typeof controlPlaneContext.accountId === "string" ? controlPlaneContext.accountId : undefined,
        deviceId: conn.deviceId,
        mode: "edge",
        status,
        currentStep: typeof step === "number" ? step : undefined,
        stepIndex: typeof step === "number" ? Math.max(0, step - 1) : undefined,
        totalSteps: typeof total === "number" ? total : undefined,
        error,
        details: {
          variables,
          source: "edge",
        },
      });

      if (status === "completed" || status === "failed" || status === "cancelled") {
        const terminal = await deviceExecutionArbiter.observeTerminal({
          deviceId: conn.deviceId,
          handle: reportedHandle,
          status,
          actor: "direct_ws",
          reason: error,
          metadata: {
            step: typeof step === "number" ? step : null,
            total: typeof total === "number" ? total : null,
            handleCompatibility: handleResolution.compatibility,
          },
        });
        if (terminal.decision !== "terminal") return;
        if (pendingWorkflow) clearTimeout(pendingWorkflow.timer);
        this.pendingWorkflows.delete(workflowId);
      }
    }

    // Update DB (fire-and-forget)
    await this._persistWorkflowStatus(conn.deviceId, workflowId, status, step, total, error, variables)
      .catch(err => console.error(`[direct-ws] Failed to persist workflow status: ${err.message}`));
  }

  private async _persistWorkflowStatus(
    deviceId: string,
    workflowId: string | undefined,
    status: string,
    step: number,
    total: number,
    error: string | undefined,
    variables: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!workflowId) return;
    const { getDb } = require("../db/client");
    const db = getDb();
    const existing = await db.query(
      "SELECT checkpoint FROM workflows WHERE id = $1",
      [workflowId]
    );
    const mergedVariables = mergeWorkflowStatusVariables(existing.rows[0]?.checkpoint, variables);

    const checkpoint = {
      stepIndex: step,
      loopStack: [],
      variables: mergedVariables,
      executionStats: {
        compileLlmCalls: 0,
        recoveryLlmCalls: 0,
        creativeLlmCalls: 0,
        runtimeLlmCalls: 0,
        vlmCalls: 0,
        deterministicSteps: step ?? 0,
        batchedSteps: 0,
        failedSteps: status === 'failed' ? 1 : 0,
        retriedSteps: 0,
        recoveryAttempts: 0,
        recoveryBudgetExhausted: 0,
        mode: 'edge',
      },
      checkpointAt: new Date().toISOString(),
      source: 'edge',
      totalSteps: total,
      error: error ?? null,
    };

    if (status === 'completed') {
      await db.query(
        `UPDATE workflows
         SET status = 'completed',
             current_step = $1,
             total_steps = COALESCE($2, total_steps),
             checkpoint = $3,
             completed_at = NOW()
         WHERE id = $4`,
        [step ?? total, total, JSON.stringify({ ...checkpoint, result: { step, total, variables: mergedVariables } }), workflowId]
      );
    } else if (status === 'failed') {
      await db.query(
        `UPDATE workflows
         SET status = 'failed',
             current_step = COALESCE($1, current_step),
             total_steps = COALESCE($2, total_steps),
             checkpoint = $3,
             error = $4,
             completed_at = NOW()
         WHERE id = $5`,
        [step, total, JSON.stringify(checkpoint), error || 'Device reported failure', workflowId]
      );
    } else {
      // running / paused — update only columns present in the canonical workflows schema.
      // Older Umbrel installs do not have a `progress` column; checkpoint carries progress details.
      await db.query(
        `UPDATE workflows
         SET status = $1,
             current_step = COALESCE($2, current_step),
             total_steps = COALESCE($3, total_steps),
             checkpoint = $4
         WHERE id = $5
           AND status NOT IN ('cancelled', 'completed', 'failed')`,
        [
          status,
          step,
          total,
          JSON.stringify({
            ...checkpoint,
            progress: { step, total, error, variables: JSON.stringify(mergedVariables).slice(0, 1000) },
          }),
          workflowId,
        ]
      );
    }
  }

  /**
   * Handle LLM_REQUEST from device.
   * Forward to VLM endpoint and return LLM_RESULT.
   */
  private async _handleLlmRequest(conn: ConnectedDevice, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const requestId = msg.requestId as string;
    const prompt    = msg.prompt as string;
    const screenshot = msg.screenshot as string | undefined;

    console.log(`[direct-ws] LLM_REQUEST: device=${conn.deviceId.slice(0,8)} role=${screenshot ? 'vision_vlm' : 'decision_llm'} hasImage=${!!screenshot} prompt=${prompt?.slice(0, 80)}...`);

    try {
      const text = screenshot
        ? await visionService.analyzeCustomPrompt(
            screenshot,
            prompt,
            { maxTokens: 500, temperature: 0.3, timeoutMs: 30_000 }
          )
        : await llmComplete(prompt, undefined, { max_tokens: 220 });

      this._send(ws, {
        type: 'LLM_RESULT',
        requestId,
        result: text,
      });
    } catch (err) {
      console.error(`[direct-ws] LLM_REQUEST failed: ${(err as Error).message}`);
      this._send(ws, {
        type: 'LLM_RESULT',
        requestId,
        result: '',
        error: (err as Error).message,
      });
    }
  }

  private _handleOtaResult(conn: ConnectedDevice, msg: Record<string, unknown>): void {
    const status = typeof msg.status === "string" ? msg.status : "unknown";
    const version = typeof msg.version === "string" ? msg.version : undefined;
    const versionCode = typeof msg.versionCode === "number" ? msg.versionCode : undefined;
    const apkSha256 = typeof msg.apkSha256 === "string" ? msg.apkSha256 : undefined;
    const error = typeof msg.error === "string" ? msg.error : undefined;
    this.recordOtaStatus(conn.deviceId, { status, version, versionCode, apkSha256, error });
    console.log(
      `[direct-ws] OTA_RESULT device=${conn.deviceId.slice(0, 8)} status=${status}` +
      `${version ? ` version=${version}` : ""}${versionCode ? ` code=${versionCode}` : ""}` +
      `${error ? ` error=${error}` : ""}`
    );
  }

  // ─── Util ─────────────────────────────────────────────────────────────────

  private _send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...payload, ts: Date.now() }));
    }
  }
}

export const directWsServer = new DirectWsServer();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse semver-like version string to comparable number.
 * "4.0.0" → 40000, "3.1.4" → 30104, "unknown" → 0
 */
function parseAgentVersion(version: string): number {
  if (!version || version === "unknown") return 0;
  const parts = version.replace(/^v/, "").split(".");
  const major = parseInt(parts[0] || "0", 10);
  const minor = parseInt(parts[1] || "0", 10);
  const patch = parseInt(parts[2] || "0", 10);
  return major * 10000 + minor * 100 + patch;
}
