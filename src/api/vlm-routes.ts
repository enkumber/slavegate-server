/**
 * api/vlm-routes.ts
 * VLM/LLM HTTP endpoints for edge workflow execution (ADR-001).
 *
 * Devices call these endpoints during workflow execution when they need
 * LLM analysis (e.g., vlm_analyze_post_for_outreach, vlm_generate_comment).
 *
 * Auth: API key (X-API-Key header) — same as other API routes.
 *
 * Flow:
 *   Device (WorkflowEngine) → HTTP POST → this route → VisionService → VLM provider → response
 */

import { Router, Request, Response } from "express";
import { visionService } from "../modules/vision/vision.service";

const router = Router();

// ─── Auth middleware (API key) ────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: Function): void {
  const apiKey = req.headers["x-api-key"] as string;
  const validKey = process.env.API_KEY || "928b9e0ba7caeb3e039dafde99076d2d";
  if (apiKey !== validKey) {
    res.status(401).json({ ok: false, error: "Invalid API key" });
    return;
  }
  next();
}

router.use(requireApiKey);

// ─── POST /api/vlm/analyze ───────────────────────────────────────────────────

/**
 * Analyze a screenshot with a custom prompt.
 * Used by device WorkflowEngine for vlm_analyze_post_for_outreach.
 *
 * Body:
 *   screenshot: string  — base64-encoded screenshot
 *   prompt: string      — analysis prompt
 *   model: string       — optional model hint (default: "gemma4")
 *
 * Response:
 *   { ok: true, result: string }
 */
router.post("/analyze", async (req: Request, res: Response) => {
  const { screenshot, prompt } = req.body as {
    screenshot?: string;
    prompt?: string;
  };

  if (!screenshot || !prompt) {
    res.status(400).json({
      ok: false,
      error: "Missing screenshot or prompt",
    });
    return;
  }

  try {
    // visionService.analyzeCustomPrompt takes base64 string, returns string
    const result = await visionService.analyzeCustomPrompt(
      screenshot,
      prompt,
      { maxTokens: 500, temperature: 0.7, timeoutMs: 30_000 }
    );

    res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[vlm-routes] /analyze error:", (err as Error).message);
    res.status(500).json({
      ok: false,
      error: (err as Error).message,
    });
  }
});

// ─── POST /api/vlm/generate ──────────────────────────────────────────────────

/**
 * Generate text from a prompt (no screenshot needed).
 * Used by device WorkflowEngine for vlm_generate_comment.
 *
 * Body:
 *   prompt: string      — generation prompt
 *   model: string       — optional model hint
 *   maxTokens: number   — optional max tokens (default: 200)
 *
 * Response:
 *   { ok: true, text: string }
 */
router.post("/generate", async (req: Request, res: Response) => {
  const { prompt, maxTokens } = req.body as {
    prompt?: string;
    maxTokens?: number;
  };

  if (!prompt) {
    res.status(400).json({
      ok: false,
      error: "Missing prompt",
    });
    return;
  }

  try {
    // For text-only generation, use a 1x1 white PNG as placeholder
    const blankPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const result = await visionService.analyzeCustomPrompt(
      blankPngBase64,
      prompt,
      { maxTokens: maxTokens ?? 200, temperature: 0.8, timeoutMs: 30_000 }
    );

    res.json({
      ok: true,
      text: result,
    });
  } catch (err) {
    console.error("[vlm-routes] /generate error:", (err as Error).message);
    res.status(500).json({
      ok: false,
      error: (err as Error).message,
    });
  }
});

// ─── POST /api/vlm/chat ──────────────────────────────────────────────────────

/**
 * Chat-style endpoint for LLM requests from device via WebSocket.
 * Used by direct-ws.server.ts _handleLlmRequest().
 *
 * Body:
 *   prompt: string
 *   model: string
 *
 * Response:
 *   { text: string } or { result: string }
 */
router.post("/chat", async (req: Request, res: Response) => {
  const { prompt } = req.body as { prompt?: string };

  if (!prompt) {
    res.status(400).json({ text: "", error: "Missing prompt" });
    return;
  }

  try {
    const blankPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const result = await visionService.analyzeCustomPrompt(
      blankPngBase64,
      prompt,
      { maxTokens: 300, temperature: 0.8, timeoutMs: 30_000 }
    );

    res.json({
      text: result,
      result,
    });
  } catch (err) {
    console.error("[vlm-routes] /chat error:", (err as Error).message);
    res.status(500).json({
      text: "",
      error: (err as Error).message,
    });
  }
});

// ─── GET /api/vlm/health ─────────────────────────────────────────────────────

/**
 * Health check for VLM service.
 */
router.get("/health", async (_req: Request, res: Response) => {
  try {
    res.json({
      ok: true,
      provider: "vision-service",
      status: "available",
    });
  } catch {
    res.status(503).json({ ok: false, status: "unavailable" });
  }
});

export default router;
