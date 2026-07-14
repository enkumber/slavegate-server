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
import { requireAdminAuth, requireApiGateAuth, signJwt, verifyJwt } from "./auth.middleware";
import { devicesService } from "../modules/devices/devices.service";
import { dispatcherService } from "../modules/dispatcher/dispatcher.service";
import { authService } from "../modules/auth/auth.service";
import { directWsServer } from "../ws/direct-ws.server";

import { sendJobToDevice, isDeviceOnline } from "../transport/transport";
import { loadMap } from "../modules/app-mapping/recorder.service";
import { validateAppMapQuality, type AppMap, type AppMapQualityReport } from "../modules/app-mapping/schema";
import { workflowService, type GeneratedWorkflowPlanCacheRecord } from "../modules/workflows/workflow.service";
import {
  buildGeneratedWorkflowAppMapHints,
  buildGeneratedWorkflowPrompt,
  computeGeneratedWorkflowRequestKey,
  resolveGeneratedWorkflowScreens,
} from "../modules/workflows/generated-workflow-prompt";
import {
  compileGeneratedWorkflowTemplate,
  assessGeneratedWorkflowCacheInvalidation,
  buildGeneratedWorkflowAppMapCacheMetadata,
  getGeneratedWorkflowContract,
  generatedWorkflowPlanUsesAppMap,
  summarizeGeneratedWorkflowTemplate,
  validateGeneratedWorkflowTemplate,
  withGeneratedWorkflowAppMapCacheMetadata,
  type GeneratedWorkflowCompiledPlan,
  type GeneratedWorkflowCacheInvalidation,
} from "../modules/workflows/workflow-validator";
import {
  dispatchGeneratedWorkflowTemplate,
  resolveGeneratedWorkflowDeviceId,
  type GeneratedWorkflowControlPlaneContext,
} from "../modules/workflows/generated-workflow-execution.service";
import { accountsService } from "../modules/accounts/accounts.service";
import { dataPipelineService } from "../modules/data-pipeline/data-pipeline.service";
import { visionService } from "../modules/vision/vision.service";
import { modelConfigService, ModelConfigError, type ModelRole } from "../modules/model-config/model-config.service";
import {
  generatedWorkflowCacheLookups,
  generatedWorkflowExecutions,
  generatedWorkflowLlmAvoided,
  registry,
  refreshAccountMetrics,
  killSwitchActive as killSwitchGauge,
} from "../modules/observability/metrics";
import { canaryService } from "../modules/canary/canary.service";
import { alerting, AlertType } from "../modules/observability/alerts";
import { taskRunnerService } from "../modules/task-runner";
import { getDb } from "../db/client";
import { scalabilityConfig } from "../config/scalability.config";
import { processSkillUpdateJobs, checkAndRollback } from "../modules/skill-updater";
import { runNightlyPipeline } from "../modules/nautilus/pipeline";
import type {
  DispatchJobRequest,
  UpdateDeviceRequest,
} from "../../shared/protocol/api-types";
import type { WorkflowTemplate } from "../modules/workflows/types";
import {
  assertHumanWorkflowMeaningful,
  computeHumanWorkflowRequestKey,
  humanWorkflowCompilerService,
  isAccountlessHumanWorkflowIntent,
  type HumanWorkflowCompileReady,
  type HumanWorkflowSafetyClass,
  type HumanWorkflowTarget,
} from "../modules/human-workflow/human-workflow-compiler.service";
import type { HumanWorkflowCompileJobRecord } from "../modules/human-workflow/compile-job.service";
import { agentConfig } from "../config/agents.config";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_WORKFLOW_KEY_RE = /^[a-f0-9]{24}$/;
const ASYNC_COMPILE_RETRY_AFTER_MS = 2_000;

function plannerModelMetadata(): { modelRole: "planner"; provider: string; model: string } {
  const configured = process.env.AGENT_PLANNER_MODEL || agentConfig.planner.model;
  const separator = configured.indexOf("/");
  if (separator === -1) return { modelRole: "planner", provider: "unknown", model: configured };
  return {
    modelRole: "planner",
    provider: configured.slice(0, separator),
    model: configured.slice(separator + 1),
  };
}

function intentPreview(intent: string): string {
  return intent
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:\+?\d[\d .()/-]{7,}\d)\b/g, "[redacted-phone]")
    .replace(/\b(?:token|api[_ -]?key|secret|password|parola)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted-token]")
    .slice(0, 160);
}

