/**
 * api/agency-routes.ts
 * REST API routes for Marketing Agency — clients, materials, posts, tasks, reports.
 */

import { Router, Request, Response } from "express";
import { requireAdminAuth } from "./auth.middleware";
import { getDb } from "../db/client";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { workflowEvents } from "../modules/workflow-events";

const router = Router();

const SPRINT_2_READ_ONLY_INTENTS = new Set(["reddit_account_health_scan"]);

const GENERATED_WORKFLOW_KEY_RE = /^[a-f0-9]{24}$/;

function publishAgencyWorkflowQueued(input: {
  agencyWorkflowRunId: string;
  taskId: string;
  clientId: string;
  accountId: string;
  deviceId: string;
  intent: string;
  platform?: string;
}): void {
  workflowEvents.publish({
    source: "agency",
    event: "queued",
    taskId: input.taskId,
    agencyWorkflowRunId: input.agencyWorkflowRunId,
    clientId: input.clientId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    mode: "edge",
    status: "queued",
    message: "Generated workflow task queued",
    details: {
      intent: input.intent,
      platform: input.platform,
    },
  });
}

// ─── Pagination helper ────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, parseInt(query.page as string ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize as string ?? "50", 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function rowToAgencyWorkflowRun(row: Record<string, unknown>): Record<string, unknown> {
  const deviceId = row.device_id as string;
  return {
    id: row.id,
    clientId: row.client_id,
    accountId: row.account_id,
    deviceId,
    shortDeviceId: deviceId?.slice(0, 8),
    taskId: row.task_id ?? null,
    workflowId: row.workflow_id ?? null,
    platform: row.platform,
    intent: row.intent,
    safetyClass: row.safety_class,
    requestKey: row.request_key ?? null,
    cacheKey: row.cache_key ?? null,
    canonicalWorkflowId: row.canonical_workflow_id,
    canonicalWorkflowVersion: row.canonical_workflow_version,
    compiledPlanHash: row.compiled_plan_hash,
    status: row.status,
    output: row.output ?? {},
    tokenUsage: row.token_usage ?? {},
    recoveryRequests: row.recovery_requests ?? 0,
    error: row.error ?? null,
    context: row.context ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ?? null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ?? null,
    accountUsername: row.account_username ?? null,
    accountPlatform: row.account_platform ?? null,
    clientName: row.client_name ?? null,
    deviceName: row.device_name ?? null,
  };
}

function cachedWorkflowLlmHappyPathRequests(cached: Record<string, unknown>): number | null {
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const llmBudget = compiledPlan?.llmBudget as Record<string, unknown> | undefined;
  return typeof llmBudget?.happyPathRequests === "number" ? llmBudget.happyPathRequests : null;
}

function cachedWorkflowSafetyClass(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.safetyClass ?? workflow?.safetyClass ?? sourceMetadata?.safetyClass ?? null) as string | null;
}

function cachedWorkflowIntent(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  const compiledPlan = (cached.compiled_plan ?? cached.compiledPlan) as Record<string, unknown> | null;
  const metadata = compiledPlan?.metadata as Record<string, unknown> | undefined;
  const sourceMetadata = (cached.source_metadata ?? cached.sourceMetadata) as Record<string, unknown> | null;
  return (metadata?.intent ?? workflow?.intent ?? sourceMetadata?.intent ?? null) as string | null;
}

function cachedWorkflowPlatform(cached: Record<string, unknown>): string | null {
  const workflow = cached.workflow as Record<string, unknown> | null;
  return (cached.platform ?? workflow?.platform ?? null) as string | null;
}

function agencyWorkflowRunSelectSql(where: string): string {
  return `SELECT r.*,
                 COALESCE(t.status, r.status) AS status,
                 a.username AS account_username,
                 a.platform AS account_platform,
                 c.name AS client_name,
                 d.friendly_name AS device_name
          FROM agency_workflow_runs r
          LEFT JOIN tasks t ON t.id = r.task_id
          LEFT JOIN accounts a ON a.id = r.account_id
          LEFT JOIN clients c ON c.id = r.client_id
          LEFT JOIN devices d ON d.id = r.device_id
          ${where ? `WHERE ${where.replace(/^WHERE\s+/i, "")}` : ""}`;
}

