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
  isDeviceExecutionResultQuiescent,
  isDeviceExecutionResultTerminal,
  type DeviceExecutionJobDispatchPermit,
  type DeviceExecutionHandle,
  type DeviceExecutionRootKind,
} from "../modules/device-execution";
import { isDeviceExecutionEnforced } from "../modules/device-execution/device-execution-authority";
import { devicesService } from "../modules/devices/devices.service";
import { devicesConnected, deviceOfflineEvents, recordDeviceHealth } from "../modules/observability/metrics";
import { alerting } from "../modules/observability/alerts";
import { visionService } from "../modules/vision/vision.service";
import { workflowEvents } from "../modules/workflow-events";
import { llmComplete } from "../utils/llm";
import { pnqV2RuntimeService, runPnqV2ShadowSideEffect } from "../modules/device-execution/pnq-v2-runtime.service";
import { isPnqV2ShadowRuntimeEnabled } from "../modules/device-execution/pnq-v2-runtime-config";
import type { JobDispatchPayload, DeviceHealth } from "../../shared/protocol/messages";
import { recordJobExecutionEventDetached } from "../modules/observability/job-execution-events";
import { transitionJob } from "../modules/dispatcher/job-lifecycle.service";
import { getConnectionRecoveryPolicy } from "./connection-recovery-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type WorkflowJobResultResolver = (
  jobId: string,
  result: import("../modules/workflows/workflow.executor").JobStepResult,
) => boolean;

let workflowJobResultResolverForTest: WorkflowJobResultResolver | null = null;

export function setWorkflowJobResultResolverForTest(resolver: WorkflowJobResultResolver | null): void {
  workflowJobResultResolverForTest = resolver;
}

function resolveWorkflowExecutorJobResult(
  jobId: string,
  result: import("../modules/workflows/workflow.executor").JobStepResult,
): boolean {
  const resolver = workflowJobResultResolverForTest
    ?? (require("../modules/workflows/workflow.executor") as {
      resolveJobResult: WorkflowJobResultResolver;
    }).resolveJobResult;
  return resolver(jobId, result);
}

function classifyLlmError(err: unknown): string {
  const code = isRecord(err) && typeof err.code === "string" ? err.code : "";
  if (code.startsWith("AI_")) return code;
  const name = isRecord(err) && typeof err.name === "string" ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "AI_PROVIDER_TIMEOUT";
  return "AI_PROVIDER_ERROR";
}

function llmErrorMessage(code: string): string {
  switch (code) {
    case "AI_MODEL_DISABLED":
      return "Configured model role is disabled.";
    case "AI_MODEL_CONFIG_MISSING":
      return "Configured model role is missing.";
    case "AI_CREDENTIAL_MISSING":
      return "Configured model role is missing a server-side credential.";
    case "AI_PROVIDER_TIMEOUT":
      return "Model provider request timed out.";
    case "AI_LLM_BUSY":
      return "Another LLM request is already running for this device.";
    default:
      return "Model request failed.";
  }
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
const AMBIGUITY_RETRY_MAX_ATTEMPTS = 3;
const AMBIGUITY_RETRY_DELAY_MS = 250;

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
  pnqV2ConnectionEpoch?: number | null;
  pnqV2ConnectionEpochPromise?: Promise<number | null>;
}

