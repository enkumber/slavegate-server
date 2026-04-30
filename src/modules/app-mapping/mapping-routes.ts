/**
 * app-mapping/mapping-routes.ts
 * API endpoints for app mapping: start/stop recorder, list/get/delete maps.
 */

import { Router, Request, Response } from "express";
import {
  startRecording,
  stopRecording,
  getRecorderState,
  loadMap,
  deleteMap,
  listMaps,
} from "./recorder.service";

const router = Router();

// ─── POST /start — Start mapping an app on a device ──────────────────────────

router.post("/start", async (req: Request, res: Response) => {
  try {
    const { deviceId, appId, appName } = req.body as {
      deviceId?: string;
      appId?: string;
      appName?: string;
    };

    if (!deviceId || !appId) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: deviceId, appId",
      });
    }

    // Validate deviceId format (UUID or hex string)
    if (!/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
      return res.status(400).json({ ok: false, error: "Invalid deviceId format" });
    }

    // Validate appId format
    if (!/^[a-z][a-z0-9_.]+(\.[a-z][a-z0-9_.]+)+$/.test(appId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid appId format (expected: com.example.app)",
      });
    }

    // Start recording in background (non-blocking)
    startRecording(deviceId, appId, appName).catch((err) => {
      console.error(`[mapping-routes] Recording error: ${err.message}`);
    });

    res.json({
      ok: true,
      status: "started",
      appId,
      deviceId: deviceId.slice(0, 8) + "...",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /status — Get recorder status ───────────────────────────────────────

router.get("/status", (_req: Request, res: Response) => {
  const state = getRecorderState();
  res.json({ ok: true, ...state });
});

// ─── POST /stop — Stop the recorder ──────────────────────────────────────────

router.post("/stop", (_req: Request, res: Response) => {
  stopRecording();
  res.json({ ok: true, status: "stopping" });
});

// ─── GET / — List all app maps ───────────────────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  const maps = listMaps();
  res.json({ ok: true, maps });
});

// ─── GET /:appId — Get a specific app map ────────────────────────────────────

router.get("/:appId", (req: Request, res: Response) => {
  const { appId } = req.params;

  // Prevent path traversal
  if (appId.includes("..") || appId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Invalid appId" });
  }

  const map = loadMap(appId);
  if (!map) {
    return res.status(404).json({ ok: false, error: `Map not found: ${appId}` });
  }

  res.json({ ok: true, map });
});

// ─── DELETE /:appId — Delete an app map ──────────────────────────────────────

router.delete("/:appId", (req: Request, res: Response) => {
  const { appId } = req.params;

  if (appId.includes("..") || appId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Invalid appId" });
  }

  const deleted = deleteMap(appId);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: `Map not found: ${appId}` });
  }

  res.json({ ok: true, deleted: appId });
});

export default router;