async function hydrateAgencyWorkflowRun(db: ReturnType<typeof getDb>, runId: string): Promise<Record<string, unknown> | null> {
  const hydrated = await db.query(
    agencyWorkflowRunSelectSql(`r.id = $1`),
    [runId]
  );
  return hydrated.rows[0] ?? null;
}

// ─── File upload config ───────────────────────────────────────────────────────

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads/materials";

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|mov|webm|txt|md)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/clients", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const activeOnly = req.query.active === "true";
  const type = req.query.type as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (activeOnly) {
    conditions.push(`active = TRUE`);
  }
  if (type) {
    conditions.push(`type = $${idx++}`);
    values.push(type);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  
  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM clients ${where} ORDER BY name ASC LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM clients ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/clients/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const result = await db.query("SELECT * FROM clients WHERE id = $1", [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Client not found" });
  }
  res.json({ ok: true, data: result.rows[0] });
});

router.post("/clients", async (req: Request, res: Response) => {
  const db = getDb();
  const { name, strategy = {}, type = 'client' } = req.body as { 
    name: string; 
    strategy?: Record<string, unknown>;
    type?: 'client' | 'farming';
  };

  if (!name?.trim()) {
    return res.status(400).json({ ok: false, error: "name required" });
  }

  if (!['client', 'farming'].includes(type)) {
    return res.status(400).json({ ok: false, error: "type must be 'client' or 'farming'" });
  }

  const result = await db.query(
    `INSERT INTO clients (name, strategy, type) VALUES ($1, $2, $3) RETURNING *`,
    [name.trim(), JSON.stringify(strategy), type]
  );

  res.status(201).json({ ok: true, data: result.rows[0] });
});

router.patch("/clients/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { name, active, strategy } = req.body as {
    name?: string;
    active?: boolean;
    strategy?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(name.trim());
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }
  if (strategy !== undefined) {
    updates.push(`strategy = $${idx++}`);
    values.push(JSON.stringify(strategy));
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  updates.push(`updated_at = NOW()`);
  values.push(req.params.id);

  const result = await db.query(
    `UPDATE clients SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Client not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MATERIALS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/materials", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const clientId = req.query.clientId as string | undefined;
  const usedFilter = req.query.used as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (clientId) {
    conditions.push(`client_id = $${idx++}`);
    values.push(clientId);
  }
  if (usedFilter === "true" || usedFilter === "false") {
    conditions.push(`used = $${idx++}`);
    values.push(usedFilter === "true");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT m.*, c.name as client_name 
       FROM materials m 
       LEFT JOIN clients c ON m.client_id = c.id 
       ${where} 
       ORDER BY m.uploaded_at DESC 
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM materials ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.post("/materials", upload.single("file"), async (req: Request, res: Response) => {
  const db = getDb();
  const file = req.file;

  if (!file) {
    return res.status(400).json({ ok: false, error: "file required" });
  }

  const { clientId, accountId, description } = req.body as {
    clientId?: string;
    accountId?: string;
    description?: string;
  };

  // Determine type from mimetype
  let type: "image" | "video" | "text" = "text";
  if (file.mimetype.startsWith("image/")) type = "image";
  else if (file.mimetype.startsWith("video/")) type = "video";

  const url = `/uploads/materials/${file.filename}`;

  const result = await db.query(
    `INSERT INTO materials (client_id, account_id, type, url, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [clientId || null, accountId || null, type, url, description || null]
  );

  res.status(201).json({ ok: true, data: result.rows[0] });
});