interface PendingJob {
  promise: Promise<JobResult>;
  resolve: (result: JobResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
  deviceId?: string;
  permit?: DeviceExecutionJobDispatchPermit;
  legacyMode?: "generated_workflow";
}

interface PendingWorkflow {
  handle: DeviceExecutionHandle;
  timer: ReturnType<typeof setTimeout>;
}

interface OtaDeviceStatus {
  deviceId: string;
  terminal: boolean;
  successful: boolean;
  version?: string;
  versionCode?: number;
  apkSha256?: string;
  error?: string;
  updatedAt: string;
}

interface DeviceAuthRecord {
  id: string;
  status: string;
  device_key: string | null;
  lifecycleInitial: boolean;
  lifecycleAdministrative: boolean;
  lifecycleKnown: boolean;
}

export function otaTerminalStatusFromAuthenticatedVersion(
  current: OtaDeviceStatus | undefined,
  authenticatedAgentVersion: string | undefined,
): Omit<Partial<OtaDeviceStatus>, "deviceId" | "updatedAt"> | null {
  if (!current || !authenticatedAgentVersion) return null;
  if (current.terminal) return null;
  if (!current.version || current.version !== authenticatedAgentVersion) return null;

  return {
    terminal: true,
    successful: true,
    version: current.version,
    versionCode: current.versionCode,
    apkSha256: current.apkSha256,
    error: undefined,
  };
}

interface JobResult {
  jobId:    string;
  success:  boolean;
  output:   unknown;
  error?:   string;
}

interface WorkflowLifecycleTarget {
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  markCompleted: boolean;
}

async function resolveExternalWorkflowLifecycleTarget(
  workflowId: string,
  targetStatus: string,
): Promise<WorkflowLifecycleTarget | null> {
  const result = await getDb().query(
    `WITH candidates AS (
       SELECT DISTINCT target.terminal, target.retryable, target.administrative,
              transition.mark_completed
         FROM workflows workflow
         JOIN lifecycle_transitions transition
           ON transition.lifecycle_key = workflow.lifecycle_key
          AND transition.from_status = workflow.status
          AND transition.to_status = $2
          AND transition.external_allowed
         JOIN lifecycle_state_definitions target
           ON target.lifecycle_key = transition.lifecycle_key
          AND target.status = transition.to_status
        WHERE workflow.id = $1
     )
     SELECT candidates.*, COUNT(*) OVER () AS candidate_count
       FROM candidates`,
    [workflowId, targetStatus],
  );
  if (result.rows.length !== 1 || Number(result.rows[0]?.candidate_count) !== 1) return null;
  return {
    terminal: result.rows[0].terminal === true,
    retryable: result.rows[0].retryable === true,
    administrative: result.rows[0].administrative === true,
    markCompleted: result.rows[0].mark_completed === true,
  };
}

let externalWorkflowLifecycleTargetResolver = resolveExternalWorkflowLifecycleTarget;

export function setExternalWorkflowLifecycleTargetResolverForTest(
  resolver: ((workflowId: string, targetStatus: string) => Promise<WorkflowLifecycleTarget | null>) | null,
): void {
  externalWorkflowLifecycleTargetResolver = resolver ?? resolveExternalWorkflowLifecycleTarget;
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
  private pendingWorkflows = new Map<string, PendingWorkflow>();
  // LLM_REQUEST is single-flight per device: concurrent requests are rejected
  // with a stable retryable LLM_RESULT so requestId ownership stays unambiguous.
  private activeLlmRequests = new Map<string, number>();
  private otaStatuses = new Map<string, OtaDeviceStatus>();   // deviceId → last OTA status
  private rateLimiter = new RateLimiter();
  private pingTimer:    ReturnType<typeof setInterval> | null = null;

  private runSocketTask(label: string, task: () => Promise<void>): void {
    void task().catch((err) => {
      console.error(`[direct-ws] ${label} handler failed:`, (err as Error).message);
    });
  }

  private async confirmAmbiguityBeforeCleanup(
    input: Parameters<typeof deviceExecutionArbiter.markAmbiguous>[0],
    cleanup: () => void,
    attempt = 1,
  ): Promise<boolean> {
    if (!isDeviceExecutionEnforced()) {
      cleanup();
      return true;
    }
    try {
      const transition = await deviceExecutionArbiter.markAmbiguous(input);
      const confirmed = await isDeviceExecutionResultQuiescent(transition);
      if (!confirmed) {
        throw new Error(`ambiguity transition not confirmed (${transition.reason ?? transition.decision})`);
      }
      cleanup();
      return true;
    } catch (err) {
      if (attempt < AMBIGUITY_RETRY_MAX_ATTEMPTS) {
        const retry = setTimeout(() => {
          this.runSocketTask("ambiguity retry", async () => {
            await this.confirmAmbiguityBeforeCleanup(input, cleanup, attempt + 1);
          });
        }, AMBIGUITY_RETRY_DELAY_MS);
        retry.unref();
        console.warn(
          `[device-execution] ambiguity transition failed; retained pending work and scheduled retry ${attempt + 1}/${AMBIGUITY_RETRY_MAX_ATTEMPTS}:`,
          (err as Error).message,
        );
      } else {
        console.error(
          `[device-execution] ambiguity transition escalation after ${attempt} attempts; pending work retained:`,
          (err as Error).message,
        );
      }
      return false;
    }
  }

  private async confirmServerWorkflowChildTimeoutBeforeCleanup(
    input: Parameters<typeof deviceExecutionArbiter.expireServerWorkflowChild>[0],
    cleanup: () => void,
    attempt = 1,
  ): Promise<boolean> {
    if (!isDeviceExecutionEnforced()) {
      cleanup();
      return true;
    }
    try {
      const transition = await deviceExecutionArbiter.expireServerWorkflowChild(input);
      if (!(await isDeviceExecutionResultTerminal(transition))) {
        throw new Error(`child timeout transition not confirmed (${transition.reason ?? transition.decision})`);
      }
      cleanup();
      return true;
    } catch (err) {
      if (attempt < AMBIGUITY_RETRY_MAX_ATTEMPTS) {
        const retry = setTimeout(() => {
          this.runSocketTask("server-workflow child timeout retry", async () => {
            await this.confirmServerWorkflowChildTimeoutBeforeCleanup(input, cleanup, attempt + 1);
          });
        }, AMBIGUITY_RETRY_DELAY_MS);
        retry.unref();
        console.warn(
          `[device-execution] child timeout transition failed; retained pending work and scheduled retry ${attempt + 1}/${AMBIGUITY_RETRY_MAX_ATTEMPTS}:`,
          (err as Error).message,
        );
      } else {
        console.error(
          `[device-execution] child timeout transition escalation after ${attempt} attempts; pending work retained:`,
          (err as Error).message,
        );
      }
      return false;
    }
  }

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
    const confirmations: Promise<boolean>[] = [];
    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.permit) {
        confirmations.push(this.confirmAmbiguityBeforeCleanup({
          deviceId: pending.permit.handle.deviceId,
          handle: pending.permit.handle,
          reason: "direct_ws_server_shutdown_before_result",
          actor: "direct_ws_close",
          metadata: { handle: pending.permit.wireHandle },
        }, () => {
          if (this.pendingJobs.get(jobId) !== pending) return;
          clearTimeout(pending.timer);
          this.pendingJobs.delete(jobId);
          pending.reject(new Error("Server shutting down"));
        }));
      } else {
        clearTimeout(pending.timer);
        this.pendingJobs.delete(jobId);
        pending.reject(new Error("Server shutting down"));
      }
    }
    for (const [workflowId, pending] of this.pendingWorkflows) {
      confirmations.push(this.confirmAmbiguityBeforeCleanup({
        deviceId: pending.handle.deviceId,
        handle: pending.handle,
        reason: "direct_ws_server_shutdown_before_workflow_terminal",
        actor: "direct_ws_close",
      }, () => {
        if (this.pendingWorkflows.get(workflowId) !== pending) return;
        clearTimeout(pending.timer);
        this.pendingWorkflows.delete(workflowId);
      }));
    }
    await Promise.all(confirmations);
  }

  // ─── Public API (transport interface) ────────────────────────────────────

  /**
   * Send a job to a device. Returns true if sent, false if device not connected.
   * Does NOT wait for result — use waitForJobResult() for that.
   */
  sendJob(deviceId: string, payload: JobDispatchPayload): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      recordJobExecutionEventDetached({
        jobId: payload.jobId,
        deviceId,
        source: "direct_ws",
        eventType: "direct_ws_send_rejected",
        details: {
          jobType: payload.type,
          reason: conn ? "socket_not_open" : "connection_missing",
          readyState: conn?.ws.readyState ?? null,
        },
      });
      return false;
    }

    this._send(conn.ws, {
      type:    "JOB",
      jobId:   payload.jobId,
      jobType: payload.type,
      nativeOpcode: payload.nativeOpcode,
      observationOnly: payload.observationOnly === true,
      verificationOpcode: payload.verificationOpcode,
      resultStatuses: payload.resultStatuses,
      verificationStrategy: payload.verificationStrategy,
      l1TimeoutMs: payload.l1TimeoutMs,
      l2SettleMs: payload.l2SettleMs,
      params:  payload.params,
      timeoutMs: payload.timeoutMs,
      requiresRoot: payload.requiresRoot,
    });
    recordJobExecutionEventDetached({
      jobId: payload.jobId,
      deviceId,
      source: "direct_ws",
      eventType: "direct_ws_frame_sent",
      details: {
        jobType: payload.type,
        timeoutMs: payload.timeoutMs ?? null,
        connectionEpoch: conn.pnqV2ConnectionEpoch,
      },
    });
    console.log(`[direct-ws] sendJob: device=${deviceId.slice(0,8)} jobId=${payload.jobId?.slice(0,8)} type=${payload.type}`);
    return true;
  }

  getConnectionEpoch(deviceId: string): number | null {
    return this.connections.get(deviceId)?.pnqV2ConnectionEpoch ?? null;
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
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      recordJobExecutionEventDetached({
        jobId: payload.jobId,
        deviceId,
        source: "direct_ws",
        eventType: "direct_ws_send_rejected",
        details: {
          jobType: payload.type,
          reason: conn ? "socket_not_open" : "connection_missing",
          readyState: conn?.ws.readyState ?? null,
          ownerGeneration: permit.handle.ownerGeneration,
        },
      });
      return false;
    }

    this._send(conn.ws, {
      type:    "JOB",
      jobId:   payload.jobId,
      jobType: payload.type,
      nativeOpcode: payload.nativeOpcode,
      observationOnly: payload.observationOnly === true,
      verificationOpcode: payload.verificationOpcode,
      resultStatuses: payload.resultStatuses,
      verificationStrategy: payload.verificationStrategy,
      l1TimeoutMs: payload.l1TimeoutMs,
      l2SettleMs: payload.l2SettleMs,
      params:  payload.params,
      timeoutMs: payload.timeoutMs,
      requiresRoot: payload.requiresRoot,
      pnqHandle: permit.wireHandle,
    });
    recordJobExecutionEventDetached({
      jobId: payload.jobId,
      deviceId,
      source: "direct_ws",
      eventType: "direct_ws_frame_sent",
      details: {
        jobType: payload.type,
        timeoutMs: payload.timeoutMs ?? null,
        connectionEpoch: conn.pnqV2ConnectionEpoch,
        ownerGeneration: permit.handle.ownerGeneration,
      },
    });
    console.log(`[direct-ws] sendJobWithPermit: device=${deviceId.slice(0,8)} jobId=${payload.jobId?.slice(0,8)} type=${payload.type} gen=${permit.handle.ownerGeneration}`);
    return true;
  }

  sendLegacyGeneratedWorkflowJob(
    deviceId: string,
    payload: JobDispatchPayload,
    resultTimeoutMs = 300_000,
  ): { sent: boolean; resultPromise: Promise<JobResult> } {
    const resultPromise = this.registerJobWaiter(payload.jobId, resultTimeoutMs, undefined, {
      deviceId,
      legacyMode: "generated_workflow",
    });
    const sent = this.sendJob(deviceId, payload);
    if (!sent) {
      this.rejectLegacyGeneratedWorkflowJobWaiter(payload.jobId, "legacy_generated_workflow_device_offline");
    }
    return { sent, resultPromise };
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
    options: { deviceId?: string; legacyMode?: "generated_workflow" } = {},
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
      deviceId: permit?.handle.deviceId ?? options.deviceId,
      permit,
      legacyMode: options.legacyMode,
    });
    return promise;
  }

  private rejectLegacyGeneratedWorkflowJobWaiter(jobId: string, reason: string): boolean {
    const pending = this.pendingJobs.get(jobId);
    if (pending?.legacyMode !== "generated_workflow") return false;
    clearTimeout(pending.timer);
    this.pendingJobs.delete(jobId);
    pending.reject(new Error(reason));
    return true;
  }

  private createJobTimeout(
    jobId: string,
    timeoutMs: number,
    reject: (err: Error) => void,
    permit?: DeviceExecutionJobDispatchPermit,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.runSocketTask("job timeout", async () => {
        await this.expirePendingJob(jobId, timeoutMs, permit);
      });
    }, timeoutMs);
    timer.unref();
    return timer;
  }

  private async expirePendingJob(
    jobId: string,
    timeoutMs: number,
    permit?: DeviceExecutionJobDispatchPermit,
  ): Promise<void> {
    const pending = this.pendingJobs.get(jobId);
    if (!pending || pending.permit !== permit) return;
    if (!permit) {
      this.pendingJobs.delete(jobId);
      pending.reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
      return;
    }

    if (permit.handle.rootKind === "server_workflow") {
      await this.confirmServerWorkflowChildTimeoutBeforeCleanup({
        deviceId: permit.handle.deviceId,
        jobId,
        handle: permit.handle,
        actor: "direct_ws_waiter_timeout",
        reason: "job_result_timeout",
        metadata: { timeoutMs, handle: permit.wireHandle },
      }, () => {
        if (this.pendingJobs.get(jobId) !== pending) return;
        this.pendingJobs.delete(jobId);
        pending.reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
      });
      return;
    }
    await this.confirmAmbiguityBeforeCleanup({
      deviceId: permit.handle.deviceId,
      handle: permit.handle,
      reason: "job_result_timeout",
      actor: "direct_ws_waiter_timeout",
      metadata: { timeoutMs, handle: permit.wireHandle },
    }, () => {
      if (this.pendingJobs.get(jobId) !== pending) return;
      this.pendingJobs.delete(jobId);
      pending.reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
    });
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
    if (!isDeviceExecutionEnforced()) {
      const conn = this.connections.get(deviceId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
      this._send(conn.ws, { ...template, type: "WORKFLOW_START", workflowId, variables });
      return true;
    }
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
    await this.confirmAmbiguityBeforeCleanup({
      deviceId: handle.deviceId,
      handle,
      reason: "workflow_status_timeout",
      actor: "direct_ws_workflow_timeout",
    }, () => {
      if (this.pendingWorkflows.get(handle.operationId) !== pending) return;
      this.pendingWorkflows.delete(handle.operationId);
    });
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

  recordOtaStatus(deviceId: string, patch: Omit<Partial<OtaDeviceStatus>, "deviceId" | "updatedAt">): void {
    const existing = this.otaStatuses.get(deviceId) ?? {
      deviceId,
      terminal: false,
      successful: false,
      updatedAt: new Date(0).toISOString(),
    };
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

    ws.on("message", (raw) => {
      this.runSocketTask("message", async () => {
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
        case "JOB_ACK":         await this._handleJobProgress(deviceConn, msg, "agent_job_received"); break;
        case "JOB_STARTED":     await this._handleJobProgress(deviceConn, msg, "agent_job_started"); break;
        case "JOB_RESULT":      await this._handleJobResult(deviceConn, msg);   break;
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
    });

    ws.on("close", (code, reason) => {
      if (authTimeout) clearTimeout(authTimeout);
      if (!deviceConn) return;
      const closedConnection = deviceConn;
      this.runSocketTask("close", async () => {
        await this.handleAuthenticatedClose(ws, closedConnection, code, String(reason));
      });
    });

    ws.on("error", (err) => {
      console.error(`[direct-ws] WebSocket error (device=${deviceConn?.deviceId?.slice(0,8) ?? "unauth"}):`, err.message);
    });
  }

  private async handleAuthenticatedClose(
    ws: WebSocket,
    connection: ConnectedDevice,
    code: number,
    reason: string,
  ): Promise<"closed" | "superseded"> {
    if (this.connections.get(connection.deviceId)?.ws !== ws) {
      console.log(`[direct-ws] Ignoring stale close for superseded device connection ${connection.deviceId.slice(0, 8)}`);
      return "superseded";
    }

    console.log(`[direct-ws] Device ${connection.deviceId.slice(0,8)} disconnected: ${code} ${reason}`);
    this.connections.delete(connection.deviceId);
    this.rateLimiter.delete(connection.deviceId);
    devicesConnected?.set(this.connections.size);
    deviceOfflineEvents?.inc();

    await this.blockPendingForDisconnectedDevice(connection.deviceId, code, reason);
    await devicesService.markOffline(connection.deviceId).catch(err =>
      console.error("[direct-ws] markOffline error:", err)
    );
    await alerting.deviceOffline(connection.deviceId, "direct-ws").catch(() => {});
    return "closed";
  }

  private async blockPendingForDisconnectedDevice(
    deviceId: string,
    closeCode: number,
    closeReason: string,
  ): Promise<{ jobs: number; workflows: number }> {
    const jobs = [...this.pendingJobs.entries()].filter(([, pending]) => pending.deviceId === deviceId);
    const workflows = [...this.pendingWorkflows.entries()].filter(([, pending]) => pending.handle.deviceId === deviceId);
    const confirmations: Promise<boolean>[] = [];

    for (const [jobId, pending] of jobs) {
      if (!pending.permit) {
        clearTimeout(pending.timer);
        if (this.pendingJobs.get(jobId) === pending) this.pendingJobs.delete(jobId);
        pending.reject(new Error(`Device ${deviceId} disconnected`));
        continue;
      }
      confirmations.push(this.confirmAmbiguityBeforeCleanup({
        deviceId,
        handle: pending.permit.handle,
        reason: "device_disconnected_before_job_result",
        actor: "direct_ws_disconnect",
        metadata: { handle: pending.permit.wireHandle, closeCode, closeReason },
      }, () => {
        if (this.pendingJobs.get(jobId) !== pending) return;
        clearTimeout(pending.timer);
        this.pendingJobs.delete(jobId);
        pending.reject(new Error(`Device ${deviceId} disconnected`));
      }));
    }
    for (const [workflowId, pending] of workflows) {
      confirmations.push(this.confirmAmbiguityBeforeCleanup({
        deviceId,
        handle: pending.handle,
        reason: "device_disconnected_before_workflow_terminal",
        actor: "direct_ws_disconnect",
        metadata: { closeCode, closeReason },
      }, () => {
        if (this.pendingWorkflows.get(workflowId) !== pending) return;
        clearTimeout(pending.timer);
        this.pendingWorkflows.delete(workflowId);
      }));
    }
    await Promise.all(confirmations);
    return { jobs: jobs.length, workflows: workflows.length };
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
      let device: DeviceAuthRecord | null = null;
      const authProjection = `
        SELECT d.id,
               d.status,
               d.device_key,
               COALESCE(s.initial, false) AS "lifecycleInitial",
               COALESCE(s.administrative, false) AS "lifecycleAdministrative",
               (s.status IS NOT NULL) AS "lifecycleKnown"
        FROM devices d
        LEFT JOIN lifecycle_resource_bindings b
          ON b.resource_table = 'devices'::regclass
         AND b.state_column = 'status'
        LEFT JOIN lifecycle_state_definitions s
          ON s.lifecycle_key = b.lifecycle_key
         AND s.status = d.status`;
      
      // 1. Normal auth: deviceId + deviceKey
      if (deviceId && deviceKey) {
        const result = await db.query<DeviceAuthRecord>(
          `${authProjection} WHERE d.id = $1 AND d.device_key = $2`,
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
        const result = await db.query<DeviceAuthRecord>(
          `${authProjection} WHERE d.id = $1`,
          [deviceId]
        );
        if (result.rows[0]) {
          const row = result.rows[0];
          const crypto = require('crypto');
          const newKey = crypto.randomBytes(32).toString('hex');
          await db.query(
            `UPDATE devices
             SET device_key = $1,
                 status = CASE
                   WHEN lifecycle_state_matches(
                          'devices'::regclass,
                          status,
                          '{"initial":true}'::jsonb
                        )
                   THEN COALESCE(
                          lifecycle_transition_target(
                            'devices'::regclass,
                            status,
                            '{"targetDispatchable":true,"automatic":true}'::jsonb
                          ),
                          status
                        )
                   ELSE status
                 END
             WHERE id = $2`,
            [newKey, row.id],
          );
          const refreshed = await db.query<DeviceAuthRecord>(
            `${authProjection} WHERE d.id = $1`,
            [row.id],
          );
          device = refreshed.rows[0] ?? null;
          console.log(`[direct-ws] Re-auth via stable deviceId: ${row.id.slice(0,8)} (new key issued, was ${row.status})`);
        }
      }
      
      // 2. Enrollment: fingerprint (UUID generated by device)
      if (!device && fingerprint) {
        console.log(`[direct-ws] Enrollment attempt with fingerprint: ${fingerprint.slice(0,8)}...`);
        
        // Check if device already enrolled with this fingerprint
        const existing = await db.query<DeviceAuthRecord>(
          `${authProjection} WHERE d.fingerprint = $1`,
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
             VALUES ($1, $2, $3, NULL, NOW(), NOW())`,
            [newDeviceId, fingerprint, newDeviceKey]
          );
          const enrolled = await db.query<DeviceAuthRecord>(
            `${authProjection} WHERE d.id = $1`,
            [newDeviceId],
          );
          device = enrolled.rows[0] ?? null;
          console.log(`[direct-ws] NEW device created: ${newDeviceId.slice(0,8)}`);
        }
      }

      if (!device) {
        console.warn(`[direct-ws] AUTH failed: no credentials from ${remoteIp}`);
        this._send(ws, {
          type: "AUTH_FAIL",
          reason: "No valid credentials",
          recovery: getConnectionRecoveryPolicy(false),
        });
        ws.close(4003, "Auth failed");
        return;
      }

      if (device.lifecycleAdministrative || !device.lifecycleKnown) {
        console.warn(`[direct-ws] AUTH failed: device ${device.id.slice(0,8)} is blocked`);
        this._send(ws, {
          type: "AUTH_FAIL",
          reason: "Device blocked",
          recovery: getConnectionRecoveryPolicy(false),
        });
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
        pnqV2ConnectionEpoch: null,
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

      // A successful package replacement can kill the old process after it sent
      // `started` but before it sent the terminal OTA_RESULT. The new process
      // authenticates with the version read from PackageManager, which is
      // authoritative evidence that the requested release is installed. Reconcile
      // the in-flight status before AUTH_OK so the dashboard cannot remain stuck
      // on `started` merely because the process boundary dropped one message.
      const reconciledOtaStatus = otaTerminalStatusFromAuthenticatedVersion(
        this.otaStatuses.get(finalDeviceId),
        deviceInfo?.agentVersion,
      );
      if (reconciledOtaStatus) {
        this.recordOtaStatus(finalDeviceId, reconciledOtaStatus);
        console.log(
          `[direct-ws] OTA reconciled from authenticated package version ` +
          `device=${finalDeviceId.slice(0, 8)} version=${deviceInfo?.agentVersion}`,
        );
      }

      // Send AUTH_OK with deviceId + deviceKey (so device can save for future reconnects)
      this._send(ws, { 
        type: "AUTH_OK", 
        deviceId: finalDeviceId,
        deviceKey: finalDeviceKey,
        status: finalStatus,
        recovery: getConnectionRecoveryPolicy(true),
      });
      console.log(`[direct-ws] Device ${finalDeviceId.slice(0,8)} authenticated (status=${finalStatus}) from ${remoteIp}`);
      onAuth(conn);
      if (isPnqV2ShadowRuntimeEnabled()) {
        const epochObservation = Promise.resolve()
          .then(() => pnqV2RuntimeService.onConnectionAuthenticated(finalDeviceId));
        conn.pnqV2ConnectionEpochPromise = epochObservation;
        runPnqV2ShadowSideEffect("direct-ws auth", () => epochObservation, (epoch) => {
          if (this.connections.get(finalDeviceId) === conn) {
            conn.pnqV2ConnectionEpoch = epoch;
          }
        });
      }
      void import("../transport/transport")
        .then(({ dispatchQueuedJobsForDevice }) => dispatchQueuedJobsForDevice(finalDeviceId, "direct_ws.reconnect_queue_pump"))
        .catch(err => console.error("[device-execution] reconnect queue pump error:", (err as Error).message));

    } catch (err) {
      console.error("[direct-ws] Auth DB error:", (err as Error).message);
      this._send(ws, {
        type: "AUTH_FAIL",
        reason: "Server error",
        recovery: getConnectionRecoveryPolicy(true),
      });
      ws.close(4003, "Server error");
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────

  private async _handleJobProgress(
    conn: ConnectedDevice,
    msg: Record<string, unknown>,
    eventType: "agent_job_received" | "agent_job_started",
  ): Promise<void> {
    const jobId = typeof msg.jobId === "string" ? msg.jobId : "";
    if (!jobId) return;
    if (eventType === "agent_job_started") {
      const claimed = await transitionJob(jobId, {
        targetTerminal: false,
        targetAdministrative: false,
        targetDispatchable: false,
        transitionMarkStarted: true,
        transitionMarkCompleted: false,
      }, {}, getDb(), conn.deviceId).catch((err) => {
        console.warn(`[direct-ws] JOB_STARTED persistence failed: ${(err as Error).message}`);
        return null;
      });
      if (!claimed) {
        console.warn(`[direct-ws] JOB_STARTED rejected for ${jobId.slice(0, 8)} on device ${conn.deviceId.slice(0, 8)}`);
      }
    }
    recordJobExecutionEventDetached({
      jobId,
      deviceId: conn.deviceId,
      source: "direct_ws",
      eventType,
      details: {
        jobType: typeof msg.jobType === "string" ? msg.jobType : null,
        connectionEpoch: conn.pnqV2ConnectionEpoch,
      },
    });
  }

  private async _handleJobResult(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    const jobId = msg.jobId as string;
    if (!jobId) return;
    console.log(`[direct-ws] JOB_RESULT received: jobId=${jobId.slice(0,8)} success=${msg.success} error=${msg.error || 'none'} device=${conn.deviceId.slice(0,8)}`);
    const pending = this.pendingJobs.get(jobId);
    const isLegacyGeneratedWorkflowResult = pending?.legacyMode === "generated_workflow";
    if (!isLegacyGeneratedWorkflowResult && isPnqV2ShadowRuntimeEnabled()) {
      runPnqV2ShadowSideEffect("direct-ws result", () => pnqV2RuntimeService.recordShadowResult({
        legacyJobId: jobId,
        socketEpoch: conn.pnqV2ConnectionEpoch,
        success: Boolean(msg.success),
        result: {
          success: Boolean(msg.success),
          output: msg.output,
          error: msg.error as string | undefined,
          durationMs: (msg.durationMs as number | undefined) ?? 0,
        },
      }));
    }

    const success = Boolean(msg.success);
    const durationMs = (msg.durationMs as number | undefined) ?? 0;
    recordJobExecutionEventDetached({
      jobId,
      deviceId: conn.deviceId,
      source: "direct_ws",
      eventType: "job_result_received",
      details: {
        success,
        durationMs,
        error: (msg.error as string | undefined) ?? null,
        connectionEpoch: conn.pnqV2ConnectionEpoch,
      },
    });
    const wireHandle = isRecord(msg.pnqHandle) ? msg.pnqHandle : null;
    const handleResolution = pending?.permit
      ? resolveDirectWsResultHandle(pending.permit.handle, msg)
      : null;
    const reportedHandle = handleResolution?.reportedHandle ?? decodeDeviceExecutionHandle(wireHandle);

    try {
      if (isLegacyGeneratedWorkflowResult) {
        // Gate A: generated_workflow production compatibility remains the
        // legacy DirectWS JOB/JOB_RESULT contract with no PNQ result authority.
      } else if (!isDeviceExecutionEnforced()) {
        void deviceExecutionArbiter.observeTerminal({
          deviceId: conn.deviceId,
          rootKind: "job",
          externalId: jobId,
          terminalSelector: {
            targetTerminal: true,
            targetRetryable: !success,
            targetAdministrative: false,
            transitionExternalAllowed: true,
          },
          actor: "direct_ws.observe_only",
          reason: msg.error as string | undefined,
          metadata: { authorityMode: "observe_only" },
        });
      } else {
      const accepted = await deviceExecutionArbiter.acceptJobResult({
        deviceId: conn.deviceId,
        jobId,
        handle: pending?.permit?.handle,
        reportedHandle,
        allowLegacyMissingHandle: handleResolution?.compatibility === "authenticated_pending_handle",
        success,
        actor: "direct_ws",
        reason: msg.error as string | undefined,
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
        success,
        output:  msg.output,
        error:   msg.error as string | undefined,
      });
    }

    // ── Resolve workflow executor's pending promise (critical for blocking workflows) ──
    // Keep the legacy waiter resolution synchronous with JOB_RESULT handling.
    // A dynamic import here defers the critical workflow wake-up and caused
    // generated workflows to remain pending even after the device replied.
    const resolved = resolveWorkflowExecutorJobResult(jobId, {
      successful: success,
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
      success,
      output:     msg.output as Record<string, unknown>,
      error:      msg.error as string | undefined,
      durationMs,
      authority: isLegacyGeneratedWorkflowResult ? "legacy_generated_workflow" : undefined,
    }).catch(err => console.error("[direct-ws] handleJobResult error:", err.message));

    // ACK
    this._send(conn.ws, { type: "ACK", ref: jobId });
    if (!isLegacyGeneratedWorkflowResult) {
      void import("../transport/transport")
        .then(({ dispatchQueuedJobsForDevice }) => dispatchQueuedJobsForDevice(conn.deviceId, "direct_ws.job_result_queue_pump"))
        .catch(err => console.error("[device-execution] direct-ws queue pump error:", (err as Error).message));
    }
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
      lifecycleTelemetry: sanitizeLifecycleTelemetry(msg.lifecycleTelemetry),
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
        this.runSocketTask("non-open connection cleanup", async () => {
          await this.handleAuthenticatedClose(conn.ws, conn, 1006, "socket no longer open");
        });
        continue;
      }

      // PONG timeout — zombie connection
      if (now - conn.lastPongAt > PONG_TIMEOUT_MS) {
        console.warn(`[direct-ws] PONG timeout for device ${deviceId.slice(0,8)} — closing`);
        conn.ws.close(4002, "PONG timeout");
        this.runSocketTask("PONG timeout cleanup", async () => {
          await this.handleAuthenticatedClose(conn.ws, conn, 4002, "PONG timeout");
        });
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
    if (isDeviceExecutionEnforced() && (!expectedHandle || !handleResolution?.accepted || !reportedHandle || reportedHandle.deviceId !== conn.deviceId)) {
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
      const lifecycleTarget = await externalWorkflowLifecycleTargetResolver(workflowId, status);
      workflowEvents.publish({
        source: "edge_device",
        event: lifecycleTarget?.terminal === true && lifecycleTarget.retryable !== true
          ? "completed"
          : lifecycleTarget?.terminal === true && lifecycleTarget.retryable === true
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

      if (lifecycleTarget?.terminal === true) {
        const terminal = isDeviceExecutionEnforced()
          ? await deviceExecutionArbiter.observeTerminal({
              deviceId: conn.deviceId,
              handle: reportedHandle!,
              status,
              actor: "direct_ws",
              reason: error,
              metadata: {
                step: typeof step === "number" ? step : null,
                total: typeof total === "number" ? total : null,
                handleCompatibility: handleResolution!.compatibility,
              },
            })
          : await deviceExecutionArbiter.observeTerminal({
              deviceId: conn.deviceId,
              rootKind: "edge_workflow",
              externalId: workflowId,
              status,
              actor: "direct_ws.observe_only",
              reason: error,
              metadata: {
                authorityMode: "observe_only",
                step: typeof step === "number" ? step : null,
                total: typeof total === "number" ? total : null,
              },
            });
        if (!(await isDeviceExecutionResultTerminal(terminal))) return;
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
    const db = getDb();
    const existing = await db.query(
      "SELECT checkpoint FROM workflows WHERE id = $1",
      [workflowId]
    );
    const mergedVariables = mergeWorkflowStatusVariables(existing.rows[0]?.checkpoint, variables);

    const { reconcileEdgeLearningStatus } = require("../modules/ui-graph/edge-learning.service");
    await reconcileEdgeLearningStatus({
      workflowId,
      deviceId,
      status,
      currentStep: typeof step === "number" ? step : 0,
      error,
      variables: mergedVariables,
    }).catch((learningError: Error) => {
      console.error(`[ui-graph] edge learning reconciliation failed for ${workflowId}: ${learningError.message}`);
    });

    const lifecycleTarget = await externalWorkflowLifecycleTargetResolver(workflowId, status);
    if (!lifecycleTarget) {
      throw new Error(`DB lifecycle rejected external workflow transition to '${status}'`);
    }
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
        failedSteps: lifecycleTarget.terminal && lifecycleTarget.retryable ? 1 : 0,
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

    const { transitionWorkflowFromExternalStatus } = require("../modules/workflows/workflow-lifecycle.service");
    const successfulTerminal = lifecycleTarget.terminal
      && !lifecycleTarget.retryable
      && !lifecycleTarget.administrative;
    const persistedCheckpoint = successfulTerminal
      ? { ...checkpoint, result: { step, total, variables: mergedVariables } }
      : lifecycleTarget.terminal
        ? checkpoint
        : {
            ...checkpoint,
            progress: { step, total, error, variables: JSON.stringify(mergedVariables).slice(0, 1000) },
          };
    const transitioned = await transitionWorkflowFromExternalStatus(
      workflowId,
      status,
      {
        checkpoint: persistedCheckpoint,
        currentStep: successfulTerminal ? (step ?? total) : step,
        totalSteps: total,
        ...(lifecycleTarget.terminal && lifecycleTarget.retryable
          ? { error: error || "Device reported failure" }
          : {}),
      },
      db,
    );
    if (!transitioned) {
      const current = await db.query(
        `SELECT state.status, state.terminal
           FROM workflows workflow
           JOIN lifecycle_state_definitions state
             ON state.lifecycle_key = workflow.lifecycle_key
            AND state.status = workflow.status
          WHERE workflow.id = $1`,
        [workflowId],
      );
      if (current.rows[0]?.terminal !== true) {
        throw new Error(`DB lifecycle rejected external workflow transition to '${status}'`);
      }
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
    const role = screenshot ? "vision_vlm" : "decision_llm";

    console.log(`[direct-ws] LLM_REQUEST: device=${conn.deviceId.slice(0,8)} requestId=${requestId || "missing"} role=${role} hasImage=${!!screenshot} promptLength=${typeof prompt === "string" ? prompt.length : 0} imageBytes=${typeof screenshot === "string" ? screenshot.length : 0}`);

    if (!requestId || typeof prompt !== "string") {
      this.sendLlmError(ws, requestId, "AI_LLM_REQUEST_INVALID", "LLM request is missing requestId or prompt.", false);
      return;
    }

    if (!this.acquireLlmSlot(conn.deviceId)) {
      this.sendLlmError(ws, requestId, "AI_LLM_BUSY", "Another LLM request is already running for this device.", true);
      return;
    }

    try {
      const text = screenshot
        ? await visionService.analyzeCustomPrompt(
            screenshot,
            prompt,
            { maxTokens: 500, temperature: 0.3, timeoutMs: 30_000 }
          )
        : await llmComplete(prompt, undefined, { max_tokens: 220, timeoutMs: 30_000 });

      this._send(ws, {
        type: 'LLM_RESULT',
        requestId,
        result: text,
      });
    } catch (err) {
      const code = classifyLlmError(err);
      console.error(`[direct-ws] LLM_REQUEST failed: device=${conn.deviceId.slice(0,8)} requestId=${requestId} code=${code}`);
      this.sendLlmError(ws, requestId, code, llmErrorMessage(code), code !== "AI_MODEL_CONFIG_ERROR");
    } finally {
      this.releaseLlmSlot(conn.deviceId);
    }
  }

  private acquireLlmSlot(deviceId: string): boolean {
    const current = this.activeLlmRequests.get(deviceId) ?? 0;
    if (current >= 1) return false;
    this.activeLlmRequests.set(deviceId, current + 1);
    return true;
  }

  private releaseLlmSlot(deviceId: string): void {
    const current = this.activeLlmRequests.get(deviceId) ?? 0;
    if (current <= 1) this.activeLlmRequests.delete(deviceId);
    else this.activeLlmRequests.set(deviceId, current - 1);
  }

  private sendLlmError(ws: WebSocket, requestId: string | undefined, code: string, message: string, retryable: boolean): void {
    this._send(ws, {
      type: "LLM_RESULT",
      requestId,
      result: "",
      error: code,
      errorCode: code,
      errorMessage: message,
      retryable,
    });
  }

  private _handleOtaResult(conn: ConnectedDevice, msg: Record<string, unknown>): void {
    const terminal = msg.terminal === true;
    const successful = msg.successful === true;
    const version = typeof msg.version === "string" ? msg.version : undefined;
    const versionCode = typeof msg.versionCode === "number" ? msg.versionCode : undefined;
    const apkSha256 = typeof msg.apkSha256 === "string" ? msg.apkSha256 : undefined;
    const error = typeof msg.error === "string" ? msg.error : undefined;
    this.recordOtaStatus(conn.deviceId, { terminal, successful, version, versionCode, apkSha256, error });
    console.log(
      `[direct-ws] OTA_RESULT device=${conn.deviceId.slice(0, 8)} terminal=${terminal} successful=${successful}` +
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
export function sanitizeLifecycleTelemetry(value: unknown): DeviceHealth["lifecycleTelemetry"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const number = (key: string): number => {
    const candidate = Number(input[key]);
    return Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  };
  const text = (key: string, max = 2_000): string | null => {
    const candidate = input[key];
    return typeof candidate === "string" ? candidate.slice(0, max) : null;
  };
  return {
    processGeneration: number("processGeneration"),
    processStartedAt: number("processStartedAt"),
    lastEvent: text("lastEvent", 120) ?? "unknown",
    lastEventDetail: text("lastEventDetail"),
    lastEventAt: number("lastEventAt"),
    previousExitInference: text("previousExitInference", 160) ?? "unknown",
    unexpectedProcessRestartCount: number("unexpectedProcessRestartCount"),
    crashCount: number("crashCount"),
    lastCrashStack: text("lastCrashStack"),
    recoveryAlarmCount: number("recoveryAlarmCount"),
    lastRecoverySource: text("lastRecoverySource", 160),
    batteryOptimizationExempt: input.batteryOptimizationExempt === true,
  };
}
