/**
 * api/config-routes.ts
 * Runtime-editable configuration endpoints for prompts and workflow templates.
 * All endpoints behind existing X-API-Key / JWT auth.
 */

import { Router, Request, Response } from "express";
import { getDb } from "../db/client";
import { workflowService } from "../modules/workflows/workflow.service";
import { PLANNER_SYSTEM_PROMPT } from "../modules/agents/prompts/planner.prompt";

const router = Router();

// Auth middleware — same pattern as routes.ts
function requireAuth(req: Request, res: Response, next: Function): void {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.API_KEY) return next();

  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    // JWT verification — simplified, relies on main routes.ts pattern
    // For config routes, we accept both API key and JWT
    const crypto = require("crypto");
    const token = authHeader.slice(7);
    try {
      const [header, body, sig] = token.split(".");
      if (!header || !body || !sig) return void res.status(401).json({ ok: false, error: "Unauthorized" });
      const secret = process.env.JWT_SECRET;
      if (!secret) return void res.status(401).json({ ok: false, error: "Unauthorized" });
      const expectedSig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return void res.status(401).json({ ok: false, error: "Unauthorized" });
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      if (payload.exp < Math.floor(Date.now() / 1000)) return void res.status(401).json({ ok: false, error: "Unauthorized" });
      return next();
    } catch {
      return void res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  res.status(401).json({ ok: false, error: "Unauthorized" });
}

router.use(requireAuth as any);

// ─── System Prompts ───────────────────────────────────────────────────────────

/**
 * GET /api/config/prompts
 * List all system prompts stored in DB.
 */
router.get("/prompts", async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db.query(
      "SELECT key, content, updated_at FROM system_prompts ORDER BY key"
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("[config/prompts] List error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * GET /api/config/prompts/:key
 * Get a single system prompt by key.
 */
router.get("/prompts/:key", async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db.query(
      "SELECT key, content, updated_at FROM system_prompts WHERE key = $1",
      [req.params.key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Prompt not found: ${req.params.key}` });
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("[config/prompts] Get error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * PUT /api/config/prompts/:key
 * Update a system prompt by key. Body: { content: "..." }
 * Upserts — creates if doesn't exist.
 */
router.put("/prompts/:key", async (req: Request, res: Response) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "content (string) required" });
    }
    const key = req.params.key;
    const db = getDb();
    const result = await db.query(
      `INSERT INTO system_prompts (key, content, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
       RETURNING key, content, updated_at`,
      [key, content]
    );
    console.log(`[config/prompts] Updated prompt: ${key} (${content.length} chars)`);
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("[config/prompts] Update error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Workflow Templates ───────────────────────────────────────────────────────

/**
 * GET /api/config/workflows
 * List all workflow templates. Delegates to workflowService.listTemplates().
 */
router.get("/workflows", async (_req: Request, res: Response) => {
  try {
    const templates = await workflowService.listTemplates();
    res.json({ ok: true, data: templates });
  } catch (err) {
    console.error("[config/workflows] List error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * PUT /api/config/workflows/:id
 * Update a workflow template definition. Body: full JSON template object.
 */
router.put("/workflows/:id", async (req: Request, res: Response) => {
  try {
    const template = req.body;
    if (!template || typeof template !== "object") {
      return res.status(400).json({ ok: false, error: "Template JSON body required" });
    }
    // Ensure template.id matches the URL param
    if (template.id && template.id !== req.params.id) {
      return res.status(400).json({ ok: false, error: `Template body id "${template.id}" doesn't match URL param "${req.params.id}"` });
    }
    // Force id to match URL param
    template.id = req.params.id;
    await workflowService.saveTemplate(template);
    console.log(`[config/workflows] Updated template: ${req.params.id}`);
    res.json({ ok: true, data: { id: req.params.id, updated: true } });
  } catch (err) {
    console.error("[config/workflows] Update error:", (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Seed helper (called from index.ts on startup) ────────────────────────────

/**
 * Seed system_prompts table with hardcoded defaults.
 * Uses ON CONFLICT DO NOTHING so existing edits survive restarts.
 */
export async function seedSystemPrompts(): Promise<void> {
  const db = getDb();
  await db.query(
    `INSERT INTO system_prompts (key, content)
     VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    ["planner_system_prompt", PLANNER_SYSTEM_PROMPT]
  );
  console.log("[config/prompts] Seeded system prompts (ON CONFLICT DO NOTHING).");
}

/**
 * Load a system prompt from DB. Returns null if not found or on error.
 */
export async function loadSystemPrompt(key: string): Promise<string | null> {
  try {
    const db = getDb();
    const result = await db.query(
      "SELECT content FROM system_prompts WHERE key = $1",
      [key]
    );
    if (result.rows.length > 0) return result.rows[0].content;
    return null;
  } catch {
    return null;
  }
}

export default router;
