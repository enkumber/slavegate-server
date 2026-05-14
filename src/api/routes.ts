/**
 * api/routes.ts
 * REST API routes — devices, jobs, OTA, audit log.
 *
 * Auth model:
 * - Dashboard: JWT (15min access + 7d refresh) — via /api/auth/login
 * - Device WebSocket: IMEI-based permanent auth (v2) — managed by auth.service.ts
 * - API key: alternative for automated/programmatic access (headless ops)
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { devicesService } from "../modules/devices/devices.service";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import { authService } from "../modules/auth/auth.service";
import { directWsServer } from "../ws/direct-ws.server";

import { sendJobToDevice, isDeviceOnline } from "../transport/transport";
import { workflowService } from "../modules/workflows/workflow.service";
import { startWorkflow } from "../modules/workflows/workflow.executor";
import { hbeService } from "../modules/hbe/hbe.service";
import { accountsService } from "../modules/accounts/accounts.service";
import { dataPipelineService } from "../modules/data-pipeline/data-pipeline.service";
import { visionService } from "../modules/vision/vision.service";
import { modelConfigService, ModelConfigError, type ModelRole } from "../modules/model-config/model-config.service";
import { registry, refreshAccountMetrics, killSwitchActive as killSwitchGauge } from "../modules/observability/metrics";
import { canaryService } from "../modules/canary/canary.service";
import { alerting, AlertType } from "../modules/observability/alerts";
import { getDb } from "../db/client";
import { scalabilityConfig } from "../config/scalability.config";
import { processSkillUpdateJobs, checkAndRollback } from "../modules/skill-updater";
import { runNightlyPipeline } from "../modules/nautilus/pipeline";
import type {
  DispatchJobRequest,
  UpdateDeviceRequest,
} from "../../shared/protocol/api-types";
import type { WorkflowCheckpoint } from "../modules/workflows/types";

const router = Router();

// ─── Global request timeout (hard deadline) ────────────────────────────────────
// Prevents hanging requests from exhausting server resources.
// Any handler that takes too long will get a 504 response.

function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ ok: false, error: "Request timeout" });
    }
  }, scalabilityConfig.requestTimeout);
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));
  next();
}

router.use(requestTimeout);

// ─── Rate limiting (simple in-process sliding window) ─────────────────────────

const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] as string ?? req.ip ?? "anon";
  const now = Date.now();
  const entry = requestCounts.get(key);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (++entry.count > scalabilityConfig.rateLimitPerMinute) {
    res.status(429).json({ ok: false, error: "Rate limit exceeded" });
    return;
  }
  next();
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

/**
 * Accepts either:
 * 1. X-Api-Key header (for programmatic/headless access)
 * 2. Authorization: Bearer <jwt> (for dashboard)
 *
 * API_KEY is validated at startup — guaranteed to exist here.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.API_KEY) return next();

  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const result = verifyJwt(token);
    if (result) {
      (req as any).dashboardUser = result;
      return next();
    }
  }

  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ─── JWT helpers (HS256, simple implementation without external lib) ───────────

// JWT_SECRET must be set — no fallback to API_KEY (which is short/guessable).
// Validated at startup (requiredEnv check in index.ts).
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set — server should have refused to start");
  return secret;
}

function signJwt(payload: Record<string, unknown>, expiresInMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor((Date.now() + expiresInMs) / 1000), iat: Math.floor(Date.now() / 1000) })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expectedSig = crypto
      .createHmac("sha256", getJwtSecret())
      .update(`${header}.${body}`)
      .digest("base64url");
    // base64url strings always same length — timingSafeEqual safe here
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Pagination helper ────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, parseInt(query.page as string ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize as string ?? "50", 10) || 50));
  return { page, pageSize };
}

// ─── Apply middleware ─────────────────────────────────────────────────────────

router.use(rateLimit);

// ─── Dashboard auth ───────────────────────────────────────────────────────────

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "username and password required" });
  }

  // Single admin user — credentials from env.
  // TODO Phase 4: proper user table with bcrypt
  //
  // SHA-256 both sides before timingSafeEqual — ensures equal buffer length.
  // timingSafeEqual throws RangeError if buffers differ in length → 500 instead of 401.
  const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();
  const validUser = crypto.timingSafeEqual(sha256(username), sha256(process.env.DASHBOARD_USERNAME ?? ""));
  const validPass = crypto.timingSafeEqual(sha256(password), sha256(process.env.DASHBOARD_PASSWORD ?? ""));

  if (!validUser || !validPass) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const accessToken  = signJwt({ sub: username, role: "admin" }, 15 * 60 * 1_000);      // 15min
  const refreshToken = signJwt({ sub: username, role: "admin", refresh: true }, 7 * 24 * 60 * 60 * 1_000); // 7d

  res.json({ ok: true, data: { accessToken, refreshToken } });
});

router.post("/auth/refresh", (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) return res.status(400).json({ ok: false, error: "refreshToken required" });

  const payload = verifyJwt(refreshToken);
  if (!payload || !payload.refresh) {
    return res.status(401).json({ ok: false, error: "Invalid refresh token" });
  }

  const newAccess = signJwt({ sub: payload.sub, role: payload.role }, 15 * 60 * 1_000);
  res.json({ ok: true, data: { accessToken: newAccess } });
});

// ─── APK download (public, no auth) ──────────────────────────────────────────
router.get("/apk/download", async (_req, res) => {
  const fs = await import("fs/promises");
  const path = await import("path");
  const apkPath = path.join(process.cwd(), "apk", "phone-network.apk");
  try {
    await fs.access(apkPath);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", 'attachment; filename="phone-network.apk"');
    const { createReadStream } = await import("fs");
    createReadStream(apkPath).pipe(res);
  } catch {
    res.status(404).json({ ok: false, error: "APK not found" });
  }
});

// ─── All routes below require auth ───────────────────────────────────────────

router.use(requireAuth);

// ─── Devices ──────────────────────────────────────────────────────────────────

router.get("/devices", async (req, res) => {
  // ?grouped=true → returns { locationId: Device[] } for dashboard location view
  if (req.query.grouped === "true") {
    res.json({ ok: true, data: await devicesService.listDevicesByLocation() });
    return;
  }
  // ?status=pending → returns only devices awaiting admin approval
  const statusFilter = req.query.status as string | undefined;
  const { page, pageSize } = parsePagination(req.query);
  res.json({ ok: true, data: await devicesService.listDevices(page, pageSize, statusFilter) });
});

router.get("/devices/:id", async (req, res) => {
  const device = await devicesService.getDevice(req.params.id);
  if (!device) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: device });
});

router.get("/devices/:id/connected", (req, res) => {
  const transport = getActiveTransport(req.params.id);
  const connected = transport?.isDeviceOnline(req.params.id) ?? false;
  res.json({ ok: true, data: { connected } });
});

// GET /devices/:id/key — retrieve DirectWs device key (for onboarding/config)
router.get("/devices/:id/key", requireAuth, async (req, res) => {
  const db = getDb();
  const result = await db.query<{ device_key: string | null }>(
    `SELECT device_key FROM devices WHERE id = $1`, [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found" });
  const key = result.rows[0].device_key;
  res.json({ ok: true, data: { deviceKey: key } });
});

// POST /devices/:id/rotate-key — generate new DirectWs key (invalidates old)
router.post("/devices/:id/rotate-key", requireAuth, async (req, res) => {
  const db = getDb();
  const result = await db.query<{ device_key: string }>(
    `UPDATE devices SET device_key = encode(gen_random_bytes(32), 'hex') WHERE id = $1 RETURNING device_key`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: { deviceKey: result.rows[0].device_key } });
});

router.post("/devices/:id/approve", requireAuth, async (req, res) => {
  const { friendlyName } = req.body as { friendlyName?: string };
  const approved = await authService.approveDevice(req.params.id, friendlyName);
  if (!approved) return res.status(404).json({ ok: false, error: "Not found or not pending" });
  // Device will receive HELLO_ACK on its next HELLO (reconnect with backoff).
  // No token push needed — IMEI auth is stateless on server side.
  res.json({ ok: true, data: { approved: true, deviceId: req.params.id } });
});

router.post("/devices/:id/block", requireAuth, async (req, res) => {
  const { reason = "Blocked by admin" } = req.body as { reason?: string };
  const device = await devicesService.getDevice(req.params.id);
  if (!device) return res.status(404).json({ ok: false, error: "Not found" });
  // Set status=revoked — next HELLO will receive HELLO_REJECT[BLOCKED]
  await authService.revokeDevice(req.params.id);
  console.log(`[admin] Device ${req.params.id} blocked (revoked): ${reason}`);
  res.json({ ok: true, data: { blocked: true } });
});

router.patch("/devices/:id", async (req, res) => {
  const device = await devicesService.updateDevice(req.params.id, req.body as UpdateDeviceRequest);
  if (!device) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: device });
});

router.post("/devices/:id/revoke", async (req, res) => {
  const device = await devicesService.getDevice(req.params.id);
  if (!device) return res.status(404).json({ ok: false, error: "Not found" });

  // Sets status='revoked' — device gets HELLO_REJECT[BLOCKED] on next connect
  await authService.revokeDevice(req.params.id);

  res.json({ ok: true, data: { revoked: true } });
});

router.delete("/devices/:id", async (req, res) => {
  try {
    // Revoke first (sets status='revoked'), then hard-delete
    await authService.revokeDevice(req.params.id).catch(() => {});

    const deleted = await devicesService.deleteDevice(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: { deleted: true } });
  } catch (err: any) {
    console.error("[delete-device] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

router.get("/jobs", async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const result = await dispatcherService.listJobs(req.query.deviceId as string | undefined, page, pageSize);
  res.json({ ok: true, data: result });
});

router.get("/jobs/:id", async (req, res) => {
  const job = await dispatcherService.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: job });
});

router.post("/jobs", async (req, res) => {
  const body = req.body as DispatchJobRequest;
  if (!body.deviceId || !body.type || !body.params) {
    return res.status(400).json({ ok: false, error: "deviceId, type, params required" });
  }
  
  // ⛔ BLOCK direct tap jobs — MUST use cascade-tap instead!
  // Reason: VLM coordinates are in screenshot space (e.g., 540x1080), 
  // but tap executes on real screen (1080x2160). Direct tap = wrong coords.
  // cascade-tap handles normalization, ui_tree fallback, and learning.
  // Allow bypass with X-Direct-Tap header for debugging/testing
  if (body.type === "tap" && !req.headers["x-direct-tap"]) {
    return res.status(403).json({ 
      ok: false, 
      error: "Direct tap jobs are BLOCKED. Use POST /api/hydra/cascade-tap instead. " +
             "cascade-tap handles coordinate normalization, ui_tree fallback, and auto-learning.",
      hint: {
        elementBased: 'POST /api/hydra/cascade-tap {"deviceId": "...", "platform": "instagram", "elementName": "nav.search"}',
        textBased: 'POST /api/hydra/cascade-tap {"deviceId": "...", "text": "username_to_tap"}'
      }
    });
  }
  
  const transport = getActiveTransport(body.deviceId);
  if (!transport?.isDeviceOnline(body.deviceId)) {
    return res.status(409).json({ ok: false, error: "Device is not connected" });
  }
  try {
    const { jobId, timeoutMs } = await dispatcherService.dispatch(body);
    await transport.sendJob(body.deviceId, {
      jobId,
      type: body.type,
      params: body.params,
      timeoutMs,
      requiresRoot: body.confirmRoot,
    });
    // Audit log INSERT is done by dispatcherService.dispatch() — do NOT insert here.
    // Double INSERT was a bug: dispatcher writes the row; ws.server.handleJobResult() UPDATEs it.

    res.status(202).json({ ok: true, data: { jobId, status: "queued" } });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.delete("/jobs/:id", async (req, res) => {
  const cancelled = await dispatcherService.cancelJob(req.params.id);
  if (!cancelled) return res.status(404).json({ ok: false, error: "Not found or not cancellable" });
  res.json({ ok: true, data: { cancelled: true } });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

router.get("/audit", async (req, res) => {
  const db = getDb();
  const { page, pageSize } = parsePagination(req.query);
  const offset = (page - 1) * pageSize;
  const deviceId = req.query.deviceId as string | undefined;
  const where = deviceId ? "WHERE device_id = $3" : "";
  const values = deviceId ? [pageSize, offset, deviceId] : [pageSize, offset];
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM command_log ${where} ORDER BY executed_at DESC LIMIT $1 OFFSET $2`, values),
    db.query(`SELECT COUNT(*) FROM command_log ${where}`, deviceId ? [deviceId] : []),
  ]);
  res.json({ ok: true, data: { items: rows.rows, total: parseInt(count.rows[0].count, 10), page, pageSize } });
});

// ─── Workflows ────────────────────────────────────────────────────────────────

router.get("/workflows", requireAuth, async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const deviceId = req.query.deviceId as string | undefined;
  const status   = req.query.status as string | undefined;
  const result = await workflowService.list(deviceId, status as Parameters<typeof workflowService.list>[1], page, pageSize);
  res.json({ ok: true, data: result });
});

router.get("/workflows/:id", requireAuth, async (req, res) => {
  const wf = await workflowService.get(req.params.id);
  if (!wf) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: wf });
});

router.post("/workflows", requireAuth, async (req, res) => {
  const { templateId, deviceId, accountId, variables } = req.body as {
    templateId: string;
    deviceId:   string;
    accountId?: string;
    variables?: Record<string, unknown>;
  };
  if (!templateId || !deviceId) {
    return res.status(400).json({ ok: false, error: "templateId and deviceId required" });
  }
  const template = await workflowService.getTemplate(templateId);
  if (!template) return res.status(404).json({ ok: false, error: `Template ${templateId} not found` });

  // ── Per-device concurrency guard ──────────────────────────────────────────
  // Each device can only have 1 active workflow at a time.
  // This prevents conflicting operations on the same phone.
  const activeForDevice = await workflowService.countActiveByDevice(deviceId);
  if (activeForDevice >= scalabilityConfig.maxWorkflowsPerDevice) {
    return res.status(409).json({
      ok: false,
      error: `Device already has ${activeForDevice} active workflow(s). Max: ${scalabilityConfig.maxWorkflowsPerDevice} per device.`,
      code: "DEVICE_BUSY",
    });
  }

  // ── Global concurrency guard ─────────────────────────────────────────────
  // Soft limit on total concurrent workflows to prevent resource exhaustion.
  const globalRunning = await workflowService.countByStatus('running');
  if (globalRunning >= scalabilityConfig.maxGlobalConcurrentWorkflows) {
    return res.status(429).json({
      ok: false,
      error: `Server at capacity: ${globalRunning}/${scalabilityConfig.maxGlobalConcurrentWorkflows} concurrent workflows. Retry later.`,
      code: "SERVER_BUSY",
    });
  }

  // Init HBE session params
  const accountAgeDays    = (variables?.["accountAgeDays"] as number) ?? 30;
  const simulatedTimezone = (variables?.["timezone"] as string) ?? "Europe/Bucharest";
  const hbeSession        = hbeService.initSession(accountAgeDays, simulatedTimezone);

  // ── Agent version routing (ADR-001 Phase 4) ─────────────────────────────
  // Devices with agent >= 4.0 support edge execution (WORKFLOW_START).
  // Older devices use legacy server-side execution (BullMQ queue + step-by-step).
  if (directWsServer.supportsEdgeExecution(deviceId)) {
    // Edge execution needs the concrete workflow DB id inside WORKFLOW_START.
    // Create the monitoring record first, mark it running, then push template.
    const wf = await workflowService.create({
      templateId,
      deviceId,
      accountId,
      totalSteps: template.steps.length,
      hbeParams: hbeSession as unknown as Record<string, unknown>,
      checkpoint: {
        stepIndex: 0,
        loopStack: [],
        variables: variables ?? {},
        hbeParams: hbeSession as unknown as Record<string, unknown>,
        checkpointAt: new Date().toISOString(),
      },
    });
    await workflowService.markRunning(wf.id);

    // Push template directly to device
    const sent = directWsServer.sendWorkflowStart(
      deviceId,
      template as unknown as Record<string, unknown>,
      variables,
      wf.id,
    );

    if (sent) {

      console.log(`[workflow] ${wf.id} dispatched to device (edge execution, agent=${directWsServer.getAgentVersion(deviceId)})`);
      res.status(202).json({ ok: true, data: { workflowId: wf.id, status: "running", mode: "edge" } });
      return;
    }
    await workflowService.markFailed(wf.id, "Edge dispatch failed");
    // If send fails, fall through to legacy execution
    console.warn(`[workflow] Edge dispatch failed for ${deviceId} — falling back to server execution`);
  }

  // ── Legacy server-side execution ──────────────────────────────────────────

  const checkpoint: WorkflowCheckpoint = {
    stepIndex:    0,
    loopStack:    [],
    variables:    variables ?? {},
    hbeParams:    hbeSession as unknown as Record<string, unknown>,
    checkpointAt: new Date().toISOString(),
  };

  const wf = await workflowService.create({
    templateId,
    deviceId,
    accountId,
    totalSteps:  template.steps.length,
    hbeParams:   hbeSession as unknown as Record<string, unknown>,
    checkpoint,
  });

  // Fire-and-forget: don't block the HTTP response on Redis queue.add().
  // If enqueue fails, the workflow stays in 'queued' status and can be retried.
  startWorkflow(wf.id).catch(err => {
    console.error(`[workflow] Failed to enqueue ${wf.id}: ${err.message}`);
  });
  res.status(202).json({ ok: true, data: { workflowId: wf.id, status: "queued" } });
});

router.post("/workflows/:id/cancel", requireAuth, async (req, res) => {
  const workflow = await workflowService.get(req.params.id);
  const cancelled = await workflowService.cancel(req.params.id);
  if (!cancelled) return res.status(404).json({ ok: false, error: "Not found or not cancellable" });
  const cancelSent = workflow?.deviceId
    ? directWsServer.sendWorkflowCancel(workflow.deviceId, req.params.id)
    : false;
  res.json({ ok: true, data: { cancelled: true, cancelSent } });
});

// ─── Workflow templates ───────────────────────────────────────────────────────

router.get("/workflow-templates", requireAuth, async (_req, res) => {
  const templates = await workflowService.listTemplates();
  res.json({ ok: true, data: templates });
});

router.get("/workflow-templates/:id", requireAuth, async (req, res) => {
  const t = await workflowService.getTemplate(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: t });
});

// ─── Accounts ─────────────────────────────────────────────────────────────────

router.get("/accounts", requireAuth, async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const result = await accountsService.list(
    req.query.deviceId as string | undefined,
    req.query.platform  as string | undefined,
    req.query.status    as Parameters<typeof accountsService.list>[2],
    page, pageSize
  );
  res.json({ ok: true, data: result });
});

router.get("/accounts/stats", requireAuth, async (_req, res) => {
  res.json({ ok: true, data: await accountsService.getStats() });
});

router.get("/accounts/:id", requireAuth, async (req, res) => {
  const account = await accountsService.get(req.params.id);
  if (!account) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: account });
});

router.post("/accounts", requireAuth, async (req, res) => {
  try {
    const account = await accountsService.create(req.body);
    res.status(201).json({ ok: true, data: account });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.patch("/accounts/:id/status", requireAuth, async (req, res) => {
  const { status, notes } = req.body as { status: string; notes?: string };
  try {
    const account = await accountsService.updateStatus(
      req.params.id,
      status as Parameters<typeof accountsService.updateStatus>[1],
      notes
    );
    if (!account) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: account });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

router.delete("/accounts/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await accountsService.delete(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Data Pipeline ────────────────────────────────────────────────────────────

router.get("/extracted-data", requireAuth, async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const result = await dataPipelineService.listExtractedData(
    req.query.platform    as string | undefined,
    req.query.deviceId    as string | undefined,
    req.query.contentType as string | undefined,
    page, pageSize
  );
  res.json({ ok: true, data: result });
});

router.post("/data-pipeline/cleanup", requireAuth, async (_req, res) => {
  const [extracted, commandLog] = await Promise.all([
    dataPipelineService.runRetentionCleanup(),
    dataPipelineService.runCommandLogCleanup(),
  ]);
  res.json({ ok: true, data: { extractedDeleted: extracted.deletedRows, commandLogDeleted: commandLog.deletedRows } });
});

// ─── Server-side model/token config ──────────────────────────────────────────

function handleModelConfigError(res: Response, err: unknown): void {
  const status = err instanceof ModelConfigError ? err.statusCode : 400;
  res.status(status).json({ ok: false, error: (err as Error).message, code: err instanceof ModelConfigError ? err.code : "AI_MODEL_CONFIG_ERROR" });
}

function parseModelRole(role: string): ModelRole {
  if (role !== "decision_llm" && role !== "vision_vlm") throw new ModelConfigError(`Unsupported model role: ${role}`, 404);
  return role;
}

async function listModelConfigsRoute(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await modelConfigService.list() });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

async function getModelConfigRoute(req: Request, res: Response): Promise<void> {
  try {
    const config = await modelConfigService.get(parseModelRole(req.params.role));
    if (!config) {
      res.status(404).json({ ok: false, error: "Model config not found", code: "AI_MODEL_CONFIG_MISSING" });
      return;
    }
    res.json({ ok: true, data: config });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

router.get("/model-configs", requireAuth, listModelConfigsRoute);
router.get("/server/models", requireAuth, listModelConfigsRoute);
router.get("/model-configs/:role", requireAuth, getModelConfigRoute);
router.get("/server/models/:role", requireAuth, getModelConfigRoute);

async function updateModelConfigRoute(req: Request, res: Response): Promise<void> {
  try {
    const role = parseModelRole(req.params.role);
    const config = await modelConfigService.update(role, req.body ?? {});
    if (role === "vision_vlm") visionService.invalidateCache();
    res.json({ ok: true, data: config });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

router.patch("/model-configs/:role", requireAuth, updateModelConfigRoute);
router.put("/model-configs/:role", requireAuth, updateModelConfigRoute);
router.patch("/server/models/:role", requireAuth, updateModelConfigRoute);
router.put("/server/models/:role", requireAuth, updateModelConfigRoute);

async function updateModelCredentialRoute(req: Request, res: Response): Promise<void> {
  try {
    const role = parseModelRole(req.params.role);
    const config = await modelConfigService.updateCredential(role, req.body ?? {});
    if (role === "vision_vlm") visionService.invalidateCache();
    res.json({ ok: true, data: config });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

router.post("/model-configs/:role/credential", requireAuth, updateModelCredentialRoute);
router.post("/server/models/:role/credential", requireAuth, updateModelCredentialRoute);

async function testModelConfigRoute(req: Request, res: Response): Promise<void> {
  try {
    const role = parseModelRole(req.params.role);
    const config = await modelConfigService.test(role);
    if (role === "vision_vlm") visionService.invalidateCache();
    res.json({ ok: true, data: config });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

router.post("/model-configs/:role/test", requireAuth, testModelConfigRoute);
router.post("/server/models/:role/test", requireAuth, testModelConfigRoute);

// Backward-compatible vision config endpoints. Responses map the new vision_vlm
// role to the legacy field names while keeping credentials redacted.
router.get("/vision/config", requireAuth, async (_req, res) => {
  try {
    const config = await modelConfigService.get("vision_vlm");
    if (!config) return res.json({ ok: true, data: null });
    res.json({
      ok: true,
      data: {
        id: "default",
        provider: config.provider,
        model: config.model,
        endpoint: config.endpoint,
        api_key_ref: config.hasCredential ? "redacted" : null,
        apiKeyRef: config.hasCredential ? "redacted" : null,
        enabled: config.enabled,
        version: config.version,
        hasCredential: config.hasCredential,
        last_test_status: config.lastTestStatus,
        last_test_message: config.lastTestMessage,
        last_test_at: config.lastTestAt,
        updated_at: config.updatedAt,
      },
    });
  } catch (err) {
    handleModelConfigError(res, err);
  }
});

router.patch("/vision/config", requireAuth, async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const config = await modelConfigService.update("vision_vlm", {
      provider: body.provider as string | undefined,
      model: body.model as string | undefined,
      endpoint: body.endpoint as string | null | undefined,
      credentialRef: (body.credentialRef ?? body.apiKeyRef) as string | null | undefined,
      enabled: body.enabled as boolean | undefined,
    });
    visionService.invalidateCache();
    res.json({ ok: true, data: config });
  } catch (err) {
    handleModelConfigError(res, err);
  }
});

// ─── Metrics (Prometheus scrape) ─────────────────────────────────────────────
// Auth: optional Bearer token via METRICS_AUTH_TOKEN env var.
// If not set: restrict at network level (docker-compose internal port only).
// Production: set METRICS_AUTH_TOKEN and expose :21211/metrics on internal network.

router.get("/metrics", async (req, res) => {
  const token = process.env.METRICS_AUTH_TOKEN;
  if (token) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
  }
  if (!registry) {
    res.status(503).send("# prom-client not installed\n");
    return;
  }
  await refreshAccountMetrics(getDb());
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

// ─── Kill switch — persistent în DB (B3 fix) ────────────────────────────────
// In-memory cache backed by system_config table — survives restarts.

let _killSwitchCache: boolean | null = null;  // null = not yet loaded from DB

async function loadKillSwitchFromDb(): Promise<boolean> {
  try {
    const db = getDb();
    const row = await db.query(
      "SELECT value FROM system_config WHERE key = 'kill_switch_active' LIMIT 1"
    );
    return row.rows[0]?.value === true || row.rows[0]?.value === "true";
  } catch { return false; }
}

async function persistKillSwitch(
  active:      boolean,
  initiatedBy: string,
  scope        = "fleet",
  reason       = "",
  deviceId?:   string
): Promise<void> {
  const db       = getDb();
  const scopeVal = scope === "device" && deviceId ? `device:${deviceId}` : scope;

  // IMPORTANT: Only write fleet-wide system_config flag for fleet-scoped operations.
  // Device-scoped kill switch must NOT set system_config.kill_switch_active = true —
  // if it did, a server restart would boot with fleet-wide kill switch active.
  if (scope !== "device") {
    await db.query(
      `INSERT INTO system_config (key, value) VALUES ('kill_switch_active', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [active]
    );
  }

  // Always log the action (includes device-scoped operations for audit trail)
  await db.query(
    "INSERT INTO kill_switch_log (activated, scope, initiated_by, reason) VALUES ($1, $2, $3, $4)",
    [active, scopeVal, initiatedBy, reason]
  );
}

/** Read kill switch state — loads from DB on first call (cache thereafter) */
export async function isKillSwitchActive(): Promise<boolean> {
  if (_killSwitchCache === null) {
    _killSwitchCache = await loadKillSwitchFromDb();
  }
  return _killSwitchCache;
}

