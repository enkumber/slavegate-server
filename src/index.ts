/**
 * index.ts
 * Server entry point — bootstraps Express, WebSocket, DB, Redis.
 */

import "dotenv/config";
import http from "http";
import path from "path";
import express from "express";
import cors from "cors";
import { wsServer } from "./ws/ws.server";
import { directWsServer } from "./ws/direct-ws.server";
import { createWsGateway, wsGateway } from "./ws";
import apiRouter from "./api/routes";
import agencyRouter from "./api/agency-routes";
import workflowRunRouter from "./api/workflow-run-routes";
import vlmRouter from "./api/vlm-routes";
import workflowDispatchRoutes from "./api/workflow-dispatch-routes";
import deviceTokenRouter from "./api/device-tokens.routes";
import mappingRoutes from "./modules/app-mapping/mapping-routes";
import { compilerRoutes } from "./modules/workflow-compiler";
import { getDb, closeDb } from "./db/client";
import { closeRedis } from "./redis/client";
import { dispatcherService } from "./modules/dispatcher/dispatcher.service";
import { authService } from "./modules/auth/auth.service";
import { startWorkflowWorker } from "./modules/workflows/workflow.executor";
import { startEdgeWorkflowProgressWatchdog } from "./modules/workflows/edge-workflow-lifecycle.service";
import { lifecycleManager } from "./modules/accounts/lifecycle";
import { canaryService } from "./modules/canary/canary.service";
import { runMigrations } from "./db/migrate";
import { startTaskRunner } from "./modules/task-runner";
import { dashboardWorkflowWsServer } from "./modules/workflow-events/dashboard-ws.server";
import { deviceExecutionArbiter } from "./modules/device-execution";
import { isDeviceExecutionEnforced } from "./modules/device-execution/device-execution-authority";
import { sweepQueuedJobsForOnlineDevices } from "./transport/transport";
import { pnqV2RuntimeService } from "./modules/device-execution/pnq-v2-runtime.service";
import { describePnqV2RuntimeConfig, isPnqV2ShadowRuntimeEnabled } from "./modules/device-execution/pnq-v2-runtime-config";
// skill-updater now triggered via API endpoint (POST /api/skill-updater/run)
import { isKillSwitchActive, setWsServerRef } from "./api/routes";
import { startOpsMonitorScheduler } from "./modules/ops-monitor/ops-monitor.service";
import configRoutes, { seedSystemPrompts } from "./api/config-routes";
import uiGraphRoutes from "./modules/ui-graph/routes";
import { describeUiGraphRuntimeFlags } from "./modules/ui-graph/config";
import segmentBuilderRoutes from "./modules/segment-builder/routes";
import {
  ensureSegmentBuilderAgentToken,
  segmentBuildJobService,
} from "./modules/segment-builder/segment-build-job.service";

const PORT = parseInt(process.env.PORT ?? "21211", 10);

