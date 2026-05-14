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
import type { IncomingMessage, Server } from "http";
import { getDb } from "../db/client";
import { scalabilityConfig } from "../config/scalability.config";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import { devicesService } from "../modules/devices/devices.service";
import { devicesConnected, deviceOfflineEvents, recordDeviceHealth } from "../modules/observability/metrics";
import { alerting } from "../modules/observability/alerts";
import type { JobDispatchPayload, DeviceHealth } from "../../shared/protocol/messages";

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
  resolve: (result: JobResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

interface PendingBatch {
  resolve: (result: BatchResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
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
  private rateLimiter = new RateLimiter();
  private pingTimer:    ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  attach(httpServer: Server): void {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws-direct" });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    this.wss.on("error", (err) => console.error("[direct-ws] WSS error:", err.message));

    // Periodic PING + stale connection cleanup
    this.pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL_MS);
    console.log("[direct-ws] Attached to HTTP server on /ws-direct");
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss?.close();
    // Reject all pending jobs
    for (const [jobId, pending] of this.pendingJobs) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Server shutting down"));
      this.pendingJobs.delete(jobId);
    }
    // Reject all pending batches
    for (const [batchId, pending] of this.pendingBatches) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Server shutting down"));
      this.pendingBatches.delete(batchId);
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
    });
    console.log(`[direct-ws] sendJob: device=${deviceId.slice(0,8)} jobId=${payload.jobId?.slice(0,8)} type=${payload.type}`);
    return true;
  }

  /**
   * Returns a Promise that resolves when JOB_RESULT arrives for this jobId.
   * Rejects after timeoutMs (default: 5 min).
   */
  waitForJobResult(jobId: string, timeoutMs = 300_000): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingJobs.set(jobId, { resolve, reject, timer });
    });
  }

  /**
   * Send a BATCH_START message to a device.
   * Returns true if sent, false if device not connected.
   */
  sendBatch(deviceId: string, batchPayload: Record<string, unknown>): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    this._send(conn.ws, batchPayload);
    const batchId = (batchPayload.batchId as string) ?? "?";
    console.log(`[direct-ws] sendBatch: device=${deviceId.slice(0,8)} batchId=${batchId.slice(0,8)} steps=${(batchPayload.steps as unknown[])?.length ?? 0}`);
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
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    this._send(conn.ws, {
      ...template,
      // Keep protocol type LAST so a template field named `type` can never
      // overwrite WORKFLOW_START and make the Android client ignore the run.
      type: 'WORKFLOW_START',
      ...(workflowId ? { workflowId } : {}),
      variables: variables ?? {},
    });
    console.log(`[direct-ws] sendWorkflowStart: device=${deviceId.slice(0,8)} template=${(template.id as string)?.slice(0,20)} workflow=${workflowId?.slice(0,8) ?? 'none'}`);
    return true;
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBatches.delete(batchId);
        reject(new Error(`Batch ${batchId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingBatches.set(batchId, { resolve, reject, timer });
    });
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
        case "JOB_RESULT":      this._handleJobResult(deviceConn, msg);   break;
        case "BATCH_RESULT":    this._handleBatchResult(deviceConn, msg); break;
        case "HEARTBEAT":       await this._handleHeartbeat(deviceConn, msg); break;
        case "PING":            this._send(ws, { type: "PONG" });          break;
        case "PONG":            deviceConn.lastPongAt = Date.now();         break;
        // ── Edge Workflow Execution (ADR-001) ──
        case "WORKFLOW_STATUS": this._handleWorkflowStatus(deviceConn, msg); break;
        case "LLM_REQUEST":    this._handleLlmRequest(deviceConn, ws, msg); break;
        default:                console.warn(`[direct-ws] Unknown message type: ${type}`); break;
      }
    });

    ws.on("close", (code, reason) => {
      if (deviceConn) {
        console.log(`[direct-ws] Device ${deviceConn.deviceId.slice(0,8)} disconnected: ${code} ${reason}`);
        this.connections.delete(deviceConn.deviceId);
        this.rateLimiter.delete(deviceConn.deviceId);
        devicesConnected?.set(this.connections.size);
        deviceOfflineEvents?.inc();

        // Reject any pending jobs for this device
        for (const [jobId, pending] of this.pendingJobs) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Device ${deviceConn!.deviceId} disconnected`));
          this.pendingJobs.delete(jobId);
        }

        // Reject any pending batches for this device
        for (const [batchId, pending] of this.pendingBatches) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Device ${deviceConn!.deviceId} disconnected during batch ${batchId}`));
          this.pendingBatches.delete(batchId);
        }

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

    } catch (err) {
      console.error("[direct-ws] Auth DB error:", (err as Error).message);
      this._send(ws, { type: "AUTH_FAIL", reason: "Server error" });
      ws.close(4003, "Server error");
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────

  private _handleJobResult(conn: ConnectedDevice, msg: Record<string, unknown>): void {
    const jobId = msg.jobId as string;
    if (!jobId) return;
    console.log(`[direct-ws] JOB_RESULT received: jobId=${jobId.slice(0,8)} success=${msg.success} error=${msg.error || 'none'} device=${conn.deviceId.slice(0,8)}`);

    const pending = this.pendingJobs.get(jobId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingJobs.delete(jobId);
      pending.resolve({
        jobId,
        success: Boolean(msg.success),
        status:  Boolean(msg.success) ? "completed" : "failed",
        output:  msg.output,
        error:   msg.error as string | undefined,
      });
    }

    // ── Resolve workflow executor's pending promise (critical for blocking workflows) ──
    const { resolveJobResult } = require("../modules/workflows/workflow.executor");
    const resolved = resolveJobResult(jobId, {
      status:     Boolean(msg.success) ? "completed" : "failed",
      output:     msg.output,
      error:      msg.error as string | undefined,
      durationMs: (msg.durationMs as number | undefined) ?? 0,
    });
    if (resolved) {
      console.log(`[direct-ws] JOB_RESULT resolved for workflow executor: jobId=${jobId.slice(0,8)}`);
    }

    // Forward to dispatcherService for DB update + metrics
    dispatcherService.handleJobResult({
      jobId,
      deviceId:   conn.deviceId,
      status:     msg.success ? "completed" : "failed",
      output:     msg.output as Record<string, unknown>,
      error:      msg.error as string | undefined,
      durationMs: (msg.durationMs as number | undefined) ?? 0,
    }).catch(err => console.error("[direct-ws] handleJobResult error:", err.message));

    // ACK
    this._send(conn.ws, { type: "ACK", ref: jobId });
  }

  // ─── Batch result handler ────────────────────────────────────────────────

  private _handleBatchResult(conn: ConnectedDevice, msg: Record<string, unknown>): void {
    const batchId = msg.batchId as string;
    if (!batchId) {
      console.warn("[direct-ws] BATCH_RESULT missing batchId — ignoring");
      return;
    }

    const status = msg.status as string;
    const results = (msg.results as unknown[]) ?? [];
    const totalDurationMs = (msg.totalDurationMs as number) ?? 0;

    console.log(`[direct-ws] BATCH_RESULT received: batchId=${batchId.slice(0,8)} status=${status} steps=${results.length} totalMs=${totalDurationMs} device=${conn.deviceId.slice(0,8)}`);

    // Resolve waiting promise
    const pending = this.pendingBatches.get(batchId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingBatches.delete(batchId);
      pending.resolve({
        batchId,
        workflowId:      msg.workflowId as string ?? "",
        status,
        results,
        executedAt:       msg.executedAt as string ?? new Date().toISOString(),
        totalDurationMs,
        error:           msg.error as string | undefined,
      });
    } else {
      console.warn(`[direct-ws] BATCH_RESULT for unknown batchId=${batchId.slice(0,8)} — no pending awaiter`);
    }

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
  private _handleWorkflowStatus(conn: ConnectedDevice, msg: Record<string, unknown>): void {
    const workflowId = msg.workflowId as string;
    const status     = msg.status as string;
    const step       = msg.currentStep as number;
    const total      = msg.totalSteps as number;
    const error      = msg.error as string | undefined;
    const variables  = msg.variables as Record<string, unknown> | undefined;

    console.log(
      `[direct-ws] WORKFLOW_STATUS: device=${conn.deviceId.slice(0,8)} ` +
      `workflow=${workflowId?.slice(0,8)} status=${status} step=${step}/${total}` +
      (error ? ` error=${error}` : '')
    );

    // Update DB (fire-and-forget)
    this._persistWorkflowStatus(conn.deviceId, workflowId, status, step, total, error, variables)
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

    const checkpoint = {
      stepIndex: step,
      loopStack: [],
      variables: variables ?? {},
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
        [step ?? total, total, JSON.stringify({ ...checkpoint, result: { step, total, variables } }), workflowId]
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
            progress: { step, total, error, variables: variables ? JSON.stringify(variables).slice(0, 1000) : null },
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
    const model     = msg.model as string || 'gemma4';

    console.log(`[direct-ws] LLM_REQUEST: device=${conn.deviceId.slice(0,8)} model=${model} prompt=${prompt?.slice(0, 80)}...`);

    try {
      // Forward to local VLM endpoint
      const vlmPort = process.env.VLM_PORT || '18791';
      const response = await fetch(`http://localhost:${vlmPort}/api/vlm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, model }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`VLM returned ${response.status}`);
      }

      const result = await response.json() as { text?: string; result?: string };
      const text = result.text || result.result || '';

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