/**
 * Sync version — returns cached value (may be null before first load).
 * Safe to use in sync contexts AFTER server startup has called isKillSwitchActive().
 */
export function isKillSwitchActiveSync(): boolean {
  return _killSwitchCache === true;
}

router.post("/kill-switch", requireAuth, async (req, res) => {
  const {
    activate,
    initiatedBy = "admin",
    reason      = "",
    scope       = "fleet",    // "fleet" | "device"
    deviceId,                 // required if scope="device"
  } = req.body as { activate: boolean; initiatedBy?: string; reason?: string; scope?: string; deviceId?: string };

  // BUG FIX: previous logic `activate && scope === "fleet"` never updated cache on deactivate
  // because `false && anything` = false → ternary returned old cache value unchanged.
  // Fleet jobs remained blocked after deactivating — server restart was required to resume.
  if (scope === "fleet") {
    _killSwitchCache = activate;
    killSwitchGauge?.set(activate ? 1 : 0);
  }

  await persistKillSwitch(activate, String(initiatedBy), scope, reason, deviceId);

  if (activate) {
    const reason_ = reason || "Kill switch activated";
    if (scope === "device" && deviceId) {
      // Per-device kill switch: DirectWs only
      console.warn(`[kill-switch] 🛑 DEVICE ${deviceId} by ${initiatedBy}`);
    } else {
      // Fleet-wide: cancel DB workflows
      const db = getDb();
      await db.query(
        "UPDATE workflows SET status = 'failed', error = $1 WHERE status IN ('running', 'queued')",
        [reason_]
      );
      await alerting.killSwitch(String(initiatedBy));
      console.error(`[kill-switch] 🛑 FLEET by ${initiatedBy}: ${reason_}`);
    }
  } else {
    console.log(`[kill-switch] Deactivated by ${initiatedBy} (scope=${scope})`);
  }
  res.json({ ok: true, data: { killSwitchActive: activate, scope, deviceId } });
});

