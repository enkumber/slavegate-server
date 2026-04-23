/**
 * api/device-tokens.routes.ts
 * API token management — generate, list, revoke, verify tokens for programmatic access.
 *
 * Tokens are stored as SHA-256 hashes. The raw token is returned ONLY at generation time.
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../db/client";

const router = Router();

const VALID_PURPOSES = ["openclaw_agent", "admin", "monitoring"] as const;
type Purpose = (typeof VALID_PURPOSES)[number];

// ─── Auth middleware (same pattern as routes.ts requireAuth) ──────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.API_KEY) return next();

  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    // Verify JWT (same logic as routes.ts)
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const parts = token.split(".");
      if (parts.length !== 3) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const sig = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
      if (sig !== parts[2]) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        res.status(401).json({ ok: false, error: "Token expired" }); return;
      }
      return next();
    } catch {
      res.status(401).json({ ok: false, error: "Unauthorized" }); return;
    }
  }

  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ─── POST /generate — create a new API token ─────────────────────────────────

router.post("/generate", requireAuth, async (req: Request, res: Response) => {
  try {
    const { purpose } = req.body as { purpose?: string };
    if (!purpose || !VALID_PURPOSES.includes(purpose as Purpose)) {
      res.status(400).json({ ok: false, error: `Invalid purpose. Valid: ${VALID_PURPOSES.join(", ")}` });
      return;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const db = getDb();
    const result = await db.query(
      `INSERT INTO api_tokens (token_hash, purpose, expires_at) VALUES ($1, $2, $3) RETURNING id, purpose, expires_at, created_at`,
      [tokenHash, purpose, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        id: result.rows[0].id,
        token: rawToken, // Only returned at generation!
        purpose: result.rows[0].purpose,
        expires_at: result.rows[0].expires_at,
        created_at: result.rows[0].created_at,
      },
    });
  } catch (err) {
    console.error("[device-tokens] Generate error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "Failed to generate token" });
  }
});

// ─── GET /list — list all active tokens ───────────────────────────────────────

router.get("/list", requireAuth, async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db.query(
      `SELECT id, token_hash, purpose, expires_at, created_at, revoked_at
       FROM api_tokens ORDER BY created_at DESC`
    );

    res.json({
      ok: true,
      data: result.rows.map((row) => ({
        id: row.id,
        token_hash_truncated: row.token_hash.slice(0, 12) + "…",
        purpose: row.purpose,
        expires_at: row.expires_at,
        created_at: row.created_at,
        revoked: !!row.revoked_at,
      })),
    });
  } catch (err) {
    console.error("[device-tokens] List error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "Failed to list tokens" });
  }
});

// ─── DELETE /:id — revoke a token ────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = await db.query(
      `UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ ok: false, error: "Token not found or already revoked" });
      return;
    }

    res.json({ ok: true, data: { id: result.rows[0].id } });
  } catch (err) {
    console.error("[device-tokens] Revoke error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "Failed to revoke token" });
  }
});

// ─── POST /verify — check if a token is valid ────────────────────────────────

router.post("/verify", async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ ok: false, error: "Missing token" });
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const db = getDb();
    const result = await db.query(
      `SELECT id, purpose, expires_at, revoked_at FROM api_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      res.json({ ok: true, data: { valid: false } });
      return;
    }

    const row = result.rows[0];
    const valid = !row.revoked_at && new Date(row.expires_at) > new Date();

    res.json({
      ok: true,
      data: {
        valid,
        purpose: valid ? row.purpose : undefined,
        expires_at: valid ? row.expires_at : undefined,
      },
    });
  } catch (err) {
    console.error("[device-tokens] Verify error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "Failed to verify token" });
  }
});

export default router;