router.patch("/materials/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { used, description } = req.body as { used?: boolean; description?: string };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (used !== undefined) {
    updates.push(`used = $${idx++}`);
    values.push(used);
  }
  if (description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(description);
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  values.push(req.params.id);

  const result = await db.query(
    `UPDATE materials SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Material not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

router.delete("/materials/:id", async (req: Request, res: Response) => {
  const db = getDb();

  // Get file path first
  const existing = await db.query("SELECT url FROM materials WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Material not found" });
  }

  // Delete from DB
  await db.query("DELETE FROM materials WHERE id = $1", [req.params.id]);

  // Try to delete file (non-fatal if fails)
  const filePath = path.join(UPLOAD_DIR, path.basename(existing.rows[0].url));
  await fs.unlink(filePath).catch(() => {});

  res.json({ ok: true, data: { deleted: true } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/posts", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = req.query.status as string | undefined;
  const accountId = req.query.accountId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`p.status = $${idx++}`);
    values.push(status);
  }
  if (accountId) {
    conditions.push(`p.account_id = $${idx++}`);
    values.push(accountId);
  }
  if (from) {
    conditions.push(`p.created_at >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`p.created_at <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT p.*, a.username as account_username, a.platform as account_platform
       FROM posts p
       LEFT JOIN accounts a ON p.account_id = a.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM posts p ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.get("/posts/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const result = await db.query(
    `SELECT p.*, a.username as account_username, a.platform as account_platform
     FROM posts p
     LEFT JOIN accounts a ON p.account_id = a.id
     WHERE p.id = $1`,
    [req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Post not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

router.patch("/posts/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { status, content } = req.body as {
    status?: "pending_approval" | "approved" | "rejected" | "published";
    content?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status !== undefined) {
    updates.push(`status = $${idx++}`);
    values.push(status);

    // Set timestamps based on status
    if (status === "approved") {
      updates.push(`approved_at = NOW()`);
    } else if (status === "published") {
      updates.push(`published_at = NOW()`);
    }
  }

  if (content !== undefined) {
    updates.push(`content = $${idx++}`);
    values.push(JSON.stringify(content));
  }

  if (updates.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update" });
  }

  values.push(req.params.id);

  const result = await db.query(
    `UPDATE posts SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Post not found" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOW RUNS — Control-plane runs for existing canonical generated workflows
// ═══════════════════════════════════════════════════════════════════════════════

router.post("/reddit/account-health-scans", async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as {
    clientId?: string;
    accountId?: string;
    deviceId?: string;
    scheduledTime?: string;
    context?: Record<string, unknown>;
  };

  if (!body.accountId || !body.deviceId) {
    return res.status(400).json({ ok: false, error: "accountId and deviceId required" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const accountResult = await client.query<{
      id: string;
      client_id: string | null;
      platform: string;
      username: string | null;
    }>(
      `SELECT id, client_id, platform, username FROM accounts WHERE id = $1`,
      [body.accountId],
    );
    const account = accountResult.rows[0];
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Account not found" });
    }
    if (account.platform !== "reddit") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_PLATFORM_NOT_REDDIT",
        error: "Reddit account health scans require a reddit account",
      });
    }
    if (account.client_id && body.clientId && account.client_id !== body.clientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_CLIENT_MISMATCH",
        error: "Account is linked to a different client",
      });
    }

    const resolvedClientId = account.client_id ?? body.clientId;
    if (!resolvedClientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "ACCOUNT_CLIENT_REQUIRED",
        error: "Account must be linked to a client or clientId must be supplied",
      });
    }

    const cacheResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM generated_workflow_plan_cache
       WHERE platform = 'reddit'
         AND artifact_state = 'promoted'
         AND COALESCE(compiled_plan #>> '{metadata,intent}', workflow ->> 'intent', source_metadata ->> 'intent') = 'reddit_account_health_scan'
         AND COALESCE(compiled_plan #>> '{metadata,safetyClass}', workflow ->> 'safetyClass', source_metadata ->> 'safetyClass') = 'read_only'
         AND COALESCE(compiled_plan #>> '{llmBudget,happyPathRequests}', '') = '0'
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        code: "REDDIT_HEALTH_SCAN_WORKFLOW_NOT_READY",
        error: "No cache-safe reddit_account_health_scan workflow artifact found",
      });
    }

    const runContext = {
      ...(body.context ?? {}),
      source: "agency_reddit_account_health_scan",
      clientId: resolvedClientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: "reddit_account_health_scan",
      accountUsername: account.username,
      requiresScreenshotArtifact: true,
      requiresRealClassifierOutput: true,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
       VALUES ($1, $2, $3, 'reddit', 'reddit_account_health_scan', 'read_only', NULL, $4, $5, $6, $7, 'queued', $8)
      RETURNING id`,
      [
        resolvedClientId,
        body.accountId,
        body.deviceId,
        cached.cache_key,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
      ],
    );
    const runId = runResult.rows[0].id;

    const taskParams = {
      cacheKey: cached.cache_key,
      clientId: resolvedClientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: "reddit_account_health_scan",
      source: "agency_reddit_account_health_scan",
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        body.accountId,
        body.deviceId,
        JSON.stringify(taskParams),
        body.scheduledTime ?? new Date().toISOString(),
      ],
    );
    const taskId = taskResult.rows[0].id;

    await client.query(
      `UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`,
      [taskId, runId],
    );

    const hydrated = await hydrateAgencyWorkflowRun(client as unknown as ReturnType<typeof getDb>, runId);
    await client.query("COMMIT");
    publishAgencyWorkflowQueued({
      agencyWorkflowRunId: runId,
      taskId,
      clientId: resolvedClientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: "reddit_account_health_scan",
      platform: "reddit",
    });
    res.status(201).json({ ok: true, data: rowToAgencyWorkflowRun(hydrated!) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.post("/workflow-runs", requireAdminAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as {
    clientId?: string;
    accountId?: string;
    deviceId?: string;
    intent?: string;
    requestKey?: string;
    cacheKey?: string;
    scheduledTime?: string;
    context?: Record<string, unknown>;
    workflow?: unknown;
  };

  if (Object.prototype.hasOwnProperty.call(body, "workflow")) {
    return res.status(400).json({
      ok: false,
      code: "WORKFLOW_PAYLOAD_NOT_ALLOWED",
      error: "workflow payload is not allowed for agency workflow runs",
    });
  }
  if (!body.clientId || !body.accountId || !body.deviceId || !body.intent) {
    return res.status(400).json({ ok: false, error: "clientId, accountId, deviceId and intent required" });
  }
  if (!SPRINT_2_READ_ONLY_INTENTS.has(body.intent)) {
    return res.status(400).json({
      ok: false,
      code: "GENERATED_WORKFLOW_INTENT_NOT_ALLOWED",
      error: "Sprint 2 agency workflow runs only accept read_only marketing scan intents",
    });
  }

  const hasRequestKey = typeof body.requestKey === "string" && body.requestKey.length > 0;
  const hasCacheKey = typeof body.cacheKey === "string" && body.cacheKey.length > 0;
  if ((hasRequestKey ? 1 : 0) + (hasCacheKey ? 1 : 0) !== 1) {
    return res.status(400).json({
      ok: false,
      code: "EXACTLY_ONE_CANONICAL_KEY_REQUIRED",
      error: "exactly one of requestKey or cacheKey required",
    });
  }
  if (hasRequestKey && !GENERATED_WORKFLOW_KEY_RE.test(body.requestKey!)) {
    return res.status(400).json({ ok: false, error: "requestKey must be a 24-character lowercase hex string" });
  }
  if (hasCacheKey && !GENERATED_WORKFLOW_KEY_RE.test(body.cacheKey!)) {
    return res.status(400).json({ ok: false, error: "cacheKey must be a 24-character lowercase hex string" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cacheResult = await client.query<Record<string, unknown>>(
      hasCacheKey
        ? `SELECT * FROM generated_workflow_plan_cache
           WHERE cache_key = $1
             AND artifact_state = 'promoted'`
        : `SELECT * FROM generated_workflow_plan_cache
           WHERE request_key = $1
             AND artifact_state = 'promoted'
           ORDER BY updated_at DESC
           LIMIT 1`,
      [hasCacheKey ? body.cacheKey : body.requestKey]
    );
    const cached = cacheResult.rows[0];
    if (!cached) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        code: "GENERATED_WORKFLOW_CACHE_MISS",
        error: "canonical generated workflow artifact not found",
      });
    }

    const safetyClass = cachedWorkflowSafetyClass(cached);
    if (safetyClass !== "read_only") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_NOT_READ_ONLY",
        error: "Sprint 2 agency workflow runs require safetyClass=read_only",
      });
    }

    const artifactIntent = cachedWorkflowIntent(cached);
    if (artifactIntent && artifactIntent !== body.intent) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_INTENT_MISMATCH",
        error: "intent does not match canonical generated workflow artifact",
      });
    }
    if (cachedWorkflowLlmHappyPathRequests(cached) !== 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_LLM_BUDGET_NOT_CACHE_SAFE",
        error: "canonical workflow happy path must avoid LLM calls",
      });
    }
    const platform = cachedWorkflowPlatform(cached);
    if (!platform) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        code: "GENERATED_WORKFLOW_PLATFORM_MISSING",
        error: "canonical workflow artifact is missing platform metadata",
      });
    }

    const runContext = {
      ...(body.context ?? {}),
      source: "agency_workflow_runs",
      clientId: body.clientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: body.intent,
    };
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO agency_workflow_runs
         (client_id, account_id, device_id, platform, intent, safety_class, request_key, cache_key,
          canonical_workflow_id, canonical_workflow_version, compiled_plan_hash, status, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12)
       RETURNING id`,
      [
        body.clientId,
        body.accountId,
        body.deviceId,
        platform,
        body.intent,
        safetyClass,
        hasRequestKey ? body.requestKey : null,
        hasCacheKey ? body.cacheKey : null,
        cached.canonical_workflow_id,
        cached.canonical_workflow_version,
        cached.compiled_plan_hash,
        JSON.stringify(runContext),
      ]
    );
    const runId = runResult.rows[0].id;

    const taskParams = {
      ...(hasRequestKey ? { requestKey: body.requestKey } : { cacheKey: body.cacheKey }),
      clientId: body.clientId,
      agencyWorkflowRunId: runId,
      workflowRunId: runId,
      intent: body.intent,
    };
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
       VALUES ($1, $2, 'generated_workflow', $3, $4, 'queued')
       RETURNING id`,
      [
        body.accountId,
        body.deviceId,
        JSON.stringify(taskParams),
        body.scheduledTime ?? new Date().toISOString(),
      ]
    );
    const taskId = taskResult.rows[0].id;

    await client.query(
      `UPDATE agency_workflow_runs SET task_id = $1, updated_at = NOW() WHERE id = $2`,
      [taskId, runId]
    );

    const hydrated = await client.query(
      agencyWorkflowRunSelectSql(`r.id = $1`),
      [runId]
    );
    await client.query("COMMIT");
    publishAgencyWorkflowQueued({
      agencyWorkflowRunId: runId,
      taskId,
      clientId: body.clientId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      intent: body.intent,
      platform,
    });
    res.status(201).json({ ok: true, data: rowToAgencyWorkflowRun(hydrated.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: (err as Error).message });
  } finally {
    client.release();
  }
});

router.get("/workflow-runs", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const filters = {
    clientId: req.query.clientId as string | undefined,
    accountId: req.query.accountId as string | undefined,
    deviceId: req.query.deviceId as string | undefined,
    intent: req.query.intent as string | undefined,
    status: req.query.status as string | undefined,
    taskId: req.query.taskId as string | undefined,
    requestKey: req.query.requestKey as string | undefined,
    cacheKey: req.query.cacheKey as string | undefined,
  };

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [field, value] of Object.entries(filters)) {
    if (!value) continue;
    const column = ({
      clientId: "r.client_id",
      accountId: "r.account_id",
      deviceId: "r.device_id",
      intent: "r.intent",
      status: "COALESCE(t.status, r.status)",
      taskId: "r.task_id",
      requestKey: "r.request_key",
      cacheKey: "r.cache_key",
    } as Record<string, string>)[field];
    conditions.push(`${column} = $${idx++}`);
    values.push(value);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    db.query(
      `${agencyWorkflowRunSelectSql(where)}
       ORDER BY r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(`SELECT COUNT(*) FROM agency_workflow_runs r LEFT JOIN tasks t ON t.id = r.task_id ${where}`, values.slice(0, -2)),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows.map(rowToAgencyWorkflowRun),
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.post("/workflow-runs/purge-failed", requireAdminAuth, async (req: Request, res: Response) => {
  const confirm = req.body?.confirm === true;
  const db = getDb();

  if (!confirm) {
    const [runs, compileJobs, cacheArtifacts] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM agency_workflow_runs r
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'failed'
            OR t.status = 'failed'`
      ),
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM human_workflow_compile_jobs
         WHERE status IN ('failed', 'cancelled')`
      ),
      db.query(
        `WITH failed_handles AS (
           SELECT request_key, cache_key
           FROM human_workflow_compile_jobs
           WHERE status IN ('failed', 'cancelled')

           UNION

           SELECT r.request_key, r.cache_key
           FROM agency_workflow_runs r
           LEFT JOIN tasks t ON t.id = r.task_id
           WHERE r.status = 'failed'
              OR t.status = 'failed'
         )
         SELECT COUNT(DISTINCT c.cache_key)::int AS count
         FROM generated_workflow_plan_cache c
         LEFT JOIN failed_handles h
           ON (h.request_key IS NOT NULL AND c.request_key = h.request_key)
           OR (h.cache_key IS NOT NULL AND c.cache_key = h.cache_key)
         WHERE c.artifact_state IN ('failed', 'quarantined')
            OR h.request_key IS NOT NULL
            OR h.cache_key IS NOT NULL`
      ),
    ]);

    return res.json({
      ok: true,
      data: {
        dryRun: true,
        failedWorkflowRuns: runs.rows[0]?.count ?? 0,
        failedCompileJobs: compileJobs.rows[0]?.count ?? 0,
        generatedCacheArtifacts: cacheArtifacts.rows[0]?.count ?? 0,
      },
    });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const cacheArtifacts = await client.query(
      `WITH failed_handles AS (
         SELECT request_key, cache_key
         FROM human_workflow_compile_jobs
         WHERE status IN ('failed', 'cancelled')

         UNION

         SELECT r.request_key, r.cache_key
         FROM agency_workflow_runs r
         LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status = 'failed'
            OR t.status = 'failed'
       ),
       deleted AS (
         DELETE FROM generated_workflow_plan_cache c
         USING failed_handles h
         WHERE (h.request_key IS NOT NULL AND c.request_key = h.request_key)
            OR (h.cache_key IS NOT NULL AND c.cache_key = h.cache_key)
         RETURNING c.cache_key
       ),
       state_deleted AS (
         DELETE FROM generated_workflow_plan_cache c
         WHERE c.artifact_state IN ('failed', 'quarantined')
           AND NOT EXISTS (SELECT 1 FROM deleted d WHERE d.cache_key = c.cache_key)
         RETURNING c.cache_key
       )
       SELECT
         (SELECT COUNT(*)::int FROM deleted) +
         (SELECT COUNT(*)::int FROM state_deleted) AS count`
    );

    const compileJobs = await client.query(
      `DELETE FROM human_workflow_compile_jobs
       WHERE status IN ('failed', 'cancelled')
       RETURNING id`
    );

    const workflowRuns = await client.query(
      `DELETE FROM agency_workflow_runs r
       WHERE r.status = 'failed'
          OR EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.id = r.task_id
              AND t.status = 'failed'
          )
       RETURNING id`
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      data: {
        dryRun: false,
        failedWorkflowRuns: workflowRuns.rowCount ?? 0,
        failedCompileJobs: compileJobs.rowCount ?? 0,
        generatedCacheArtifacts: cacheArtifacts.rows[0]?.count ?? 0,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      ok: false,
      error: (err as Error).message,
    });
  } finally {
    client.release();
  }
});