// Legacy WsServer ref — kept for backward compat
let _wsServerRef: import("../ws/ws.server").WsServer | null = null;
function getWsServer() { return _wsServerRef; }
export function setWsServerRef(srv: import("../ws/ws.server").WsServer) { _wsServerRef = srv; }

/**
 * getActiveTransport() — returns the unified transport interface.
 * Uses transport.ts abstraction layer.
 */
type TransportHandle = {
  isDeviceOnline: (id: string) => boolean;
  sendJob: (id: string, payload: import("../../shared/protocol/messages").JobDispatchPayload) => boolean;
};

function getActiveTransport(_deviceId?: string): TransportHandle {
  return {
    isDeviceOnline: (id) => isDeviceOnline(id),
    sendJob:        (id, p) => sendJobToDevice(id, p),
  };
}

router.get("/kill-switch", requireAuth, async (_req, res) => {
  const active = await isKillSwitchActive();
  res.json({ ok: true, data: { killSwitchActive: active } });
});

// ─── Alertmanager webhook (B3) ────────────────────────────────────────────────
// Alertmanager POSTs here; we forward to Telegram via alerting service.
// No auth (internal network only — not exposed externally).

router.post("/alerts/webhook", async (req, res) => {
  try {
    const body = req.body as {
      alerts?: Array<{ status: string; labels: Record<string, string>; annotations: Record<string, string> }>;
      commonLabels?: Record<string, string>;
    };
    const alerts = body.alerts ?? [];
    for (const alert of alerts) {
      const name     = alert.labels.alertname ?? "UnknownAlert";
      const severity = alert.labels.severity ?? "info";
      const summary  = alert.annotations.summary ?? name;
      const status   = alert.status === "resolved" ? "✅ RESOLVED" : (severity === "critical" ? "🔴 CRITICAL" : "⚠️ WARNING");
      // Forward to Telegram via alerting.send() bypass (direct Telegram call)
      const text = `${status} *${name}*\n${summary}\n${alert.annotations.description ?? ""}`.trim();
      // Use internal sendTelegram directly — avoids AlertType enum mismatch
      const botToken = process.env.ALERT_TELEGRAM_BOT_TOKEN;
      const chatId   = process.env.ALERT_TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
          signal:  AbortSignal.timeout(5_000),
        }).catch(e => console.warn("[webhook] Telegram send failed:", e.message));
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[webhook] Alertmanager webhook error:", e);
    res.status(500).json({ ok: false });
  }
});

