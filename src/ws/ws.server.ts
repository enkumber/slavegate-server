/**
 * ws/ws.server.ts
 * WebSocket server — ECDSA challenge-response auth, heartbeat, message routing.
 *
 * Auth flow (v4):
 *   1. Device → HELLO { imei, publicKeyPem, model, androidVersion, agentVersion }
 *   2. Server → CHALLENGE { deviceId, nonce } (if approved/online)
 *      or HELLO_REJECT { code: "AWAITING_APPROVAL" | "BLOCKED" }
 *   3. Device → CHALLENGE_RESPONSE { deviceId, signature }
 *   4. Server → HELLO_ACK { deviceId } (authenticated)
 *
 * Security:
 * - Unauthenticated connections auto-closed after 30s
 * - Max message size: 5MB
 * - Rate limit: 20 messages/second per connection
 * - Protocol-level ping/pong every 15s
 * - Application-level PING/PONG for Cloudflare proxy keepalive
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { authService } from "../modules/auth/auth.service";
import { devicesService } from "../modules/devices/devices.service";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import { getDb } from "../db/client";
import { decodeDeviceExecutionHandle, deviceExecutionArbiter } from "../modules/device-execution";
import {
  devicesConnected, deviceOfflineEvents, recordDeviceHealth,
} from "../modules/observability/metrics";
import { alerting } from "../modules/observability/alerts";
import { isKillSwitchActiveSync } from "../api/routes";
import type {
  WsMessage,
  HeartbeatPayload,
  JobResultPayload,
  HealthReportPayload,
  JobDispatchPayload,
} from "../../shared/protocol/messages";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_BYTES      = 5 * 1024 * 1024;  // 5MB
const RATE_LIMIT_MSGS_PER_S  = 20;
const RATE_LIMIT_WINDOW_MS   = 1_000;
const HEARTBEAT_IDLE_MS      = 120_000;
const HEARTBEAT_ACTIVE_MS    = 30_000;
const OFFLINE_MULTIPLIER     = 3;
const PROTOCOL_PING_INTERVAL = 15_000;
const AUTH_TIMEOUT_MS        = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  imei: string;
  location?: string;
  connectedAt: number;
  lastMessageAt: number;
  heartbeatInterval: "active" | "idle";
  msgCount: number;
  windowStart: number;
  supersededAt?: number;  // Timestamp when this connection was replaced by a newer one
}

interface HelloPayload {
  imei: string;
  publicKeyPem: string;
  model?: string;
  androidVersion?: string;
  agentVersion?: string;
}

interface ChallengeResponsePayload {
  deviceId: string;
  signature: string;  // base64-encoded ECDSA-SHA256 signature of nonce bytes
}

// ─── WsServer ─────────────────────────────────────────────────────────────────

class SlidingWindowRateLimiter {
  private windows = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const now   = Date.now();
    const times = (this.windows.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (times.length >= this.limit) return false;
    times.push(now);
    this.windows.set(key, times);
    return true;
  }
  delete(key: string): void { this.windows.delete(key); }
}

export class WsServer {
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, DeviceConnection>();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private visionRateLimit = new SlidingWindowRateLimiter(2, 1_000);

  attach(httpServer: Server): void {
    // Mark all devices offline before accepting connections — stale state from prev run
    devicesService.markAllOffline().catch((err) =>
      console.error("[ws] Failed to mark devices offline at startup:", err)
    );

    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
      maxPayload: MAX_MESSAGE_BYTES,
    });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    this.monitorInterval = setInterval(() => this.checkHeartbeats(), 15_000);

    this.pingInterval = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.ping();
        }
      }
    }, PROTOCOL_PING_INTERVAL);

    console.log("[ws] WebSocket server attached (ECDSA auth).");
  }

  // ─── Public: send to device ────────────────────────────────────────────────

  sendJob(deviceId: string, payload: JobDispatchPayload): boolean {
    if (isKillSwitchActiveSync()) {
      console.warn(`[ws] sendJob blocked by kill switch for device ${deviceId}`);
      return false;
    }
    const result = this.sendToDevice(deviceId, "JOB_DISPATCH", payload);
    console.log(`[ws] sendJob: deviceId=${deviceId.slice(0,8)} type=${payload.type} jobId=${payload.jobId?.slice(0,8)} sent=${result}`);
    return result;
  }

  sendRevoked(deviceId: string): boolean {
    return this.sendToDevice(deviceId, "AUTH_REVOKED", {});
  }



  sendKillSwitch(deviceId: string | "ALL", reason: string): number {
    const payload = { reason, ts: Date.now() };
    if (deviceId === "ALL") {
      let sent = 0;
      for (const [id] of this.connections) {
        if (this.sendToDevice(id, "KILL_SWITCH", payload)) sent++;
      }
      console.warn(`[ws] KILL_SWITCH sent to ${sent} connected devices`);
      return sent;
    }
    return this.sendToDevice(deviceId, "KILL_SWITCH", payload) ? 1 : 0;
  }

  isDeviceConnected(deviceId: string): boolean {
    const conn = this.connections.get(deviceId);
    return !!conn && conn.ws.readyState === WebSocket.OPEN;
  }

  // findConnectionByPrefix removed — deviceId is always full UUID

  // ─── OTA broadcast ─────────────────────────────────────────────────────────

  broadcastOta(payload: {
    apkUrl: string;
    apkSha256: string;
    apkSignature: string;
    versionCode: number;
    version: string;
  }, targetDeviceIds?: string[]): number {
    let sent = 0;
    const targets = targetDeviceIds ?? Array.from(this.connections.keys());
    for (const deviceId of targets) {
      if (this.sendToDevice(deviceId, "OTA_UPDATE", payload)) sent++;
    }
    console.log(`[ws] OTA_UPDATE sent to ${sent} devices`);
    return sent;
  }

  // ─── Connection handler ────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = (req.headers["cf-connecting-ip"] as string) 
      ?? (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress 
      ?? "unknown";
    const state = { conn: null as DeviceConnection | null, isPending: false };

    ws.on("error", (err) => {
      console.error(`[ws] Socket error from ${ip}:`, err.message);
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        ws.close(4000, "Binary messages not supported");
        return;
      }

      const text = data.toString();
      if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
        ws.close(4000, "Message too large");
        return;
      }

      if (state.conn && !this.checkRateLimit(state.conn)) {
        console.warn(`[ws] Rate limit exceeded: device ${state.conn.imei}`);
        ws.close(4029, "Rate limit exceeded");
        return;
      }

      if (state.conn) state.conn.lastMessageAt = Date.now();

      try {
        const msg = JSON.parse(text) as WsMessage;
        await this.routeMessage(ws, msg, state, ip);
      } catch (err) {
        console.error("[ws] Message error:", (err as Error).message);
      }
    });

    ws.on("close", async (code, reason) => {
      const conn = state.conn;
      console.log(`[ws-debug] onClose: code=${code} reason=${reason?.toString() ?? 'none'} hasConn=${!!conn} deviceId=${conn?.deviceId?.slice(0,8) ?? 'N/A'}`);
      if (conn) {
        // IMPORTANT: Only remove from Map if THIS connection is still the active one
        // Prevents race condition when device reconnects and old connection closes after new one is added
        const currentConn = this.connections.get(conn.deviceId);
        const isStillActive = currentConn === conn;
        
        if (isStillActive) {
          this.connections.delete(conn.deviceId);
          this.visionRateLimit.delete(conn.deviceId);
          devicesConnected?.set(this.connections.size);
          deviceOfflineEvents?.labels(conn.deviceId, conn.location ?? "unknown")?.inc();
          await alerting.deviceOffline(conn.deviceId, conn.location ?? "unknown");
          await devicesService.markOffline(conn.deviceId);
          console.log(`[ws] Device ${conn.imei} disconnected. mapSize=${this.connections.size}`);
        } else {
          console.log(`[ws-debug] onClose: stale connection for ${conn.deviceId.slice(0,8)}, newer connection active — skipping cleanup`);
        }
      } else {
        console.log(`[ws-debug] onClose: no conn in state (unauthenticated or already cleaned up)`);
      }
    });

    ws.on("pong", () => {
      if (state.conn) state.conn.lastMessageAt = Date.now();
    });

    setTimeout(() => {
      if (!state.conn && !state.isPending && ws.readyState === WebSocket.OPEN) {
        console.warn("[ws] Closing unauthenticated connection from", ip);
        ws.close(4001, "Authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);
  }

  // ─── Message routing ──────────────────────────────────────────────────────

  private async routeMessage(
    ws: WebSocket,
    msg: WsMessage,
    state: { conn: DeviceConnection | null; isPending: boolean },
    ip: string
  ): Promise<void> {
    switch (msg.type) {
      case "HELLO":
        await this.handleHello(ws, msg.payload as HelloPayload, ip, state);
        break;

      case "CHALLENGE_RESPONSE":
        await this.handleChallengeResponse(ws, msg.payload as ChallengeResponsePayload, ip, state);
        break;

      case "PING":
        // DEBUG: Log PING for diagnosis (remove in production)
        console.log(`[ws] PING from device=${state.conn?.deviceId?.slice(0,8) ?? 'unauth'} at=${Date.now()}`);
        ws.send(JSON.stringify({ type: "PONG" }));
        return;

      case "HEARTBEAT":
        if (state.conn) await this.handleHeartbeat(state.conn, msg.payload as HeartbeatPayload);
        break;

      case "JOB_RESULT":
        if (state.conn) {
          await this.handleJobResult(msg.payload as JobResultPayload, state.conn.deviceId);
        }
        break;

      case "HEALTH_REPORT":
        if (state.conn) {
          await devicesService.updateHealth(
            state.conn.deviceId,
            (msg.payload as HealthReportPayload).health
          );
        }
        break;

      case "VISION_REQUEST":
        if (state.conn) {
          if (!this.visionRateLimit.allow(state.conn.deviceId)) {
            this.send(state.conn.ws, "VISION_RESULT", {
              jobId:   (msg.payload as { jobId?: string }).jobId ?? "unknown",
              error:   "RATE_LIMITED",
              message: "Vision requests rate limited: max 2/second per device",
              elements: [],
              sceneDescription: "",
              detectedState: null,
            });
            break;
          }
          this.handleVisionRequest(
            msg.payload as import("../../shared/protocol/messages").VisionRequestPayload,
            state.conn
          ).catch(err => {
            console.error(`[ws] VISION_REQUEST error for device ${state.conn?.deviceId}:`, err.message);
          });
        }
        break;

      default:
        console.warn("[ws] Unknown message type:", msg.type);
    }
  }

  // ─── ECDSA Auth handlers ───────────────────────────────────────────────────

  private async handleHello(
    ws: WebSocket,
    payload: HelloPayload,
    ip: string,
    state: { conn: DeviceConnection | null; isPending: boolean }
  ): Promise<void> {
    const { imei, publicKeyPem, model, androidVersion, agentVersion } = payload;
    console.log(`[ws] HELLO from IMEI ${imei.slice(0, 6)}…`);

    // Check if device exists by IMEI
    let existing = await authService.findByImei(imei);

    if (existing) {
      // Device exists — check status
      if (existing.status === "maintenance") {
        this.send(ws, "HELLO_REJECT", { code: "BLOCKED", reason: "Device is blocked" });
        ws.close(4003, "Blocked");
        return;
      }

      // Update public key (may have changed after reinstall)
      await authService.updatePublicKey(existing.deviceId, publicKeyPem);

      // Update metadata
      await authService.updateDeviceMeta(existing.deviceId, {
        model: model ?? "",
        androidVersion: androidVersion ?? "",
        agentVersion: agentVersion ?? "",
        ipAddress: ip,
      });

      // APPROVED or ONLINE → issue challenge immediately
      if (existing.status === "approved" || existing.status === "online") {
        const nonce = await authService.issueChallenge(existing.deviceId);
        this.send(ws, "CHALLENGE", { deviceId: existing.deviceId, nonce });
        console.log(`[ws] CHALLENGE issued to IMEI ${imei.slice(0, 6)}… deviceId=${existing.deviceId.slice(0, 8)}`);
        return;
      }

      // PENDING → notify and start poll loop
      if (existing.status === "pending") {
        state.isPending = true;
        this.send(ws, "HELLO_REJECT", {
          code: "AWAITING_APPROVAL",
          reason: "Waiting for admin approval",
          deviceId: existing.deviceId,
        });
        await this.pollForApproval(ws, existing.deviceId, imei, state);
        return;
      }

      // OFFLINE → treat as approved, issue challenge
      if (existing.status === "offline") {
        const nonce = await authService.issueChallenge(existing.deviceId);
        this.send(ws, "CHALLENGE", { deviceId: existing.deviceId, nonce });
        console.log(`[ws] CHALLENGE issued to offline device IMEI ${imei.slice(0, 6)}…`);
        return;
      }
    }

    // New device — register as pending
    const deviceId = await authService.registerPending({
      imei,
      publicKeyPem,
      model: model ?? "Unknown",
      androidVersion: androidVersion ?? "",
      agentVersion: agentVersion ?? "",
      ipAddress: ip,
    });

    console.log(`[ws] Device ${imei.slice(0, 6)}… registered as pending (id=${deviceId.slice(0, 8)})`);
    state.isPending = true;

    this.send(ws, "HELLO_REJECT", {
      code: "AWAITING_APPROVAL",
      reason: "Waiting for admin approval",
      deviceId,
    });

    await this.pollForApproval(ws, deviceId, imei, state);
  }

  private async pollForApproval(
    ws: WebSocket,
    deviceId: string,
    imei: string,
    state: { conn: DeviceConnection | null; isPending: boolean }
  ): Promise<void> {
    const POLL_INTERVAL_MS = 30_000;
    const MAX_POLLS = 60;  // 30 min

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      if (ws.readyState !== WebSocket.OPEN) return;

      const device = await devicesService.getDevice(deviceId);

      if (device?.status === "approved" || device?.status === "online") {
        console.log(`[ws] Device ${imei.slice(0, 6)}… approved after ${i + 1} polls`);
        const nonce = await authService.issueChallenge(deviceId);
        this.send(ws, "CHALLENGE", { deviceId, nonce });
        state.isPending = false;
        return;
      }

      if (device?.status === "maintenance") {
        this.send(ws, "HELLO_REJECT", { code: "BLOCKED", reason: "Device was blocked" });
        ws.close(4003, "Blocked");
        return;
      }

      // Still pending — send keepalive
      this.send(ws, "HELLO_REJECT", {
        code: "AWAITING_APPROVAL",
        reason: "Still waiting for approval…",
        pollCount: i + 1,
      });
    }

    // Timeout
    this.send(ws, "HELLO_REJECT", {
      code: "APPROVAL_TIMEOUT",
      reason: "Approval timeout (30 min). Reconnect to retry.",
    });
    ws.close(4002, "Approval timeout");
  }

  private async handleChallengeResponse(
    ws: WebSocket,
    payload: ChallengeResponsePayload,
    ip: string,
    state: { conn: DeviceConnection | null; isPending: boolean }
  ): Promise<void> {
    const { deviceId, signature } = payload;
    console.log(`[ws] CHALLENGE_RESPONSE for deviceId=${deviceId.slice(0, 8)}…`);

    const valid = await authService.verifyChallengeResponse(deviceId, signature);

    if (!valid) {
      console.warn(`[ws] CHALLENGE_RESPONSE invalid for ${deviceId.slice(0, 8)}`);
      this.send(ws, "HELLO_REJECT", { code: "AUTH_FAILED", reason: "Invalid signature" });
      ws.close(4003, "Auth failed");
      return;
    }

    // Get device IMEI for connection tracking
    const db = getDb();
    const deviceRow = await db.query("SELECT imei FROM devices WHERE id = $1", [deviceId]);
    const imei = (deviceRow.rows[0]?.imei as string) ?? "unknown";

    // Mark online
    await devicesService.markOnline(deviceId, ip);

    // Create connection (pass WG IP from HELLO to detect active tunnel)
    const conn = this.addConnection(ws, deviceId, imei);
    state.conn = conn;
    state.isPending = false;

    // Send HELLO_ACK
    this.send(ws, "HELLO_ACK", { deviceId });
    
    // Verify connection was added
    const verifyInMap = this.connections.has(deviceId);
    console.log(`[ws] Device ${imei.slice(0, 6)}… authenticated. deviceId=${deviceId.slice(0, 8)} inMap=${verifyInMap} mapSize=${this.connections.size}`);

  }

  // ─── Message handlers ──────────────────────────────────────────────────────

  private async handleHeartbeat(
    conn: DeviceConnection,
    payload: HeartbeatPayload
  ): Promise<void> {
    await devicesService.updateHealth(conn.deviceId, payload.health);
    recordDeviceHealth(conn.deviceId, {
      batteryLevel:      payload.health?.batteryLevel as number | undefined,
      memoryAvailableMb: payload.health?.memoryAvailableMb as number | undefined,
    });
  }

  private async handleJobResult(
    payload: JobResultPayload,
    deviceId: string
  ): Promise<void> {
    const wireHandle = (payload as JobResultPayload & { pnqHandle?: unknown }).pnqHandle;
    const handle = decodeDeviceExecutionHandle(wireHandle);
    const accepted = await deviceExecutionArbiter.acceptJobResult({
      deviceId,
      jobId: payload.jobId,
      handle,
      status: payload.status,
      actor: "ws",
      reason: payload.error ?? payload.status,
      metadata: {
        durationMs: payload.durationMs,
        verification: payload.verification ?? null,
        observeSource: "wsServer.handleJobResult",
        handle: wireHandle ?? null,
      },
    });
    if (!accepted.accepted) {
      console.warn(
        `[ws] JOB_RESULT rejected by PNQ ingress: jobId=${payload.jobId.slice(0, 8)} decision=${accepted.decision} reason=${accepted.reason ?? "none"}`
      );
      return;
    }

    await dispatcherService.handleJobResult({
      jobId:      payload.jobId,
      deviceId,
      status:     payload.status,
      output:     payload.output,
      error:      payload.error,
      durationMs: payload.durationMs,
    });

    // Resolve awaiting workflow executor
    const { resolveJobResult } = await import("../modules/workflows/workflow.executor");
    resolveJobResult(payload.jobId, {
      status:       payload.status,
      output:       payload.output,
      error:        payload.error,
      durationMs:   payload.durationMs,
      verification: payload.verification,
    });

    // Resolve awaiting agent orchestrator (screenshots + actions)
    const { resolveScreenshotResult, resolveActionResult } = await import("../modules/agents/orchestrator");
    resolveScreenshotResult(payload.jobId, {
      status: payload.status,
      output: payload.output as Record<string, unknown> | undefined,
    });
    resolveActionResult(payload.jobId, { status: payload.status });

    // Resolve awaiting screen detection cascade (ui_tree_dump, ocr_full, screenshot_for_vlm)
    const { resolveUiTreeResult, resolveOcrResult, resolveScreenDetectionScreenshot } =
      await import("../modules/screen-detection");
    resolveUiTreeResult(payload.jobId, {
      status: payload.status,
      output: payload.output as Record<string, unknown> | undefined,
    });
    resolveOcrResult(payload.jobId, {
      status: payload.status,
      output: payload.output as Record<string, unknown> | undefined,
    });
    resolveScreenDetectionScreenshot(payload.jobId, {
      status: payload.status,
      output: payload.output as Record<string, unknown> | undefined,
    });

    // Server-side audit log
    const db = getDb();
    await db.query(
      `UPDATE command_log
       SET result_payload = $1
       WHERE job_id = $2 AND device_id = $3`,
      [
        JSON.stringify({
          output:       payload.output ?? null,
          error:        payload.error ?? null,
          durationMs:   payload.durationMs,
          verification: payload.verification ?? null,
        }),
        payload.jobId,
        deviceId,
      ]
    );

    // Ban detection (fire-and-forget)
    void (async () => {
      try {
        const jobRow = await db.query(
          `SELECT w.account_id, a.platform
           FROM workflows w
           LEFT JOIN accounts a ON a.id = w.account_id
           WHERE w.device_id = $1 AND w.status = 'running'
           ORDER BY w.started_at DESC NULLS LAST
           LIMIT 1`,
          [deviceId]
        );
        const accountId: string | null = jobRow.rows[0]?.account_id ?? null;
        const platform: string = jobRow.rows[0]?.platform ?? "unknown";
        if (accountId) {
          const { banDetector } = await import("../modules/accounts/ban-detector");
          await banDetector.analyze(accountId, platform, payload as unknown as Record<string, unknown>);
        }
      } catch (e) {
        console.warn("[ws] ban-detector analyze error:", (e as Error).message);
      }
    })();
    void import("../transport/transport")
      .then(({ dispatchQueuedJobsForDevice }) => dispatchQueuedJobsForDevice(deviceId, "ws.job_result_queue_pump"))
      .catch(err => console.error("[device-execution] ws queue pump error:", (err as Error).message));
  }

  // ─── Vision request handler ──────────────────────────────────────────────

  private async handleVisionRequest(
    payload: import("../../shared/protocol/messages").VisionRequestPayload,
    conn: DeviceConnection
  ): Promise<void> {
    const { visionService } = await import("../modules/vision/vision.service");
    try {
      const response = await visionService.handleVisionRequest({
        jobId:            payload.jobId,
        deviceId:         conn.deviceId,
        screenshotBase64: payload.screenshotBase64,
        requestType:      payload.requestType,
        actionType:       payload.actionType,
      });
      this.send(conn.ws, "VISION_RESULT", {
        jobId:            response.jobId,
        elements:         response.elements,
        sceneDescription: response.sceneDescription,
        detectedState:    response.detectedState,
        tokensUsed:       response.tokensUsed,
        latencyMs:        response.latencyMs,
      });
    } catch (err) {
      this.send(conn.ws, "VISION_RESULT", {
        jobId:   payload.jobId,
        error:   "VISION_ERROR",
        message: (err as Error).message,
        elements: [],
        sceneDescription: "",
        detectedState: null,
      });
    }
  }

  // ─── Heartbeat monitor ────────────────────────────────────────────────────

  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const [deviceId, conn] of this.connections) {
      const isSuperseded = !!(conn.supersededAt && (now - conn.supersededAt) > 5_000);
      if (conn.ws.readyState !== WebSocket.OPEN || isSuperseded) {
        console.warn(`[ws] ${isSuperseded ? 'Superseded' : 'Stale'} connection removed for ${conn.deviceId?.slice(0,8)} (readyState=${conn.ws.readyState})`);
        this.connections.delete(deviceId);
        this.visionRateLimit.delete(deviceId);
        devicesConnected?.set(this.connections.size);
        if (conn.deviceId) {
          deviceOfflineEvents?.labels(conn.deviceId, conn.location ?? "unknown")?.inc();
          await alerting.deviceOffline(conn.deviceId, conn.location ?? "unknown");
          await devicesService.markOffline(conn.deviceId);
        }
        continue;
      }
      // Heartbeat monitor normal
      const maxSilence =
        conn.heartbeatInterval === "active"
          ? HEARTBEAT_ACTIVE_MS * OFFLINE_MULTIPLIER
          : HEARTBEAT_IDLE_MS * OFFLINE_MULTIPLIER;

      if (now - conn.lastMessageAt > maxSilence) {
        console.warn(`[ws] Device ${conn.imei.slice(0, 6)}… missed heartbeat — marking offline.`);
        conn.ws.terminate();
        this.connections.delete(deviceId);
        this.visionRateLimit.delete(deviceId);
        devicesConnected?.set(this.connections.size);
        deviceOfflineEvents?.labels(deviceId, conn.location ?? "unknown")?.inc();
        await alerting.deviceOffline(deviceId, conn.location ?? "unknown");
        await devicesService.markOffline(deviceId);
      }
    }
  }

  // ─── Rate limiting ────────────────────────────────────────────────────────

  private checkRateLimit(conn: DeviceConnection): boolean {
    const now = Date.now();
    if (now - conn.windowStart > RATE_LIMIT_WINDOW_MS) {
      conn.msgCount = 1;
      conn.windowStart = now;
      return true;
    }
    conn.msgCount++;
    return conn.msgCount <= RATE_LIMIT_MSGS_PER_S;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private addConnection(ws: WebSocket, deviceId: string, imei: string): DeviceConnection {
    // Check if device already has a connection
    const existing = this.connections.get(deviceId);
    if (existing) {
      const age = Date.now() - existing.connectedAt;
      const lastMsg = Date.now() - existing.lastMessageAt;
      // If existing connection is active (received message in last 60s) and healthy, reject the NEW one
      if (lastMsg < 60_000 && existing.ws.readyState === WebSocket.OPEN) {
        console.warn(`[ws-debug] DUPLICATE: deviceId=${deviceId.slice(0,8)} — existing conn is ${age}ms old, last msg ${lastMsg}ms ago. Rejecting NEW connection.`);
        ws.close(4003, "Already connected");
        return existing;
      }
      // Mark old connection as superseded so heartbeat monitor can clean it up
      existing.supersededAt = Date.now();
      existing.ws.close(1000, "Replaced by newer connection");
      // DON'T delete from map — heartbeat monitor will clean it up after 5s grace period
      console.warn(`[ws-debug] DUPLICATE: deviceId=${deviceId.slice(0,8)} — existing conn is ${age}ms old. Marking superseded.`);
    }

    const conn: DeviceConnection = {
      ws,
      deviceId,
      imei,
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      heartbeatInterval: "idle",
      msgCount: 0,
      windowStart: Date.now(),
    };
    this.connections.set(deviceId, conn);
    devicesConnected?.set(this.connections.size);
    console.log(`[ws-debug] addConnection: id=${deviceId.slice(0,8)} imei=${imei.slice(0,6)} mapSize=${this.connections.size}`);
    return conn;
  }

  private sendToDevice(deviceId: string, type: string, payload: unknown): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    this.send(conn.ws, type, payload);
    return true;
  }

  private send(ws: WebSocket, type: string, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
    }
  }

  async close(): Promise<void> {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.wss?.close();
  }
}

export const wsServer = new WsServer();
