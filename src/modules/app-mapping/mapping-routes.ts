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
  saveMap,
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

router.get("/", async (_req: Request, res: Response) => {
  const maps = await listMaps();
  res.json({ ok: true, maps });
});

// ─── GET /:appId — Get a specific app map ────────────────────────────────────

router.get("/:appId", async (req: Request, res: Response) => {
  const { appId } = req.params;

  // Prevent path traversal
  if (appId.includes("..") || appId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Invalid appId" });
  }

  const map = await loadMap(appId);
  if (!map) {
    return res.status(404).json({ ok: false, error: `Map not found: ${appId}` });
  }

  res.json({ ok: true, map });
});

// ─── DELETE /:appId — Delete an app map ───────────────────────────────────────

router.delete("/:appId", async (req: Request, res: Response) => {
  const { appId } = req.params;

  if (appId.includes("..") || appId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Invalid appId" });
  }

  const deleted = await deleteMap(appId);
  if (!deleted) {
    return res.status(404).json({ ok: false, error: `Map not found: ${appId}` });
  }

  res.json({ ok: true, deleted: appId });
});

// ─── POST /upload — Upload a pre-built app map ────────────────────────────

router.post("/upload", async (req: Request, res: Response) => {
  try {
    const map = req.body as {
      appId?: string;
      appName?: string;
      version?: string;
      pages?: Record<string, any>;
    };

    if (!map?.appId || !map?.pages || Object.keys(map.pages).length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: appId, pages",
      });
    }

    // Validate appId format
    if (!/^[a-z][a-z0-9_.]+(\.[a-z][a-z0-9_.]+)+$/.test(map.appId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid appId format (expected: com.example.app)",
      });
    }

    // Build full AppMap with metadata
    const fullMap = {
      appId: map.appId,
      appName: map.appName || map.appId,
      version: map.version || "1.0.0",
      pages: map.pages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageCount: Object.keys(map.pages).length,
      transitionCount: countTransitions(map.pages),
    };

    await saveMap(fullMap as any);
    console.log(`[mapping-routes] Uploaded map for ${map.appId}: ${fullMap.pageCount} pages, ${fullMap.transitionCount} transitions`);

    res.json({
      ok: true,
      appId: map.appId,
      pageCount: fullMap.pageCount,
      transitionCount: fullMap.transitionCount,
    });
  } catch (err: any) {
    console.error(`[mapping-routes] Upload error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function countTransitions(pages: Record<string, any>): number {
  let count = 0;
  for (const page of Object.values(pages)) {
    for (const el of Object.values(page?.elements || {})) {
      const lt = (el as any)?.leadsTo;
      if (lt && lt !== "self" && lt !== null) count++;
    }
  }
  return count;
}

export default router;