// ─── Canary rollouts ──────────────────────────────────────────────────────────

router.get("/canary/rollouts", requireAuth, async (req, res) => {
  const status = req.query.status as Parameters<typeof canaryService.listRollouts>[0];
  res.json({ ok: true, data: await canaryService.listRollouts(status) });
});

router.get("/canary/rollouts/:id", requireAuth, async (req, res) => {
  const rollout = await canaryService.getRollout(req.params.id);
  if (!rollout) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: rollout });
});

router.post("/canary/rollouts/:id/promote", requireAuth, async (req, res) => {
  const { initiatedBy } = req.body as { initiatedBy?: string };
  const result = await canaryService.manualPromote(req.params.id, initiatedBy ?? "admin");
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, data: { promoted: true } });
});

router.post("/canary/rollouts/:id/rollback", requireAuth, async (req, res) => {
  const { reason, initiatedBy } = req.body as { reason?: string; initiatedBy?: string };
  const result = await canaryService.manualRollback(req.params.id, reason, initiatedBy ?? "admin");
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, data: { rolledBack: true } });
});

router.get("/canary/device", requireAuth, async (_req, res) => {
  const deviceId = await canaryService.getCanaryDeviceId();
  res.json({ ok: true, data: { deviceId } });
});

router.patch("/canary/device/:id", requireAuth, async (req, res) => {
  const { isCanary } = req.body as { isCanary: boolean };
  if (typeof isCanary !== "boolean") {
    return res.status(400).json({ ok: false, error: "isCanary (boolean) required" });
  }
  const ok = await canaryService.setCanaryDevice(req.params.id, isCanary);
  if (!ok) return res.status(404).json({ ok: false, error: "Device not found" });
  res.json({ ok: true, data: { deviceId: req.params.id, isCanary } });
});