router.get("/workflow-runs/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const result = await db.query(agencyWorkflowRunSelectSql(`r.id = $1`), [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Workflow run not found" });
  }
  res.json({ ok: true, data: rowToAgencyWorkflowRun(result.rows[0]) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/tasks", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = req.query.status as string | undefined;
  const deviceId = req.query.deviceId as string | undefined;
  const accountId = req.query.accountId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`t.status = $${idx++}`);
    values.push(status);
  }
  if (deviceId) {
    conditions.push(`t.device_id = $${idx++}`);
    values.push(deviceId);
  }
  if (accountId) {
    conditions.push(`t.account_id = $${idx++}`);
    values.push(accountId);
  }
  if (from) {
    conditions.push(`t.scheduled_time >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`t.scheduled_time <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT t.*, 
              a.username as account_username, 
              a.platform as account_platform,
              d.friendly_name as device_name
       FROM tasks t
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN devices d ON t.device_id = d.id
       ${where}
       ORDER BY t.scheduled_time DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM tasks t ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

router.patch("/tasks/:id", async (req: Request, res: Response) => {
  const db = getDb();
  const { status } = req.body as { status: "paused" | "queued" };

  if (!["paused", "queued"].includes(status)) {
    return res.status(400).json({ ok: false, error: "status must be 'paused' or 'queued'" });
  }

  const result = await db.query(
    `UPDATE tasks SET status = $1 WHERE id = $2 AND status IN ('queued', 'paused') RETURNING *`,
    [status, req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ ok: false, error: "Task not found or not modifiable" });
  }

  res.json({ ok: true, data: result.rows[0] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/reports", async (req: Request, res: Response) => {
  const db = getDb();
  const { page, pageSize, offset } = parsePagination(req.query);
  const type = req.query.type as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (type) {
    conditions.push(`type = $${idx++}`);
    values.push(type);
  }
  if (from) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  values.push(pageSize, offset);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      values
    ),
    db.query(
      `SELECT COUNT(*) FROM reports ${where}`,
      values.slice(0, -2)
    ),
  ]);

  res.json({
    ok: true,
    data: {
      items: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      page,
      pageSize,
    },
  });
});

