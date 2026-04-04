/**
 * ws/direct-ws.server.ts
 * Direct WebSocket transport — low-latency alternative to Nostr relay.
 *
 * Designed for phones behind DDNS + port-forward where sub-second latency matters.
 * Operates alongside Nostr transport — selectable via TRANSPORT_MODE env var:
 *   TRANSPORT_MODE=direct     → only DirectWs
 *   TRANSPORT_MODE=nostr      → only Nostr
 *   TRANSPORT_MODE=both       → both active (phones choose)
 *
 * Auth flow:
 *   1. Device connects: ws://host:3000/ws-direct
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
 * Transport interface compatible with NostrAdapter for drop-in use in routes.ts.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { getDb } from "../db/client";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import { devicesService } from "../modules/devices/devices.service";
import { devicesConnected, deviceOfflineEvents, recordDeviceHealth } from "../modules/observability/metrics";
import { alerting } from "../modules/observability/alerts";
import type { JobDispatchPayload, DeviceHealth } from "../../shared/protocol/messages";

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS       = 30_000;   // 30s to send AUTH message
const PONG_TIMEOUT_MS       = 90_000;   // 90s without PONG = dead connection
const PING_INTERVAL_MS      = 30_000;   // send PING every 30s
const OFFLINE_THRESHOLD_MS  = 90_000;   // heartbeat gap before marking offline
const MAX_MSG_BYTES         = 5 * 1024 * 1024;  // 5MB
const RATE_LIMIT            = 20;       // msgs/sec per device
const RATE_WINDOW_MS        = 1_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectedDevice {
  ws:           WebSocket;
  deviceId:     string;
  connectedAt:  number;
  lastSeenAt:   number;
  lastPongAt:   number;
  msgCount:     number;
  windowStart:  number;
}

interface PendingJob {
  resolve: (result: JobResult) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

interface JobResult {
  jobId:    string;
  success:  boolean;
  output:   unknown;
  error?:   string;
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

  isDeviceOnline(deviceId: string): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;
    return conn.ws.readyState === WebSocket.OPEN &&
           Date.now() - conn.lastSeenAt < OFFLINE_THRESHOLD_MS;
  }

  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys()).filter(id => this.isDeviceOnline(id));
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  // ─── Connection handler ───────────────────────────────────────────────────

  private _onConnection(ws: WebSocket, _req: IncomingMessage): void {
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
        case "JOB_RESULT":   this._handleJobResult(deviceConn, msg);   break;
        case "HEARTBEAT":    await this._handleHeartbeat(deviceConn, msg); break;
        case "PING":         this._send(ws, { type: "PONG" });          break;
        case "PONG":         deviceConn.lastPongAt = Date.now();         break;
        default:             console.warn(`[direct-ws] Unknown message type: ${type}`); break;
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
    const { deviceId, deviceKey, nostrPubkey } = msg as { 
      deviceId?: string; 
      deviceKey?: string; 
      nostrPubkey?: string; 
    };

    if (!nostrPubkey) {
      ws.close(4001, "nostrPubkey required for enrollment");
      return;
    }

    try {
      const db = getDb();
      let device: { id: string; status: string; device_key: string | null } | null = null;
      
      // If device has deviceId + deviceKey → normal auth flow
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
      
      // If no deviceId/deviceKey OR device not found → try enrollment flow
      if (!device) {
        console.log(`[direct-ws] No device by deviceId+key, trying enrollment by nostr_pubkey: ${nostrPubkey.slice(0,16)}...`);
        const result = await db.query<{ id: string; status: string; device_key: string | null }>(
          `SELECT id, status, device_key FROM devices WHERE nostr_pubkey = $1`,
          [nostrPubkey]
        );
        const existing = result.rows[0] || null;
        
        if (existing) {
          // Device exists by nostr_pubkey → authenticate
          device = existing;
          console.log(`[direct-ws] Found existing device by nostr_pubkey: ${device.id.slice(0,8)}`);
        } else {
          // NEW ENROLLMENT FLOW: Create device with status 'pending'
          console.log(`[direct-ws] Creating NEW device for nostr_pubkey: ${nostrPubkey.slice(0,16)}...`);
          const crypto = require('crypto');
          const newDeviceId = crypto.randomUUID();
          const newDeviceKey = crypto.randomBytes(32).toString('hex');
          
          await db.query(
            `INSERT INTO devices (id, nostr_pubkey, device_key, status, first_seen_at, last_seen_at) 
             VALUES ($1, $2, $3, 'pending', NOW(), NOW())`,
            [newDeviceId, nostrPubkey, newDeviceKey]
          );
          
          device = {
            id: newDeviceId,
            status: 'pending', 
            device_key: newDeviceKey
          };
          
          console.log(`[direct-ws] NEW device created: ${newDeviceId.slice(0,8)} status=pending`);
        }
      }

      if (!device) {
        console.warn(`[direct-ws] AUTH failed: could not resolve device (deviceId=${deviceId?.slice(0,8)} nostrPubkey=${nostrPubkey?.slice(0,16)}) from ${remoteIp}`);
        this._send(ws, { type: "AUTH_FAIL", reason: "Device enrollment failed" });
        ws.close(4003, "Device enrollment failed");
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
      };
      this.connections.set(finalDeviceId, conn);
      devicesConnected?.set(this.connections.size);

      // Update DB — mark online
      await devicesService.markOnline(finalDeviceId, remoteIp).catch(err =>
        console.warn("[direct-ws] markOnline error:", err.message)
      );

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

    const pending = this.pendingJobs.get(jobId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingJobs.delete(jobId);
      pending.resolve({
        jobId,
        success: Boolean(msg.success),
        output:  msg.output,
        error:   msg.error as string | undefined,
      });
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

  private async _handleHeartbeat(conn: ConnectedDevice, msg: Record<string, unknown>): Promise<void> {
    // Direct-WS heartbeat uses a simplified format; map to DeviceHealth
    const health: DeviceHealth = {
      batteryLevel:    (msg.battery as number)      ?? 0,
      charging:        Boolean(msg.charging),
      storageFreeBytes: 0,
      thermalStatus:   "nominal",
      networkType:     (msg.networkType as DeviceHealth["networkType"]) ?? "none",
      networkQuality:  (msg.networkQuality as DeviceHealth["networkQuality"]) ?? "none",
      activeApp:       msg.foregroundApp as string | undefined,
      agentVersion:    (msg.agentVersion as string) ?? "unknown",
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

  // ─── Util ─────────────────────────────────────────────────────────────────

  private _send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...payload, ts: Date.now() }));
    }
  }
}

export const directWsServer = new DirectWsServer();