// ─── OTA Upload ────────────────────────────────────────────────────────────────
import multer from "multer";
import nodeFs from "fs/promises";
import nodePath from "path";

const APK_DIR = nodePath.join(process.cwd(), "apk");

const apkStorage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: any) => {
    const fsSync = require("fs");
    fsSync.mkdirSync(APK_DIR, { recursive: true });
    cb(null, APK_DIR);
  },
  filename: (_req: any, file: any, cb: any) => {
    cb(null, file.originalname || "phone-network.apk");
  },
});

const apkUpload = multer({
  storage: apkStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.originalname.endsWith(".apk")) {
      cb(null, true);
    } else {
      cb(new Error("Only .apk files allowed"));
    }
  },
});

/**
 * POST /api/ota/upload
 * Upload APK to server. Sets it as the active APK for OTA push.
 * Body: multipart/form-data with "apk" field
 */
router.post("/ota/upload", requireAuth, (req, res, next) => {
    apkUpload.single("apk")(req, res, (err) => {
      if (err) {
        console.error("[ota/upload] multer error:", err);
        return res.status(500).json({ ok: false, error: err.message });
      }
      next();
    });
  }, async (req, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No APK file provided. Use 'apk' field." });
  }

  const uploaded = file.path;
  const apkBuffer = await nodeFs.readFile(uploaded);
  const apkSha256 = crypto.createHash("sha256").update(apkBuffer).digest("hex");
  const apkSize = apkBuffer.length;

  // Also set as the default APK (phone-network.apk) for OTA push
  const defaultPath = nodePath.join(APK_DIR, "phone-network.apk");
  if (uploaded !== defaultPath) {
    await nodeFs.copyFile(uploaded, defaultPath);
  }

  console.log(`[ota] APK uploaded: ${file.originalname} (${(apkSize / 1024 / 1024).toFixed(1)}MB) sha256=${apkSha256.slice(0, 12)}…`);

  res.json({
    ok: true,
    data: {
      filename: file.originalname,
      size: apkSize,
      sha256: apkSha256,
      setAsDefault: true,
    },
  });
});