// Aggregated stats for dashboard
router.get("/reports/stats", async (_req: Request, res: Response) => {
  const db = getDb();

  const [clients, posts, tasks, materials] = await Promise.all([
    db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE active) as active FROM clients"),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending_approval') as pending,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'published') as published,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected
      FROM posts
    `),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'queued') as queued,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM tasks
    `),
    db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE used) as used,
        COUNT(*) FILTER (WHERE NOT used) as unused
      FROM materials
    `),
  ]);

  res.json({
    ok: true,
    data: {
      clients: clients.rows[0],
      posts: posts.rows[0],
      tasks: tasks.rows[0],
      materials: materials.rows[0],
    },
  });
});

// ─── Creative Workflow E2E ───
import { createCreativeWorkflowRun } from "../modules/creative-workflows/creative-workflow.service";

router.post("/creative-workflows", async (req, res) => {
  const { clientId, accountId, deviceId, objective, dryRun } = req.body || {};
  const result = await createCreativeWorkflowRun({ clientId, accountId, deviceId, objective, dryRun: dryRun ?? false });
  const status = result.status === "queued"
    ? 201
    : result.code === "CREATIVE_WORKFLOW_MISSING_FIELDS"
      ? 400
      : result.status === "not_ready"
        ? 409
        : 200;
  res.status(status).json({ ok: result.status !== "not_ready", code: result.code, data: result });
});

export default router;
