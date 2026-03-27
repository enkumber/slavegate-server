/**
 * api/agency-routes.ts
 * REST API routes for Marketing Agency — clients, materials, posts, tasks, reports.
 */

import { Router, Request, Response } from "express";
import { getDb } from "../db/client";
import multer from "multer";
import path from "path";
import fs from "fs/promises";

const router = Router();

// ─── Pagination helper ────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, parseInt(query.page as string ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize as string ?? "50", 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
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

  const where = activeOnly ? "WHERE active = TRUE" : "";
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT * FROM clients ${where} ORDER BY name ASC LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    ),
    db.query(`SELECT COUNT(*) FROM clients ${where}`),
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
  const { name, strategy = {} } = req.body as { name: string; strategy?: Record<string, unknown> };

  if (!name?.trim()) {
    return res.status(400).json({ ok: false, error: "name required" });
  }

  const result = await db.query(
    `INSERT INTO clients (name, strategy) VALUES ($1, $2) RETURNING *`,
    [name.trim(), JSON.stringify(strategy)]
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

export default router;