async function bootstrap(): Promise<void> {
  // ─── Required env vars check — fail fast before anything else ────────────
  const requiredEnv = ["API_KEY", "DATABASE_URL", "DASHBOARD_USERNAME", "DASHBOARD_PASSWORD", "JWT_SECRET", "CREDENTIAL_ENCRYPTION_KEY"];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `[server] FATAL: Missing required environment variables: ${missing.join(", ")}\n` +
      `         Server refuses to start without them. Check your .env file.`
    );
    process.exit(1);
  }

  // ─── Verify DB connection ─────────────────────────────────────────────────
  await getDb().query("SELECT 1");
  console.log("[server] Database connected.");

  // ─── Auto-migrate: ensure all schema + migrations are applied ─────────────
  await runMigrations();
  await ensureSegmentBuilderAgentToken();
  console.log("[server] Migrations applied.");
  const uiGraphFlags = describeUiGraphRuntimeFlags();
  console.log(`[server] UI graph runtime mode=${uiGraphFlags.mode} selectorFirst=${uiGraphFlags.selectorFirst} graphRuntime=${uiGraphFlags.graphRuntime} aiRecovery=${uiGraphFlags.aiRecovery} candidateLearning=${uiGraphFlags.candidateLearning} autoPromotion=${uiGraphFlags.autoPromotion}.`);
  // UI graph data is migration/catalog owned. Startup never imports semantic
  // definitions from repository files.

  // PNQ-001 observe mode still requires authoritative queue schema.
  await deviceExecutionArbiter.validateSchema();
  console.log("[server] Device execution arbiter schema verified.");
  const pnqV2RuntimeConfig = describePnqV2RuntimeConfig();
  console.log(`[server] Queue v2 runtime mode=${pnqV2RuntimeConfig.mode} (restart required to change).`);
  if (isPnqV2ShadowRuntimeEnabled()) {
    const summary = await pnqV2RuntimeService.reconcileStartup();
    console.log(`[server] Queue v2 shadow startup reconciliation: ok=${summary.ok} error=${summary.observed_error ?? "none"}.`);
  }

  // First move every pre-restart in-flight root into the fail-closed
  // reconciliation state. Terminal workflow cleanup below deliberately only
  // acts on blocked/reconciling roots with complete database evidence; running
  // it before this transition leaves old claimed/dispatching/dispatched roots
  // invisible to cleanup and blocks every successor on the device forever.
  const deviceExecutionReconciliation = isDeviceExecutionEnforced()
    ? await deviceExecutionArbiter.reconcileInFlightAtStartup()
    : { reconciledRoots: 0, activeAmbiguousRoots: 0 };
  console.log(
    `[server] Device execution startup reconciliation: reconciled=${deviceExecutionReconciliation.reconciledRoots} ` +
    `ambiguousBeforeEvidenceCleanup=${deviceExecutionReconciliation.activeAmbiguousRoots}.`
  );

  const terminalWorkflowReconciliation = isDeviceExecutionEnforced()
    ? await deviceExecutionArbiter.reconcileTerminalServerWorkflowRoots()
    : { reconciledRoots: 0 };
  if (terminalWorkflowReconciliation.reconciledRoots > 0) {
    console.warn(
      `[device-execution] reconciled ${terminalWorkflowReconciliation.reconciledRoots} ` +
      "blocked server workflow root(s) with complete terminal database evidence",
    );
  }
  const undispatchedWorkflowReconciliation = isDeviceExecutionEnforced()
    ? await deviceExecutionArbiter.reconcileUndispatchedTimedOutServerWorkflows()
    : { reconciledRoots: 0 };
  if (undispatchedWorkflowReconciliation.reconciledRoots > 0) {
    console.warn(
      `[device-execution] reconciled ${undispatchedWorkflowReconciliation.reconciledRoots} ` +
      "server workflow root(s) whose child jobs timed out before device start",
    );
  }

  // ─── Verify Redis connection — required for BullMQ (dispatcher + workflows) ──
  {
    const { getRedis } = await import("./redis/client");
    const redisClient = getRedis();
    try {
      await redisClient.ping();
      console.log("[server] Redis connected.");
    } catch (err) {
      console.error(
        "[server] FATAL: Redis connection failed.\n" +
        `         Error: ${(err as Error).message}\n` +
        "         Redis is required for BullMQ (job dispatcher + workflow engine).\n" +
        "         Set REDIS_URL env var or start Redis on localhost:6379."
      );
      process.exit(1);
    }
  }

  // ─── IMEI auth v2: no token revocation set to restore ───────────────────
  // (authService.restoreRevocationSet removed — tokens eliminated in 005_imei_auth)

  // Workflow templates live in DB and are managed through /api/config/workflows.
  // Startup must not overwrite campaign/client workflow definitions.

  // ─── Seed system prompts (upsert — safe to run on every start) ─────────────
  await seedSystemPrompts();

  // ─── Start workflow execution worker ─────────────────────────────────────
  startWorkflowWorker();
  console.log("[server] Workflow worker started.");
  startEdgeWorkflowProgressWatchdog();
  console.log("[server] Edge workflow progress watchdog started.");

  // ─── Kill switch — warm up cache from DB (makes isKillSwitchActiveSync reliable) ──
  const ksActive = await isKillSwitchActive();
  if (ksActive) console.warn("[server] ⚠️ Kill switch is ACTIVE from previous session");

  // ─── Canary rollout evaluation — every 5 min ─────────────────────────────
  setInterval(() => {
    canaryService.processRollouts().catch(err =>
      console.error("[canary] Process rollouts error:", (err as Error).message)
    );
  }, 5 * 60_000);

  // ─── Rate limit recovery — every 5 min (survives restarts, no setTimeout) ──
  setInterval(() => {
    lifecycleManager.resumeExpiredRateLimits().catch(err =>
      console.error("[lifecycle] Rate limit recovery error:", (err as Error).message)
    );
  }, 5 * 60_000);
  // Run once at startup to recover any expired cooldowns from before restart
  lifecycleManager.resumeExpiredRateLimits().catch(() => {});

  // ─── Ops Monitor — creates skill_update_jobs based on cascade-tap metrics ─
  startOpsMonitorScheduler(60 * 60 * 1000); // Run every 1 hour

  // ─── Express app ──────────────────────────────────────────────────────────
  const app = express();

  app.use(cors({
    origin: process.env.DASHBOARD_ORIGIN ?? true,  // true = reflect request origin
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Api-Key", "Authorization"],
    credentials: true,
  }));

  app.use(express.json({ limit: "1mb" }));
  app.use("/api/segment-builder", segmentBuilderRoutes);
  app.use("/api/device-tokens", deviceTokenRouter);
  app.use("/api", apiRouter);
  app.use("/api/workflow-runs", workflowRunRouter);
  app.use("/api/agency", agencyRouter);
  // Generic data-driven workflow control plane.
  app.use("/api/hydra/workflow", workflowDispatchRoutes);
  // Workflow compiler — compile-and-run, compile, run-compiled, compiled/:id
  app.use("/api/hydra/workflow", compilerRoutes);
  app.use("/api/mapping", mappingRoutes);
  app.use("/api/ui-graph", uiGraphRoutes);
  app.use("/api/config", configRoutes);
  app.use("/api/vlm", vlmRouter);

  // ─── APK download endpoints ───────────────────────────────────────────────
  // GET /app → serves latest agent APK for device onboarding (no auth required)
  const apkPath = process.env.APK_PATH ?? path.join(__dirname, "../../apk/phone-network.apk");
  app.get("/app", (_req, res) => {
    res.download(apkPath, "phone-network.apk", (err) => {
      if (err) res.status(404).json({ ok: false, error: "APK not found" });
    });
  });
  
  // GET /apk/:filename → serves specific APK from apk/ folder
  const apkDir = path.join(__dirname, "../../apk");
  app.get("/apk/:filename", (_req, res) => {
    const filename = _req.params.filename;
    const filePath = path.join(apkDir, filename);
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).json({ ok: false, error: "APK not found" });
    });
  });

  // ─── Dashboard static files ───────────────────────────────────────────────
  // __dirname in compiled dist: dist/src/
  // Two levels up to project root: ../../dashboard-dist
  const dashboardDist = process.env.DASHBOARD_DIST
    ?? path.resolve(__dirname, "../../dashboard-dist");
  app.use(express.static(dashboardDist));
  app.get("*", (req, res, next) => {
    // Skip WebSocket upgrade requests and API routes
    if (req.path === "/ws" || req.path.startsWith("/api/")) {
      return next();
    }
    res.sendFile(path.join(dashboardDist, "index.html"));
  });

  // ─── HTTP server ──────────────────────────────────────────────────────────
  const httpServer = http.createServer(app);

  // ─── Transport layer — route all WebSocket upgrades from one listener ─────
  directWsServer.attach();
  dashboardWorkflowWsServer.attach();
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;
    if (pathname === "/ws-direct") {
      directWsServer.handleUpgrade(req, socket, head);
      return;
    }
    if (pathname === "/ws-dashboard") {
      dashboardWorkflowWsServer.handleUpgrade(req, socket, head);
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  console.log("[server] DirectWs transport attached on /ws-direct");
  console.log("[server] Dashboard workflow stream attached on /ws-dashboard");
  const queueSweepTimer = isDeviceExecutionEnforced()
    ? setInterval(() => {
        sweepQueuedJobsForOnlineDevices("periodic.queue_sweep").catch(err =>
          console.error("[device-execution] periodic queue sweep error:", (err as Error).message)
        );
      }, 30_000)
    : null;
  if (isDeviceExecutionEnforced()) {
    sweepQueuedJobsForOnlineDevices("startup.queue_pump").catch(err =>
      console.error("[device-execution] startup queue pump error:", (err as Error).message)
    );
  }
  if (queueSweepTimer) queueSweepTimer.unref();
  const segmentBuilderRecoveryTimer = setInterval(() => {
    segmentBuildJobService.sweepRecovery()
      .then((summary) => {
        if (summary.expiredCanaries > 0 || summary.redispatchedLeases > 0) {
          console.warn(
            `[segment-builder] recovery sweep expiredCanaries=${summary.expiredCanaries} ` +
            `redispatchedLeases=${summary.redispatchedLeases}`,
          );
        }
      })
      .catch(err =>
        console.error("[segment-builder] recovery sweep error:", (err as Error).message)
      );
  }, 30_000);
  segmentBuilderRecoveryTimer.unref();
  segmentBuildJobService.sweepRecovery().catch(err =>
    console.error("[segment-builder] startup recovery sweep error:", (err as Error).message)
  );
  if (isPnqV2ShadowRuntimeEnabled()) {
    pnqV2RuntimeService.startPeriodicSweep();
  }

  // ─── Startup check: warn if no openclaw_agent API token ────────────────────
  {
    const { rows } = await getDb().query(
      `SELECT 1 FROM api_tokens WHERE purpose = 'openclaw_agent' AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`
    );
    if (rows.length === 0) {
      console.warn("[device-tokens] No openclaw_agent token found. Generate one via POST /api/device-tokens/generate");
    } else {
      console.log("[device-tokens] openclaw_agent token present.");
    }
  }

  // ─── Start listening ──────────────────────────────────────────────────────
  httpServer.listen(PORT, () => {
    console.log(`[server] Listening on :${PORT}`);
    console.log(`[server] DirectWs endpoint: ws://localhost:${PORT}/ws-direct`);
    console.log(`[server] Dashboard workflow endpoint: ws://localhost:${PORT}/ws-dashboard`);
    console.log(`[server] REST API: http://localhost:${PORT}/api`);
  });

  if (process.env.TASK_RUNNER_AUTOSTART !== "false") {
    startTaskRunner({
      pollIntervalMs: Number(process.env.TASK_RUNNER_POLL_INTERVAL_MS ?? 30_000),
      minGapBetweenTasksMs: Number(process.env.TASK_RUNNER_MIN_GAP_MS ?? 60_000),
      batchSize: Number(process.env.TASK_RUNNER_BATCH_SIZE ?? 10),
    });
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[server] ${signal} received — shutting down...`);
    httpServer.close();
    if (queueSweepTimer) clearInterval(queueSweepTimer);
    clearInterval(segmentBuilderRecoveryTimer);
    if (isPnqV2ShadowRuntimeEnabled()) {
      await pnqV2RuntimeService.close();
    }
    await directWsServer.close();
    await dashboardWorkflowWsServer.close();
    await dispatcherService.close();
    // Workflow worker cleanup handled by BullMQ process exit hooks
    await closeRedis();
    await closeDb();
    console.log("[server] Goodbye.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