function compileDurationMs(job: HumanWorkflowCompileJobRecord): number | null {
  if (!job.llmStartedAt || !job.llmCompletedAt) return null;
  const started = new Date(job.llmStartedAt).getTime();
  const completed = new Date(job.llmCompletedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

function cachedHumanWorkflowSafetyClass(cached: Record<string, unknown>): HumanWorkflowSafetyClass {
  const workflow = cached.workflow as { safetyClass?: unknown } | undefined;
  const compiledPlan = cached.compiled_plan as { metadata?: { safetyClass?: unknown } } | undefined;
  const camelCompiledPlan = cached.compiledPlan as { metadata?: { safetyClass?: unknown } } | undefined;
  const value =
    compiledPlan?.metadata?.safetyClass ??
    camelCompiledPlan?.metadata?.safetyClass ??
    workflow?.safetyClass;
  return value === "standard" || value === "destructive" ? value : "read_only";
}

async function shortcutKeyForJob(job: HumanWorkflowCompileJobRecord): Promise<string | null> {
  if (!job.shortcutId) return null;
  const result = await getDb().query("SELECT key FROM workflow_shortcuts WHERE id = $1", [job.shortcutId]);
  const key = result.rows[0]?.key;
  return typeof key === "string" ? key : null;
}

async function compileJobResponse(job: HumanWorkflowCompileJobRecord): Promise<Record<string, unknown>> {
  const nextAction = job.status === "failed"
    ? "retry_compile"
    : job.status === "queued" || job.status === "running"
      ? "poll_compile_job"
      : undefined;
  const metadata = {
    compileJobId: job.id,
    status: job.status,
    requestKey: job.requestKey,
    durationMs: compileDurationMs(job),
    timeoutMs: job.timeoutMs,
    startedAt: job.llmStartedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    retryCount: job.retryCount,
    lastRetriedAt: job.lastRetriedAt,
    retryable: job.status === "failed",
    nextAction,
    source: job.source,
    shortcutKey: await shortcutKeyForJob(job),
    platform: job.platform,
    error: job.error,
    errorClass: job.errorClass,
    providerErrorCode: job.providerErrorCode,
    ...plannerModelMetadata(),
    intentPreview: intentPreview(job.intent),
    retryAfterMs: job.status === "queued" || job.status === "running" ? ASYNC_COMPILE_RETRY_AFTER_MS : undefined,
  };
  if (job.status === "ready" && job.result) return { ...job.result, ...metadata };
  return metadata;
}

function generatedWorkflowCacheResult(cacheKey?: string, requestKey?: string): "cache_hit" | "canonical_hit" {
  return requestKey && !cacheKey ? "canonical_hit" : "cache_hit";
}

async function queueHumanAgencyWorkflowRun(input: {
  requestKey: string;
  cacheKey?: string;
  target: HumanWorkflowTarget;
  intent: string;
  compiledBy?: unknown;
  allowCandidateArtifact?: boolean;
}): Promise<Record<string, unknown>> {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ["dashboard_human", `${input.target.device_id}:${input.target.account_id ?? "device"}:${input.requestKey}`],
    );
    const cacheResult = await client.query<Record<string, unknown>>(
      input.cacheKey
        ? `SELECT * FROM generated_workflow_plan_cache
           WHERE cache_key = $1
             AND artifact_state = ANY($2::text[])`
        : `SELECT * FROM generated_workflow_plan_cache
           WHERE request_key = $1
             AND artifact_state = ANY($2::text[])
           ORDER BY updated_at DESC
           LIMIT 1`,
      [
        input.cacheKey ?? input.requestKey,
        input.allowCandidateArtifact ? ["promoted", "candidate"] : ["promoted"],
      ],
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("canonical generated workflow artifact not found"), {
        status: 404,
        code: "GENERATED_WORKFLOW_CACHE_MISS",
      });
    }

    const safetyClass = cachedHumanWorkflowSafetyClass(cached);
    assertHumanWorkflowMeaningful(cached.workflow as WorkflowTemplate, input.intent);

    const existingRunResult = await client.query<{ id: string; task_id: string | null; status: string }>(
      `SELECT id, task_id, status
       FROM agency_workflow_runs
       WHERE request_key = $1
         AND device_id = $2
         AND account_id IS NOT DISTINCT FROM $3
         AND context ->> 'source' = 'dashboard_human' AND status IN ('queued', 'running')
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [input.requestKey, input.target.device_id, input.target.account_id],
    );
    const existingRun = existingRunResult.rows[0];
    if (existingRun?.task_id) {
      await client.query("COMMIT");
      return {
        id: existingRun.id,
        status: existingRun.status,
        taskId: existingRun.task_id,
        requestKey: input.requestKey,
        cacheKey: cached.cache_key,
      };
    }

    const context = {
      source: "dashboard_human",
      intent: input.intent,
      compiledAt: new Date().toISOString(),
      compiledBy: input.compiledBy ?? null,
      clientId: input.target.client_id,
      accountId: input.target.account_id,
      deviceId: input.target.device_id,
      accountUsername: input.target.account_username,
      accountPlatform: input.target.account_platform,
    };
    let runId = existingRun?.id;
    if (!runId) {
      const runResult = await client.query<{ id: string }>(
        `INSERT INTO agency_workflow_runs
           (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
            canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, 'queued', $11)
         RETURNING id`,
        [
          input.target.client_id,
          input.target.account_id,
          input.target.device_id,
          input.target.account_platform,
          input.intent,
          safetyClass,
          input.requestKey,
          cached.canonical_workflow_id,
          cached.canonical_workflow_version,
          cached.compiled_plan_hash,
          JSON.stringify(context),
        ],
      );
      runId = runResult.rows[0].id;
    }
    const taskParams: Record<string, unknown> = {
      requestKey: input.requestKey,
      clientId: input.target.client_id,
      platform: input.target.account_platform,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: input.intent,
      source: "dashboard_human",
    };
    if (input.allowCandidateArtifact === true) taskParams.allowCandidateArtifact = true;
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        input.target.account_id,
        input.target.device_id,
        JSON.stringify(taskParams),
        new Date().toISOString(),
      ],
    );
    const taskId = taskResult.rows[0].id;
    await client.query(`UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`, [taskId, runId]);
    await client.query("COMMIT");
    taskRunnerService.pollNow().catch((err) => console.error("[human-workflow] immediate task runner poll failed:", err));
    return {
      id: runId,
      status: existingRun?.status ?? "queued",
      taskId,
      requestKey: input.requestKey,
      cacheKey: cached.cache_key,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function inferGeneratedWorkflowAppId(template: WorkflowTemplate): string | null {
  for (const step of template.steps) {
    if (step.type === "action" && step.action === "open_app") {
      const packageName = step.params?.packageName;
      if (typeof packageName === "string" && packageName.trim().length > 0) return packageName;
    }
  }
  return null;
}

async function loadGeneratedWorkflowCurrentAppMap(
  appId: string | null | undefined
): Promise<{ appMap: AppMap | null; quality: AppMapQualityReport | null }> {
  if (!appId) return { appMap: null, quality: null };
  const appMap = await loadMap(appId);
  if (!appMap) return { appMap: null, quality: null };
  return { appMap, quality: validateAppMapQuality(appMap) };
}

async function annotateGeneratedWorkflowCompiledPlanForCache(
  template: WorkflowTemplate,
  compiledPlan: GeneratedWorkflowCompiledPlan,
  appId?: string | null
): Promise<GeneratedWorkflowCompiledPlan> {
  if (!generatedWorkflowPlanUsesAppMap(compiledPlan)) return compiledPlan;
  const current = await loadGeneratedWorkflowCurrentAppMap(appId ?? inferGeneratedWorkflowAppId(template));
  if (!current.appMap || !current.quality) return compiledPlan;
  return withGeneratedWorkflowAppMapCacheMetadata(
    compiledPlan,
    buildGeneratedWorkflowAppMapCacheMetadata(current.appMap, current.quality)
  );
}

async function assessGeneratedWorkflowCachedRecord(
  cached: GeneratedWorkflowPlanCacheRecord,
  appId?: string | null
): Promise<GeneratedWorkflowCacheInvalidation> {
  if (!generatedWorkflowPlanUsesAppMap(cached.compiledPlan)) return { stale: false };
  const current = await loadGeneratedWorkflowCurrentAppMap(
    appId
      ?? cached.compiledPlan.metadata.appMap?.appId
      ?? inferGeneratedWorkflowAppId(cached.workflow)
  );
  return assessGeneratedWorkflowCacheInvalidation(cached.compiledPlan, current.appMap, current.quality);
}

function generatedWorkflowStaleCachePayload(
  invalidation: GeneratedWorkflowCacheInvalidation,
  cacheKey?: string,
  requestKey?: string
): Record<string, unknown> {
  return {
    cacheHit: true,
    cacheMiss: false,
    canExecuteFromCache: false,
    cacheExecutable: false,
    cacheInvalidated: true,
    invalidation,
    cacheKey: cacheKey ?? null,
    requestKey: requestKey ?? null,
    nextAction: "generate_validate_and_cache_workflow",
  };
}

// ─── Global request timeout (hard deadline) ────────────────────────────────────
// Prevents hanging requests from exhausting server resources.
// Any handler that takes too long will get a 504 response.

function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith("/mapping/")) {
    next();
    return;
  }

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

const requireAuth = requireAdminAuth;

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

  const accessToken  = signJwt({ sub: username, role: "admin", aud: "dashboard_access" }, 15 * 60 * 1_000);      // 15min
  const refreshToken = signJwt({ sub: username, role: "admin", refresh: true, aud: "dashboard_refresh" }, 7 * 24 * 60 * 60 * 1_000); // 7d

  res.json({ ok: true, data: { accessToken, refreshToken } });
});

router.post("/auth/refresh", (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) return res.status(400).json({ ok: false, error: "refreshToken required" });

  const payload = verifyJwt(refreshToken);
  if (!payload || !payload.refresh) {
    return res.status(401).json({ ok: false, error: "Invalid refresh token" });
  }

  const newAccess = signJwt({ sub: payload.sub, role: payload.role, aud: "dashboard_access" }, 15 * 60 * 1_000);
  res.json({ ok: true, data: { accessToken: newAccess } });
});

// ─── APK download (public, no auth) ──────────────────────────────────────────

async function readOtaManifest() {
  const fs = await import("fs/promises");
  const path = await import("path");
  const apkPath = path.join(process.cwd(), "apk", "phone-network.apk");
  const manifestPath = path.join(process.cwd(), "apk", "phone-network.json");
  const apkBuffer = await fs.readFile(apkPath);
  const apkSha256 = crypto.createHash("sha256").update(apkBuffer).digest("hex");
  const stat = await fs.stat(apkPath);
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Older images may not include a manifest; fall back to conservative values.
  }
  return {
    version: typeof manifest.version === "string" ? manifest.version : "1.0.0",
    versionCode: typeof manifest.versionCode === "number" ? manifest.versionCode : 1,
    sha256: apkSha256,
    size: stat.size,
    filename: "phone-network.apk",
  };
}

router.get("/apk/download", async (_req, res) => {
  const fs = await import("fs/promises");
  const path = await import("path");
  const apkPath = path.join(process.cwd(), "apk", "phone-network.apk");
  try {
    const stat = await fs.stat(apkPath);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="phone-network.apk"');
    const { createReadStream } = await import("fs");
    createReadStream(apkPath, { highWaterMark: 1024 * 1024 }).pipe(res);
  } catch {
    res.status(404).json({ ok: false, error: "APK not found" });
  }
});

router.get("/ota/manifest", requireAuth, async (_req, res) => {
  try {
    const manifest = await readOtaManifest();
    res.json({
      ok: true,
      data: {
        ...manifest,
        downloadUrl: "http://enkzoned.go.ro:3000/api/apk/download",
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Device-auth routes (no dashboard/API-key auth) ─────────────────────────
// Devices fetch short-lived model credentials with their DirectWS device key.
// Keep these before the global dashboard/API-key middleware.
router.get("/device/model-config", requireDeviceModelConfigAuth, getDeviceModelConfigRoute);
router.get("/devices/me/model-config", requireDeviceModelConfigAuth, getDeviceModelConfigRoute);

// ─── All routes below require auth ───────────────────────────────────────────

router.use(requireApiGateAuth);

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

// ─── Dashboard Human Workflow Launcher ────────────────────────────────────────

router.post("/workflows/human/compile", requireAdminAuth, async (req, res) => {
  try {
    const { device_id, account_id, intent } = req.body as {
      device_id?: unknown;
      account_id?: unknown;
      intent?: unknown;
    };
    if (typeof device_id !== "string" || !UUID_RE.test(device_id)) {
      return res.status(400).json({ ok: false, code: "DEVICE_ID_REQUIRED", error: "device_id must be a UUID" });
    }
    if (typeof intent !== "string" || intent.trim().length === 0) {
      return res.status(400).json({ ok: false, code: "INTENT_REQUIRED", error: "intent required" });
    }
    if (intent.trim().length > 2000) {
      return res.status(400).json({ ok: false, code: "INTENT_TOO_LONG", error: "intent must be at most 2000 characters" });
    }
    const accountId = typeof account_id === "string" && UUID_RE.test(account_id) ? account_id : null;
    if (account_id !== undefined && account_id !== null && !accountId) {
      return res.status(400).json({ ok: false, code: "ACCOUNT_ID_INVALID", error: "account_id must be a UUID when provided" });
    }
    if (!accountId && !isAccountlessHumanWorkflowIntent(intent)) {
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_ID_REQUIRED",
        error: "account_id is required for social account workflows; device/app management intents may omit it",
      });
    }

    const data = await humanWorkflowCompilerService.compile({
      deviceId: device_id,
      accountId,
      intent,
    });
    if (data.status === "compiling") {
      return res.status(202).json({ ok: true, data });
    }
    res.json({ ok: true, data });
  } catch (err) {
    const typed = err as Error & {
      status?: number;
      code?: string;
      validationErrors?: string[];
      requestKey?: string;
      retryable?: boolean;
      nextAction?: string;
    };
    res.status(typed.status ?? 500).json({
      ok: false,
      code: typed.code,
      error: typed.message,
      errors: typed.validationErrors,
      requestKey: typed.requestKey,
      retryable: typed.retryable,
      nextAction: typed.nextAction,
    });
  }
});

router.get("/workflows/human/compile-jobs/:id", requireAdminAuth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ ok: false, code: "COMPILE_JOB_ID_INVALID", error: "compile job id must be a UUID" });
    }
    const job = await humanWorkflowCompilerService.getCompileJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, code: "COMPILE_JOB_NOT_FOUND", error: "compile job not found" });
    const data = await compileJobResponse(job);
    res.json({ ok: true, data });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, code: typed.code, error: typed.message });
  }
});

router.post("/workflows/human/compile-jobs/:id/retry", requireAdminAuth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      return res.status(400).json({ ok: false, code: "COMPILE_JOB_ID_INVALID", error: "compile job id must be a UUID" });
    }
    const job = await humanWorkflowCompilerService.retryCompileJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, code: "COMPILE_JOB_NOT_FOUND", error: "compile job not found" });
    const nextAction = job.status === "queued" || job.status === "running" ? "poll_compile_job" : job.status === "failed" ? "retry_compile" : undefined;
    res.json({
      ok: true,
      data: {
        status: job.status,
        compileJobId: job.id,
        requestKey: job.requestKey,
        retryCount: job.retryCount,
        retryAfterMs: job.status === "queued" || job.status === "running" ? ASYNC_COMPILE_RETRY_AFTER_MS : undefined,
        nextAction,
      },
    });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, code: typed.code, error: typed.message });
  }
});

router.post("/workflows/human/run", requireAdminAuth, async (req, res) => {
  try {
    const { device_id, account_id, intent, requestKey, cacheKey, compileJobId } = req.body as {
      device_id?: unknown;
      account_id?: unknown;
      intent?: unknown;
      requestKey?: unknown;
      cacheKey?: unknown;
      compileJobId?: unknown;
    };
    if (typeof device_id !== "string" || !UUID_RE.test(device_id)) {
      return res.status(400).json({ ok: false, code: "DEVICE_ID_REQUIRED", error: "device_id must be a UUID" });
    }
    if (typeof intent !== "string" || intent.trim().length === 0) {
      return res.status(400).json({ ok: false, code: "INTENT_REQUIRED", error: "intent required" });
    }
    if (intent.trim().length > 2000) {
      return res.status(400).json({ ok: false, code: "INTENT_TOO_LONG", error: "intent must be at most 2000 characters" });
    }
    if (requestKey !== undefined && (typeof requestKey !== "string" || !GENERATED_WORKFLOW_KEY_RE.test(requestKey))) {
      return res.status(400).json({ ok: false, code: "REQUEST_KEY_INVALID", error: "requestKey must be a 24-character lowercase hex string" });
    }
    if (cacheKey !== undefined && (typeof cacheKey !== "string" || !GENERATED_WORKFLOW_KEY_RE.test(cacheKey))) {
      return res.status(400).json({ ok: false, code: "CACHE_KEY_INVALID", error: "cacheKey must be a 24-character lowercase hex string" });
    }
    if (compileJobId !== undefined && (typeof compileJobId !== "string" || !UUID_RE.test(compileJobId))) {
      return res.status(400).json({ ok: false, code: "COMPILE_JOB_ID_INVALID", error: "compileJobId must be a UUID" });
    }
    const accountId = typeof account_id === "string" && UUID_RE.test(account_id) ? account_id : null;
    if (account_id !== undefined && account_id !== null && !accountId) {
      return res.status(400).json({ ok: false, code: "ACCOUNT_ID_INVALID", error: "account_id must be a UUID when provided" });
    }
    if (!accountId && !isAccountlessHumanWorkflowIntent(intent)) {
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_ID_REQUIRED",
        error: "account_id is required for social account workflows; device/app management intents may omit it",
      });
    }

    const expectedRequestKey = computeHumanWorkflowRequestKey(device_id, accountId, intent);
    // Accept requestKey from client without strict validation — allows cache-based runs
    // where the cached requestKey may differ from a freshly computed one
    // (e.g., whitespace differences, intent normalization).
    const useRequestKey = typeof requestKey === "string" ? requestKey : expectedRequestKey;

    let compiled: HumanWorkflowCompileReady | null = null;
    if (typeof compileJobId === "string") {
      const job = await humanWorkflowCompilerService.getCompileJob(compileJobId);
      if (!job || job.requestKey !== useRequestKey || job.deviceId !== device_id || job.accountId !== accountId) {
        return res.status(404).json({ ok: false, code: "COMPILE_JOB_NOT_FOUND", error: "compile job not found for request" });
      }
      if (job.status !== "ready" || !job.result) {
        return res.status(409).json({
          ok: false,
          code: "COMPILE_NOT_READY",
          error: "compile job is not ready",
          compileJobId,
          requestKey: useRequestKey,
          nextAction: "poll_compile_job",
        });
      }
      compiled = job.result as HumanWorkflowCompileReady;
    } else {
      const ready = await humanWorkflowCompilerService.compile({
        deviceId: device_id,
        accountId,
        intent,
      });
      if (ready.status !== "ready") {
        return res.status(409).json({
          ok: false,
          code: "COMPILE_NOT_READY",
          error: "compiled workflow is not ready",
          compileJobId: ready.compileJobId,
          requestKey: useRequestKey,
          nextAction: "poll_compile_job",
        });
      }
      compiled = ready;
    }

    if (typeof cacheKey === "string" && cacheKey !== compiled.cacheKey) {
      return res.status(400).json({
        ok: false,
        code: "CACHE_KEY_MISMATCH",
        error: "cacheKey does not match the compiled workflow preview",
      });
    }
    const run = await queueHumanAgencyWorkflowRun({
      requestKey: useRequestKey,
      cacheKey: typeof cacheKey === "string" ? cacheKey : compiled.cacheKey,
      target: compiled.target,
      intent: intent.trim(),
      compiledBy: (req as any).dashboardUser?.sub ?? (req as any).dashboardUser?.userId ?? (req as any).authPrincipal?.userId,
      allowCandidateArtifact: compiled.source === "llm",
    });
    res.status(201).json({ ok: true, data: run });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string; validationErrors?: string[] };
    res.status(typed.status ?? 500).json({
      ok: false,
      code: typed.code,
      error: typed.message,
      errors: typed.validationErrors,
    });
  }
});

router.get("/workflows/:id", requireAuth, async (req, res) => {
  const wf = await workflowService.get(req.params.id);
  if (!wf) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, data: wf });
});

router.post("/workflows", requireAuth, async (req, res) => {
  res.status(410).json({
    ok: false,
    code: "WORKFLOW_TEMPLATES_ARE_EXAMPLES_ONLY",
    error: "Direct template workflow dispatch is deprecated. Use POST /api/workflow-runs with instruction, appId and deviceId.",
    data: {
      replacement: "/api/workflow-runs",
      requiredBody: ["instruction", "appId", "deviceId"],
    },
  });
});

router.get("/workflows/generated/schema", requireAuth, async (_req, res) => {
  res.json({ ok: true, data: getGeneratedWorkflowContract() });
});

router.post("/workflows/generated/prompt", requireAuth, async (req, res) => {
  try {
    const { platform, packageName, appId, goal, clientContext, availableScreens, appMapHints } = req.body as {
      platform?: string;
      packageName?: string;
      appId?: string;
      goal?: string;
      clientContext?: string;
      availableScreens?: string[];
      appMapHints?: string[];
    };
    const resolvedPackageName = packageName ?? appId;
    if (!platform || !resolvedPackageName || !goal) {
      return res.status(400).json({ ok: false, error: "platform, packageName/appId and goal required" });
    }

    const appMap = appId ? await loadMap(appId) : null;
    const appMapHintSet = appMap ? buildGeneratedWorkflowAppMapHints(appMap) : null;
    const resolvedAppMapHints = appMapHints ?? appMapHintSet?.hints;
    const resolvedScreens = resolveGeneratedWorkflowScreens(platform, availableScreens);
    const requestKey = computeGeneratedWorkflowRequestKey({
      platform,
      packageName: resolvedPackageName,
      goal,
      clientContext,
      availableScreens: resolvedScreens,
      appMapHints: resolvedAppMapHints,
    });

    const cached = await workflowService.getGeneratedPlanCacheByRequestKey(requestKey);
    if (cached) {
      const invalidation = await assessGeneratedWorkflowCachedRecord(cached, appId ?? resolvedPackageName);
      if (invalidation.stale) {
        generatedWorkflowCacheLookups?.labels("prompt", "miss").inc();
        return res.json({
          ok: true,
          data: {
            ...generatedWorkflowStaleCachePayload(invalidation, cached.cacheKey, cached.requestKey ?? requestKey),
            appMapLoaded: !!appMap,
            mapUsable: appMapHintSet?.mapUsable ?? false,
            appMapQuality: appMapHintSet
              ? {
                  reasons: appMapHintSet.reasons,
                  warnings: appMapHintSet.warnings,
                  stats: appMapHintSet.stats,
                }
              : null,
            prompt: buildGeneratedWorkflowPrompt({
              platform,
              packageName: resolvedPackageName,
              goal,
              clientContext,
              availableScreens: resolvedScreens,
              appMapHints: resolvedAppMapHints,
            }),
          },
        });
      }
      generatedWorkflowCacheLookups?.labels("prompt", "canonical_hit").inc();
      return res.json({
        ok: true,
        data: {
          cacheHit: true,
          cacheMiss: false,
          canExecuteFromCache: true,
          nextAction: "reuse_cached_workflow",
          ...cached,
        },
      });
    }
    generatedWorkflowCacheLookups?.labels("prompt", "miss").inc();

    res.json({
      ok: true,
      data: {
        requestKey,
        cacheHit: false,
        cacheMiss: true,
        canExecuteFromCache: false,
        nextAction: "generate_validate_and_cache_workflow",
        appMapLoaded: !!appMap,
        mapUsable: appMapHintSet?.mapUsable ?? false,
        appMapQuality: appMapHintSet
          ? {
              reasons: appMapHintSet.reasons,
              warnings: appMapHintSet.warnings,
              stats: appMapHintSet.stats,
            }
          : null,
        screenCount: resolvedScreens.length,
        prompt: buildGeneratedWorkflowPrompt({
          platform,
          packageName: resolvedPackageName,
          goal,
          clientContext,
          availableScreens: resolvedScreens,
          appMapHints: resolvedAppMapHints,
        }),
      },
    });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, error: typed.message, code: typed.code });
  }
});

router.post("/workflows/generated/validate", requireAuth, async (req, res) => {
  const validation = validateGeneratedWorkflowTemplate((req.body as { workflow?: unknown }).workflow);
  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: "workflow failed validation",
      errors: validation.errors,
    });
  }
  const template = validation.template!;
  res.json({
    ok: true,
    data: {
      valid: true,
      ...summarizeGeneratedWorkflowTemplate(template),
    },
  });
});

router.post("/workflows/generated/cache/resolve", requireAuth, async (req, res) => {
  const { cacheKey, requestKey, workflow, persist, appId } = req.body as {
    cacheKey?: string;
    requestKey?: string;
    workflow?: unknown;
    persist?: boolean;
    appId?: string;
  };

  if (!cacheKey && !requestKey && !workflow) {
    return res.status(400).json({ ok: false, error: "cacheKey, requestKey or workflow required" });
  }
  if (cacheKey && !/^[a-f0-9]{24}$/.test(cacheKey)) {
    return res.status(400).json({ ok: false, error: "cacheKey must be a 24-character lowercase hex string" });
  }
  if (requestKey && !/^[a-f0-9]{24}$/.test(requestKey)) {
    return res.status(400).json({ ok: false, error: "requestKey must be a 24-character lowercase hex string" });
  }

  try {
    const hadCacheLookup = !!(cacheKey || requestKey);
    if (hadCacheLookup) {
      const cached = cacheKey
        ? await workflowService.getGeneratedPlanCache(cacheKey)
        : await workflowService.getGeneratedPlanCacheByRequestKey(requestKey!);
      if (cached) {
        const invalidation = await assessGeneratedWorkflowCachedRecord(cached, appId);
        if (invalidation.stale) {
          generatedWorkflowCacheLookups?.labels("resolve", "miss").inc();
          return res.json({
            ok: true,
            data: generatedWorkflowStaleCachePayload(invalidation, cached.cacheKey, cached.requestKey ?? requestKey),
          });
        }
        generatedWorkflowCacheLookups?.labels("resolve", generatedWorkflowCacheResult(cacheKey, requestKey)).inc();
        return res.json({
          ok: true,
          data: {
            cacheHit: true,
            cacheMiss: false,
            canExecuteFromCache: true,
            nextAction: "reuse_cached_workflow",
            ...cached,
          },
        });
      }
      generatedWorkflowCacheLookups?.labels("resolve", "miss").inc();
      if (!workflow) {
        return res.status(200).json({
          ok: true,
          data: {
            cacheHit: false,
            cacheMiss: true,
            canExecuteFromCache: false,
            cacheKey,
            requestKey,
            nextAction: "generate_validate_and_cache_workflow",
          },
        });
      }
    }

    const validation = validateGeneratedWorkflowTemplate(workflow);
    if (!validation.template) {
      return res.status(400).json({
        ok: false,
        error: "workflow failed validation",
        errors: validation.errors,
      });
    }

    const template = validation.template;
    let compiledPlan = compileGeneratedWorkflowTemplate(template);
    compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, appId);
    const shouldPersist = persist !== false;
    if (shouldPersist) {
      await workflowService.saveTemplate(template);
      await workflowService.saveGeneratedPlanCache(template, compiledPlan, requestKey, {
        source: "generated_workflow_resolve",
        persisted: true,
      });
      generatedWorkflowCacheLookups?.labels("resolve", "compiled_new").inc();
    }

    res.status(200).json({
      ok: true,
      data: {
        cacheHit: false,
        cacheMiss: hadCacheLookup,
        canExecuteFromCache: false,
        requestedCacheKey: cacheKey ?? null,
        requestedRequestKey: requestKey ?? null,
        requestKey: requestKey ?? null,
        nextAction: shouldPersist ? "await_promotion_before_execution" : "validate_or_persist_before_execution",
        persisted: shouldPersist,
        artifactState: shouldPersist ? "candidate" : null,
        ...summarizeGeneratedWorkflowTemplate(template, { dryRun: true, persisted: shouldPersist, compiledPlan }),
      },
    });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, error: typed.message, code: typed.code });
  }
});

router.get("/workflows/generated/cache/:cacheKey", requireAuth, async (req, res) => {
  const { cacheKey } = req.params;
  if (!/^[a-f0-9]{24}$/.test(cacheKey)) {
    return res.status(400).json({ ok: false, error: "cacheKey must be a 24-character lowercase hex string" });
  }

  try {
    const cached = await workflowService.getGeneratedPlanCache(cacheKey);
    if (!cached) return res.status(404).json({ ok: false, error: "generated workflow plan cache miss" });
    const invalidation = await assessGeneratedWorkflowCachedRecord(cached, typeof req.query.appId === "string" ? req.query.appId : undefined);
    if (invalidation.stale) {
      return res.status(409).json({
        ok: false,
        error: "generated workflow plan cache is stale for current app map",
        code: "GENERATED_WORKFLOW_CACHE_STALE",
        data: generatedWorkflowStaleCachePayload(invalidation, cached.cacheKey, cached.requestKey ?? undefined),
      });
    }
    res.json({ ok: true, data: cached });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, error: typed.message, code: typed.code });
  }
});

router.post("/workflows/generated", requireAuth, async (req, res) => {
  const { workflow, cacheKey, deviceId, accountId, clientId, campaignId, variables, dryRun, persist, requestKey, appId } = req.body as {
    workflow?: unknown;
    cacheKey?: string;
    deviceId?: string;
    accountId?: string;
    clientId?: string;
    campaignId?: string;
    variables?: Record<string, unknown>;
    dryRun?: boolean;
    persist?: boolean;
    requestKey?: string;
    appId?: string;
  };
  if (!workflow && !cacheKey && !requestKey) {
    return res.status(400).json({ ok: false, error: "workflow, cacheKey or requestKey required" });
  }
  if (workflow && (cacheKey || requestKey)) {
    return res.status(400).json({
      ok: false,
      error: "workflow payload is not allowed with cacheKey or requestKey execution",
      code: "WORKFLOW_PAYLOAD_NOT_ALLOWED_FOR_CANONICAL_EXECUTION",
    });
  }
  if (workflow && !dryRun) {
    return res.status(409).json({
      ok: false,
      error: "workflow payload execution is disabled; validate and persist the generated workflow, then execute by cacheKey or requestKey",
      code: "GENERATED_WORKFLOW_CANONICAL_CACHE_REQUIRED",
      data: {
        nextAction: "validate_or_persist_before_execution",
      },
    });
  }
  if (!dryRun && !deviceId) {
    return res.status(400).json({ ok: false, error: "deviceId required unless dryRun is true" });
  }
  if (cacheKey && !/^[a-f0-9]{24}$/.test(cacheKey)) {
    return res.status(400).json({ ok: false, error: "cacheKey must be a 24-character lowercase hex string" });
  }
  if (requestKey && !/^[a-f0-9]{24}$/.test(requestKey)) {
    return res.status(400).json({ ok: false, error: "requestKey must be a 24-character lowercase hex string" });
  }

  let cacheHit = false;
  let resolvedCache: GeneratedWorkflowPlanCacheRecord | null = null;
  try {
    if (cacheKey || requestKey) {
      const cached = cacheKey
        ? await workflowService.getGeneratedPlanCache(cacheKey)
        : await workflowService.getGeneratedPlanCacheByRequestKey(requestKey!);
      if (!cached && !workflow) {
        generatedWorkflowCacheLookups?.labels("execute", "miss").inc();
        return res.status(404).json({
          ok: false,
          error: "generated workflow plan cache miss",
          cacheKey,
          requestKey,
        });
      }
      if (cached) {
        const invalidation = await assessGeneratedWorkflowCachedRecord(cached, appId);
        if (invalidation.stale) {
          generatedWorkflowCacheLookups?.labels("execute", "miss").inc();
          return res.status(409).json({
            ok: false,
            error: "generated workflow plan cache is stale for current app map",
            code: "GENERATED_WORKFLOW_CACHE_STALE",
            data: generatedWorkflowStaleCachePayload(invalidation, cached.cacheKey, cached.requestKey ?? requestKey),
          });
        }
        resolvedCache = cached;
        cacheHit = true;
        generatedWorkflowCacheLookups?.labels("execute", generatedWorkflowCacheResult(cacheKey, requestKey)).inc();
      } else {
        generatedWorkflowCacheLookups?.labels("execute", "miss").inc();
      }
    }

    let template: WorkflowTemplate;
    let compiledPlan: GeneratedWorkflowCompiledPlan;
    if (resolvedCache) {
      template = resolvedCache.workflow;
      compiledPlan = resolvedCache.compiledPlan;
    } else {
      const validation = validateGeneratedWorkflowTemplate(workflow);
      if (!validation.template) {
        return res.status(400).json({
          ok: false,
          error: "workflow failed validation",
          errors: validation.errors,
        });
      }
      template = validation.template;
      compiledPlan = compileGeneratedWorkflowTemplate(template);
      compiledPlan = await annotateGeneratedWorkflowCompiledPlanForCache(template, compiledPlan, appId);
    }
    const controlPlaneContext: GeneratedWorkflowControlPlaneContext = {
      source: "api",
      accountId,
      clientId,
      campaignId,
      deviceId,
      platform: template.platform,
    };

    if (dryRun) {
      const shouldPersist = persist === true;
      if (shouldPersist && !resolvedCache) {
        await workflowService.saveTemplate(template);
        await workflowService.saveGeneratedPlanCache(template, compiledPlan, requestKey, {
          source: "generated_workflow_execute_dry_run",
          persisted: true,
        });
        generatedWorkflowCacheLookups?.labels("execute", "compiled_new").inc();
      }
      return res.status(200).json({
        ok: true,
        data: {
          cacheHit,
          canonicalHit: cacheHit,
          canExecuteFromCache: cacheHit,
          cacheKey: resolvedCache?.cacheKey ?? compiledPlan.cacheKey,
          requestKey: resolvedCache?.requestKey ?? requestKey ?? null,
          canonicalWorkflowId: resolvedCache?.canonicalWorkflowId ?? template.id,
          canonicalWorkflowVersion: resolvedCache?.canonicalWorkflowVersion ?? template.version,
          compiledPlanHash: resolvedCache?.compiledPlanHash ?? null,
          artifactState: resolvedCache?.artifactState ?? (shouldPersist ? "candidate" : null),
          controlPlaneContext,
          ...summarizeGeneratedWorkflowTemplate(template, { dryRun: true, persisted: shouldPersist, compiledPlan }),
        },
      });
    }

    const dispatchDeviceId = dryRun ? undefined : resolveGeneratedWorkflowDeviceId(deviceId!);
    controlPlaneContext.deviceId = dispatchDeviceId;

    if (!resolvedCache) {
      await workflowService.saveTemplate(template);
      await workflowService.saveGeneratedPlanCache(template, compiledPlan, requestKey, {
        source: "generated_workflow_execute",
        persisted: true,
      });
      generatedWorkflowCacheLookups?.labels("execute", "compiled_new").inc();
    }
    const data = await dispatchGeneratedWorkflowTemplate({
      templateId: template.id,
      template,
      deviceId: dispatchDeviceId!,
      accountId,
      variables: {
        ...(variables ?? {}),
        generatedWorkflow: true,
        generatedWorkflowId: template.id,
        generatedWorkflowCompiledPlan: compiledPlan,
        generatedWorkflowRuntimeProvenance: compiledPlan.steps.map((step) => ({
          path: step.path,
          id: step.id,
          action: step.action,
          usedAppMap: step.usedAppMap ?? false,
          bindingSource: step.bindingSource ?? "fallback",
          selectorId: step.selectorId,
          selectorName: step.selectorName,
          pageId: step.pageId,
          pageSignature: step.pageSignature,
          coordinateSource: step.coordinateSource,
          boundsSource: step.boundsSource,
          fallbackReason: step.fallbackReason,
          provenance: step.provenance,
        })),
      },
      controlPlaneContext,
    });
    const executionSource = cacheKey ? "cache_key" : requestKey ? "request_key" : "workflow";
    generatedWorkflowExecutions?.labels(template.platform, String(cacheHit), executionSource).inc();
    if (cacheHit && compiledPlan.llmBudget.happyPathRequests === 0) {
      generatedWorkflowLlmAvoided?.labels(template.platform, "cache_hit").inc();
    }
    res.status(202).json({
      ok: true,
      data: {
        ...data,
        generated: true,
        cacheHit,
        canonicalHit: cacheHit,
        canExecuteFromCache: true,
        cacheKey: resolvedCache?.cacheKey ?? compiledPlan.cacheKey,
        requestKey: resolvedCache?.requestKey ?? requestKey ?? null,
        canonicalWorkflowId: resolvedCache?.canonicalWorkflowId ?? template.id,
        canonicalWorkflowVersion: resolvedCache?.canonicalWorkflowVersion ?? template.version,
        compiledPlanHash: resolvedCache?.compiledPlanHash ?? null,
        controlPlaneContext,
        compiledPlan,
      },
    });
  } catch (err) {
    const typed = err as Error & { status?: number; code?: string };
    res.status(typed.status ?? 500).json({ ok: false, error: typed.message, code: typed.code });
  }
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
  res.json({
    ok: true,
    data: templates.map((template) => ({
      ...template,
      exampleOnly: true,
      executableVia: "/api/workflow-runs",
    })),
  });
});

router.get("/workflow-templates/:id", requireAuth, async (req, res) => {
  const t = await workflowService.getTemplate(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({
    ok: true,
    data: {
      ...t,
      exampleOnly: true,
      executableVia: "/api/workflow-runs",
    },
  });
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


function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function requireDeviceModelConfigAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const deviceId = String(req.headers["x-device-id"] ?? req.query.deviceId ?? "").trim();
  const deviceKey = String(req.headers["x-device-key"] ?? req.headers["x-device-token"] ?? "").trim();
  if (!deviceId || !deviceKey) {
    res.status(401).json({ ok: false, error: "Device credentials required" });
    return;
  }

  try {
    const result = await getDb().query(
      `SELECT id, device_key, status FROM devices WHERE id = $1`,
      [deviceId]
    );
    const row = result.rows[0] as { id: string; device_key: string | null; status: string } | undefined;
    const approved = row && ["approved", "online", "offline"].includes(row.status);
    if (!row || !approved || !row.device_key || !safeEqualString(deviceKey, row.device_key)) {
      res.status(row?.status === "blocked" ? 403 : 401).json({ ok: false, error: "Device not authorized" });
      return;
    }
    (req as any).deviceId = row.id;
    return next();
  } catch (err) {
    console.error("[api] device model-config auth error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "Device auth failed" });
  }
}

async function getDeviceModelConfigRoute(req: Request, res: Response): Promise<void> {
  try {
    const bundle = await modelConfigService.getDeviceBundle();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, data: bundle });
  } catch (err) {
    handleModelConfigError(res, err);
  }
}

function notifyModelConfigUpdated(): void {
  const version = Date.now();
  for (const deviceId of directWsServer.getConnectedDeviceIds()) {
    directWsServer.sendToDevice(deviceId, { type: "MODEL_CONFIG_UPDATED", version });
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
    notifyModelConfigUpdated();
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
    notifyModelConfigUpdated();
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
  let manifest: Awaited<ReturnType<typeof readOtaManifest>>;
  try {
    manifest = await readOtaManifest();
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `APK manifest unavailable: ${(err as Error).message}`,
    });
  }

  const { mandatory = false, deviceIds } = req.body as {
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
  let skippedDuplicate = 0;
  const debounce = ((globalThis as any).__phoneNetworkOtaPushDebounce ??= new Map<string, number>()) as Map<string, number>;
  // Force correct external URL for OTA — Docker internal port (21211) is not accessible to devices
  const baseUrl = 'http://enkzoned.go.ro:3000';
  for (const device of targets) {
    try {
      const key = `${device.deviceId}:${manifest.versionCode}:${manifest.sha256}`;
      const now = Date.now();
      const last = debounce.get(key) ?? 0;
      if (now - last < 10 * 60 * 1000) {
        skippedDuplicate++;
        continue;
      }
      debounce.set(key, now);
      directWsServer.sendToDevice(device.deviceId, {
        type: "OTA_UPDATE",
        version: manifest.version,
        versionCode: manifest.versionCode,
        apkUrl: `${baseUrl}/api/apk/download`,
        apkSha256: manifest.sha256,
        mandatory,
      });
      directWsServer.recordOtaStatus(device.deviceId, {
        status: "sent",
        version: manifest.version,
        versionCode: manifest.versionCode,
        apkSha256: manifest.sha256,
      });
      sentTo++;
    } catch {}
  }
  console.log(`[ota] Push sent to ${sentTo}/${targets.length} devices`);

  res.json({
    ok: true,
    data: {
      count: sentTo,
      skippedDuplicate,
      version: manifest.version,
      versionCode: manifest.versionCode,
      apkSha256: manifest.sha256,
      size: manifest.size,
      mandatory,
    },
  });
});

router.get("/ota/status", requireAuth, async (_req, res) => {
  res.json({
    ok: true,
    data: {
      items: directWsServer.getOtaStatuses(),
    },
  });
});

// ─── Health check (no auth) ─────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    data: {
      status: "healthy",
      ts: new Date().toISOString(),
      appVersion: process.env.PHONE_NETWORK_APP_VERSION ?? null,
      buildCommit: process.env.BUILD_COMMIT ?? process.env.GIT_SHA ?? null,
    },
  });
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

router.get("/debug/connections", (_req, res) => {
  // DirectWs only - show connected devices
  const onlineDevices = directWsServer.getConnectedDeviceIds();
  const list = onlineDevices.map((id) => ({
    deviceId: id,
    shortDeviceId: id.slice(0, 8),
    online: true,
    agentVersion: directWsServer.getAgentVersion(id),
    edgeCapable: directWsServer.supportsEdgeExecution(id),
  }));
  res.json({ ok: true, data: { count: list.length, connections: list } });
});

// ─── Scalability & Health ─────────────────────────────────────────────────────

router.get("/scalability/status", async (_req, res) => {
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
  res.status(410).json({
    ok: false,
    code: "WORKFLOW_TEMPLATES_ARE_EXAMPLES_ONLY",
    error: "Direct edge template push is deprecated. Use POST /api/workflow-runs with instruction, appId and deviceId.",
    data: {
      replacement: "/api/workflow-runs",
      requiredBody: ["instruction", "appId", "deviceId"],
    },
  });
});

// ─── Edge Workflow: List templates for device ─────────────────────────────────

router.get("/edge/templates", requireAuth, async (_req, res) => {
  try {
    const templates = await workflowService.listTemplates();
    res.json({
      ok: true,
      data: templates.map((template) => ({
        ...template,
        exampleOnly: true,
        executableVia: "/api/workflow-runs",
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Edge Workflow: Broadcast template to all online devices ───────────────────

router.post("/edge/broadcast-template", requireAuth, async (req, res) => {
  res.status(410).json({
    ok: false,
    code: "WORKFLOW_TEMPLATES_ARE_EXAMPLES_ONLY",
    error: "Direct edge template broadcast is deprecated. Use POST /api/workflow-runs with instruction, appId and deviceId.",
    data: {
      replacement: "/api/workflow-runs",
      requiredBody: ["instruction", "appId", "deviceId"],
    },
  });
});

// ─── Edge Workflow: Status overview (ADR-001 Phase 5) ─────────────────────────

router.get("/edge/status", requireAuth, async (_req, res) => {
  try {
    const onlineDevices = directWsServer.getConnectedDeviceIds();
    const edgeDevices = onlineDevices.filter(id => directWsServer.supportsEdgeExecution(id));
    const legacyDevices = onlineDevices.filter(id => !directWsServer.supportsEdgeExecution(id));

    const deviceInfo = onlineDevices.map(id => ({
      deviceId: id,
      shortDeviceId: id.slice(0, 8),
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