// ─── OTA Push ─────────────────────────────────────────────────────────────────

router.post("/ota/push", requireAuth, async (req, res) => {
  const fs = await import("fs/promises");
  const crypto = await import("crypto");
  const path = await import("path");

  const apkPath = path.join(process.cwd(), "apk", "phone-network.apk");

  // Check APK exists
  try {
    await fs.access(apkPath);
  } catch {
    return res.status(500).json({ ok: false, error: "APK not found on server. Upload it to /app/apk/phone-network.apk" });
  }

  // Read APK and calculate SHA256
  const apkBuffer = await fs.readFile(apkPath);
  const apkSha256 = crypto.createHash("sha256").update(apkBuffer).digest("hex");

  // Get version from request or default
  const { version = "1.0.0", versionCode = 1, mandatory = false, deviceIds } = req.body as {
    version?: string;
    versionCode?: number;
    mandatory?: boolean;
    deviceIds?: string[];
  };

  // Send OTA_UPDATE command via DirectWs to online devices
  const { directWsServer } = await import("../ws/direct-ws.server");
  const onlineDevices = directWsServer.getOnlineDevices();
  const targets = deviceIds 
    ? onlineDevices.filter(d => deviceIds.includes(d.deviceId))
    : onlineDevices;
  
  let sentTo = 0;
  // Force correct external URL for OTA — Docker internal port (21211) is not accessible to devices
  const baseUrl = 'http://enkzoned.go.ro:3000';
  for (const device of targets) {
    try {
      directWsServer.sendToDevice(device.deviceId, {
        type: "OTA_UPDATE",
        version,
        versionCode,
        apkUrl: `${baseUrl}/api/apk/download`,
        apkSha256,
        mandatory,
      });
      sentTo++;
    } catch {}
  }
  console.log(`[ota] Push sent to ${sentTo}/${targets.length} devices`);

  res.json({
    ok: true,
    data: {
      count: sentTo,
      version,
      versionCode,
      apkSha256,
      mandatory,
    },
  });
});

// ─── Health check (no auth) ─────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true, data: { status: "healthy", ts: new Date().toISOString() } });
});

// ─── Skill Updater (cron trigger) ─────────────────────────────────────────────

router.post("/skill-updater/run", requireAuth, async (_req, res) => {
  console.log("[skill-updater] Manual/cron trigger received");
  try {
    const startTime = Date.now();
    await processSkillUpdateJobs();
    await checkAndRollback();
    const durationMs = Date.now() - startTime;
    console.log(`[skill-updater] Run completed in ${durationMs}ms`);
    res.json({ ok: true, data: { durationMs, triggeredAt: new Date().toISOString() } });
  } catch (err) {
    console.error("[skill-updater] Run error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/skill-updater/status", requireAuth, async (_req, res) => {
  try {
    const db = getDb();
    
    // Get pending jobs count
    const pendingResult = await db.query(`
      SELECT COUNT(*) as count FROM skill_update_jobs WHERE status = 'pending'
    `);
    const pendingJobs = parseInt(pendingResult.rows[0]?.count) || 0;
    
    // Get today's patch count
    const todayPatchesResult = await db.query(`
      SELECT COUNT(*) as count FROM skill_patches WHERE applied_at > CURRENT_DATE
    `);
    const todayPatches = parseInt(todayPatchesResult.rows[0]?.count) || 0;
    
    // Get last 5 completed jobs
    const recentJobsResult = await db.query(`
      SELECT id, app, status, result, created_at, completed_at
      FROM skill_update_jobs
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 5
    `);
    
    // Get last 5 patches
    const recentPatchesResult = await db.query(`
      SELECT id, app, element, old_selector, new_selector, confidence, applied_at, rolled_back_at
      FROM skill_patches
      ORDER BY applied_at DESC
      LIMIT 5
    `);
    
    res.json({
      ok: true,
      data: {
        pendingJobs,
        todayPatches,
        recentJobs: recentJobsResult.rows,
        recentPatches: recentPatchesResult.rows,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[skill-updater] Status error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Nautilus Pipeline (nightly marketing automation) ─────────────────────────

router.post("/nautilus/run", requireAuth, async (req, res) => {
  console.log("[nautilus] Pipeline trigger received");
  try {
    const config = {
      skip_ba: req.body?.skip_ba ?? false,
      skip_marketer: req.body?.skip_marketer ?? false,
      skip_siren: req.body?.skip_siren ?? false,
      skip_tactician: req.body?.skip_tactician ?? false,
      stop_on_error: req.body?.stop_on_error ?? false,
    };
    
    const result = await runNightlyPipeline(config);
    console.log(`[nautilus] Pipeline completed: ${result.success ? 'SUCCESS' : 'FAILED'} in ${result.duration_ms}ms`);
    
    res.json({ 
      ok: result.success, 
      data: {
        summary: result.summary,
        duration_ms: result.duration_ms,
        phases: {
          ba: result.phases.ba ? { success: result.phases.ba.success, summary: result.phases.ba.summary } : null,
          marketer: result.phases.marketer ? { success: result.phases.marketer.success, summary: result.phases.marketer.summary } : null,
          siren: result.phases.siren ? { success: result.phases.siren.success, summary: result.phases.siren.summary } : null,
          tactician: result.phases.tactician ? { success: result.phases.tactician.success, summary: result.phases.tactician.summary } : null,
        },
        errors: result.errors,
        started_at: result.started_at,
        completed_at: result.completed_at,
      }
    });
  } catch (err) {
    console.error("[nautilus] Pipeline error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/nautilus/status", requireAuth, async (_req, res) => {
  try {
    const db = getDb();
    
    // Safe query that works even if marketing tables don't exist
    let accounts = { total: 0, active: 0 };
    let prospects = { total: 0, followers: 0, following: 0 };
    let escalations = 0;
    
    try {
      const accountsResult = await db.query(`
        SELECT COUNT(*) as total, 
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
        FROM marketing_accounts
      `);
      accounts = {
        total: parseInt(accountsResult.rows[0]?.total) || 0,
        active: parseInt(accountsResult.rows[0]?.active) || 0,
      };
    } catch { /* table may not exist */ }
    
    try {
      const prospectsResult = await db.query(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN type = 'follower' THEN 1 ELSE 0 END) as followers,
               SUM(CASE WHEN type = 'following' THEN 1 ELSE 0 END) as following
        FROM marketing_prospects WHERE created_at > NOW() - INTERVAL '7 days'
      `);
      prospects = {
        total: parseInt(prospectsResult.rows[0]?.total) || 0,
        followers: parseInt(prospectsResult.rows[0]?.followers) || 0,
        following: parseInt(prospectsResult.rows[0]?.following) || 0,
      };
    } catch { /* table may not exist */ }
    
    try {
      const escalationsResult = await db.query(`
        SELECT COUNT(*) as pending FROM marketer_escalations WHERE status = 'pending'
      `);
      escalations = parseInt(escalationsResult.rows[0]?.pending) || 0;
    } catch { /* table may not exist */ }
    
    res.json({
      ok: true,
      data: {
        accounts,
        prospects_7d: prospects,
        escalations_pending: escalations,
        checkedAt: new Date().toISOString(),
        note: accounts.total === 0 ? "Marketing tables may not be initialized" : undefined,
      },
    });
  } catch (err) {
    console.error("[nautilus] Status error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Research Jobs API ────────────────────────────────────────────────────────
// Used by Kraken (polling) and Hydra (reporting results)

router.get("/research-jobs", requireAuth, async (req, res) => {
  try {
    const { researchService } = await import("../modules/research/research.service");
    if (req.query.status === "pending") {
      const limit = parseInt(req.query.limit as string) || 50;
      const jobs = await researchService.getPendingJobs(limit);
      return res.json({ ok: true, data: jobs });
    }
    const stats = await researchService.getStats();
    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/research-jobs/:id/schedule", requireAuth, async (req, res) => {
  try {
    const { researchService } = await import("../modules/research/research.service");
    const { deviceId } = req.body as { deviceId: string };
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
    await researchService.scheduleJob(req.params.id, deviceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/research-jobs/:id/start", requireAuth, async (req, res) => {
  try {
    const { researchService } = await import("../modules/research/research.service");
    await researchService.startJob(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/research-jobs/:id/complete", requireAuth, async (req, res) => {
  try {
    const { researchService } = await import("../modules/research/research.service");
    const { output } = req.body as { output: Record<string, unknown> };
    if (!output || typeof output !== "object") {
      return res.status(400).json({ ok: false, error: "output object required" });
    }
    await researchService.completeJob(req.params.id, output);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/research-jobs/:id/fail", requireAuth, async (req, res) => {
  try {
    const { researchService } = await import("../modules/research/research.service");
    const { error } = req.body as { error: string };
    if (!error) return res.status(400).json({ ok: false, error: "error message required" });
    await researchService.failJob(req.params.id, error);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Agent Orchestrator ───────────────────────────────────────────────────────

router.post("/orchestrator/execute", requireAuth, async (req, res) => {
  const { task, deviceId, appContext } = req.body as {
    task?: string;
    deviceId?: string;
    appContext?: string;
  };

  if (!task || !deviceId) {
    return res.status(400).json({ ok: false, error: "task and deviceId required" });
  }

  if (!isDeviceOnline(deviceId)) {
    return res.status(409).json({ ok: false, error: "Device is not connected" });
  }

  try {
    const { agentOrchestrator } = await import("../modules/agents/orchestrator");
    const result = await agentOrchestrator.executeTask(task, deviceId, appContext || "instagram");
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error("[orchestrator] Execute error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Task Runner ──────────────────────────────────────────────────────────────

router.get("/task-runner/status", requireAuth, async (_req, res) => {
  try {
    const { getTaskRunnerStatus } = await import("../modules/task-runner");
    const status = getTaskRunnerStatus();
    res.json({ ok: true, data: status });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/task-runner/start", requireAuth, async (req, res) => {
  try {
    const { startTaskRunner } = await import("../modules/task-runner");
    const config = req.body as Partial<{ pollIntervalMs: number; minGapBetweenTasksMs: number; batchSize: number }>;
    startTaskRunner(config);
    res.json({ ok: true, message: "Task runner started" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/task-runner/stop", requireAuth, async (_req, res) => {
  try {
    const { stopTaskRunner } = await import("../modules/task-runner");
    stopTaskRunner();
    res.json({ ok: true, message: "Task runner stopped" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/task-runner/execute/:taskId", requireAuth, async (req, res) => {
  try {
    const { executeTaskNow } = await import("../modules/task-runner");
    const result = await executeTaskNow(req.params.taskId);
    if ("error" in result) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/task-runner/retry-failed", requireAuth, async (_req, res) => {
  try {
    const { retryFailedTasks } = await import("../modules/task-runner");
    const result = await retryFailedTasks();
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/task-runner/failed-stats", requireAuth, async (_req, res) => {
  try {
    const { getFailedTasksStats } = await import("../modules/task-runner");
    const stats = await getFailedTasksStats();
    res.json({ ok: true, data: stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Tasks Management ─────────────────────────────────────────────────────────

router.post("/tasks", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { account_id, device_id, routine, params, scheduled_time } = req.body;
    
    if (!account_id || !device_id || !routine) {
      return res.status(400).json({ ok: false, error: "Missing required fields: account_id, device_id, routine" });
    }
    
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO tasks (id, account_id, device_id, routine, params, scheduled_time, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', NOW())`,
      [id, account_id, device_id, routine, JSON.stringify(params || {}), scheduled_time || new Date().toISOString()]
    );
    
    res.json({ ok: true, data: { id } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/tasks", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    
    let query = `
      SELECT t.*, a.username as account_username, d.friendly_name as device_name
      FROM tasks t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN devices d ON d.id = t.device_id
    `;
    const params: (string | number)[] = [];
    
    if (status) {
      query += ` WHERE t.status = $1`;
      params.push(status);
    }
    
    query += ` ORDER BY t.scheduled_time DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await db.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.patch("/tasks/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body as { status?: string };
    
    if (status && !["queued", "paused", "cancelled"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }
    
    if (status) {
      await db.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [status, req.params.id]);
    }
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Debug: WebSocket connections ─────────────────────────────────────────────

router.get("/debug/connections", requireAuth, (_req, res) => {
  // DirectWs only - show connected devices
  const onlineDevices = directWsServer.getConnectedDeviceIds();
  const list = onlineDevices.map((id) => ({
    deviceId: id.slice(0, 8),
    online: true,
    agentVersion: directWsServer.getAgentVersion(id),
    edgeCapable: directWsServer.supportsEdgeExecution(id),
  }));
  res.json({ ok: true, data: { count: list.length, connections: list } });
});

// ─── Scalability & Health ─────────────────────────────────────────────────────

router.get("/scalability/status", requireAuth, async (_req, res) => {
  try {
    const { getPoolStats } = await import("../db/client");
    const poolStats = getPoolStats();
    const wfCounts = await workflowService.getActiveCounts();
    const wsConnections = directWsServer.getConnectionCount();
    const wsOnline = directWsServer.getConnectedDeviceIds().length;

    // Edge execution stats (ADR-001)
    const edgeDevices = directWsServer.getConnectedDeviceIds()
      .filter(id => directWsServer.supportsEdgeExecution(id)).length;
    const legacyDevices = wsOnline - edgeDevices;

    res.json({
      ok: true,
      data: {
        config: {
          maxWorkflowsPerDevice: scalabilityConfig.maxWorkflowsPerDevice,
          maxGlobalConcurrentWorkflows: scalabilityConfig.maxGlobalConcurrentWorkflows,
          workerConcurrency: scalabilityConfig.workerConcurrency,
          dbPoolMax: scalabilityConfig.dbPoolMax,
          maxWsConnections: scalabilityConfig.maxWsConnections,
        },
        current: {
          workflows: wfCounts,
          dbPool: poolStats,
          webSocket: {
            totalConnections: wsConnections,
            onlineDevices: wsOnline,
            maxConnections: scalabilityConfig.maxWsConnections,
            utilization: `${Math.round((wsConnections / scalabilityConfig.maxWsConnections) * 100)}%`,
          },
          edgeExecution: {
            capableDevices: edgeDevices,
            legacyDevices,
            activeMode: edgeDevices > 0 ? "edge" : "legacy",
          },
        },
        capacity: {
          workflowsAvailable: Math.max(0, scalabilityConfig.maxGlobalConcurrentWorkflows - wfCounts.running),
          dbPoolAvailable: poolStats.maxCount - poolStats.totalCount,
          wsSlotsAvailable: scalabilityConfig.maxWsConnections - wsConnections,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Edge Workflow: Push template to device (ADR-001) ────────────────────────

router.post("/edge/push-template", requireAuth, async (req, res) => {
  const { deviceId, templateId, variables } = req.body as {
    deviceId?: string;
    templateId?: string;
    variables?: Record<string, unknown>;
  };

  if (!deviceId || !templateId) {
    res.status(400).json({ ok: false, error: "Missing deviceId or templateId" });
    return;
  }

  // Check device is online
  if (!directWsServer.isDeviceOnline(deviceId)) {
    res.status(409).json({ ok: false, error: "Device offline" });
    return;
  }

  try {
    // Load template from DB
    const template = await workflowService.getTemplate(templateId);
    if (!template) {
      res.status(404).json({ ok: false, error: `Template ${templateId} not found` });
      return;
    }

    // Push to device via WebSocket
    const sent = directWsServer.sendWorkflowStart(deviceId, template as unknown as Record<string, unknown>, variables);
    if (!sent) {
      res.status(503).json({ ok: false, error: "Failed to send template to device" });
      return;
    }

    console.log(`[api] Edge template push: device=${deviceId.slice(0, 8)} template=${templateId}`);
    res.json({ ok: true, data: { deviceId, templateId, sent: true } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Edge Workflow: List templates for device ─────────────────────────────────

router.get("/edge/templates", requireAuth, async (_req, res) => {
  try {
    const templates = await workflowService.listTemplates();
    res.json({ ok: true, data: templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Edge Workflow: Broadcast template to all online devices ───────────────────

router.post("/edge/broadcast-template", requireAuth, async (req, res) => {
  const { templateId } = req.body as { templateId?: string };
  if (!templateId) {
    res.status(400).json({ ok: false, error: "Missing templateId" });
    return;
  }

  try {
    const template = await workflowService.getTemplate(templateId);
    if (!template) {
      res.status(404).json({ ok: false, error: `Template ${templateId} not found` });
      return;
    }

    const sent = directWsServer.broadcastTemplate(template as unknown as Record<string, unknown>);
    res.json({ ok: true, data: { templateId, devicesReached: sent } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Edge Workflow: Status overview (ADR-001 Phase 5) ─────────────────────────

router.get("/edge/status", requireAuth, async (_req, res) => {
  try {
    const onlineDevices = directWsServer.getConnectedDeviceIds();
    const edgeDevices = onlineDevices.filter(id => directWsServer.supportsEdgeExecution(id));
    const legacyDevices = onlineDevices.filter(id => !directWsServer.supportsEdgeExecution(id));

    const deviceInfo = onlineDevices.map(id => ({
      deviceId: id.slice(0, 8),
      agentVersion: directWsServer.getAgentVersion(id),
      edgeCapable: directWsServer.supportsEdgeExecution(id),
    }));

    res.json({
      ok: true,
      data: {
        totalOnline: onlineDevices.length,
        edgeCapable: edgeDevices.length,
        legacyOnly: legacyDevices.length,
        executionMode: edgeDevices.length > 0 ? "edge" : "legacy",
        devices: deviceInfo,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
