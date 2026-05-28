/**
 * app-mapping/mapping-routes.ts
 * API endpoints for app mapping: start/stop recorder, list/get/delete maps.
 */

import { Router, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { isDeviceOnline, sendJobToDevice, waitForResult } from "../../transport/transport";
import { buildPageDetection } from "./page-fingerprint";
import { filterRelevantElements, generateElementId } from "./element-filter";
import {
  startRecording,
  stopRecording,
  getRecorderState,
  loadMap,
  deleteMap,
  listMaps,
  saveMap,
} from "./recorder.service";
import { validateAppMapQuality, type AppMap, type UiTreeNode } from "./schema";

const router = Router();

const REDDIT_APP_ID = "com.reddit.frontpage";
const DEFAULT_REDDIT_REFRESH_DEVICE = "d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd";
const REDDIT_REFRESH_ARTIFACT_DIR = "/data/.openclaw/workspace/reports/phone-network/app-map-refresh";

function requireMappingRefreshAuth(req: Request, res: Response): boolean {
  const expected = process.env.API_KEY;
  if (!expected) {
    res.status(503).json({ ok: false, error: "API key auth is not configured" });
    return false;
  }
  const apiKey = String(req.headers["x-api-key"] ?? "").trim();
  const bearer = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  if (apiKey === expected || bearer === expected) return true;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return false;
}

async function dispatchAndAwaitRefresh(
  deviceId: string,
  type: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const job = await dispatcherService.dispatch({
    deviceId,
    type: type as any,
    params,
    timeoutMs,
  });
  const resultPromise = waitForResult(job.jobId, timeoutMs);
  const sent = sendJobToDevice(deviceId, {
    jobId: job.jobId,
    type: type as any,
    params,
    timeoutMs,
  });
  if (!sent) throw new Error(`Device ${deviceId} is not connected`);
  return resultPromise;
}

function normalizeBounds(rawBounds: any): UiTreeNode["bounds"] {
  if (!rawBounds || typeof rawBounds !== "object") return undefined;

  const leftRaw = rawBounds.left ?? rawBounds.l ?? rawBounds.x;
  const topRaw = rawBounds.top ?? rawBounds.t ?? rawBounds.y;
  const rightRaw = rawBounds.right ?? rawBounds.r;
  const bottomRaw = rawBounds.bottom ?? rawBounds.b;
  const widthRaw = rawBounds.width ?? rawBounds.w;
  const heightRaw = rawBounds.height ?? rawBounds.h;

  const left = Number(leftRaw);
  const top = Number(topRaw);
  const right = rightRaw !== undefined ? Number(rightRaw) : left + Number(widthRaw);
  const bottom = bottomRaw !== undefined ? Number(bottomRaw) : top + Number(heightRaw);

  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;

  return { left, top, right, bottom };
}

export function normalizeUiNode(node: any): UiTreeNode {
  const bounds = normalizeBounds(node?.bounds);

  return {
    resourceId: node?.resourceId ?? node?.resource_id ?? node?.id ?? "",
    text: node?.text ?? "",
    contentDescription: node?.contentDescription ?? node?.content_description ?? node?.desc ?? "",
    className: node?.className ?? node?.class ?? "",
    bounds,
    clickable: Boolean(node?.clickable),
    scrollable: Boolean(node?.scrollable),
    focusable: Boolean(node?.focusable),
    visible: node?.visible ?? node?.visibleToUser ?? true,
    enabled: node?.enabled ?? true,
    checked: node?.checked,
    children: Array.isArray(node?.children) ? node.children.map(normalizeUiNode) : undefined,
  };
}

function extractUiTreeRoots(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.nodes)) return parsed.nodes;
  if (Array.isArray(parsed?.children)) return [parsed];
  if (parsed?.root) return extractUiTreeRoots(parsed.root);
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

export function parseUiTreeResult(result: any): { nodes: UiTreeNode[]; width: number; height: number; appVersion?: string } {
  const output = result?.output;
  if (!output) throw new Error("ui_tree_dump returned no output");
  const parsed = typeof output.uiTree === "string"
    ? JSON.parse(output.uiTree)
    : output.uiTree ?? output.nodes ?? output.tree ?? output;
  const roots = extractUiTreeRoots(parsed);
  const nodes = roots.filter(Boolean).map(normalizeUiNode);
  let width = Number(output.screenWidth ?? output.width ?? output.original_width ?? 0);
  let height = Number(output.screenHeight ?? output.height ?? output.original_height ?? 0);
  const appVersion = output.appVersion ?? output.versionName ?? output.packageVersion;

  function scan(node: UiTreeNode): void {
    if (node.bounds) {
      width = Math.max(width, node.bounds.right);
      height = Math.max(height, node.bounds.bottom);
    }
    for (const child of node.children ?? []) scan(child);
  }
  for (const node of nodes) scan(node);

  if (!width || !height) {
    width = 1080;
    height = 2400;
  }
  return { nodes, width, height, appVersion };
}

function buildCapturedPage(
  pageId: string,
  name: string,
  nodes: UiTreeNode[],
  width: number,
  height: number,
  discoveryOrder: number,
) {
  const detection = buildPageDetection(nodes);
  const elements = filterRelevantElements(nodes, width, height);
  const elementsWithIds: Record<string, any> = {};
  elements.forEach((element, index) => {
    const generated = generateElementId(element, discoveryOrder);
    const base = generated || `element_${index}`;
    const elementId = elementsWithIds[base] ? `${base}_${index}` : base;
    elementsWithIds[elementId] = {
      ...element,
      leadsTo: "self",
      semanticId: element.semanticId || `${pageId}.${elementId}`,
    };
  });

  return {
    name,
    detection,
    elements: elementsWithIds,
    discoveryOrder,
  };
}

function summarizeRefresh(map: AppMap, failures: string[], screenshotPaths: string[]) {
  const pages = Object.values(map.pages);
  const elementCount = pages.reduce((sum, page) => sum + Object.keys(page.elements ?? {}).length, 0);
  const elements = pages.flatMap((page) => Object.values(page.elements ?? {}));
  const boundsCount = elements.filter((element: any) => element.bounds).length;
  const selectorCount = elements.filter((element: any) =>
    element.resourceId || element.text || element.contentDescription || element.semanticId
  ).length;
  const signatureHashes = Object.fromEntries(
    Object.entries(map.pages).map(([id, page]) => [id, page.detection.signatureHash]),
  );

  return {
    appId: map.appId,
    version: map.version,
    pagesCaptured: Object.keys(map.pages),
    signatureHashes,
    elementCount,
    boundsCoverage: elementCount ? boundsCount / elementCount : 0,
    selectorCoverage: elementCount ? selectorCount / elementCount : 0,
    screenshotPaths,
    failures,
  };
}

function assertSafeRedditPostUri(uri: string): void {
  const parsed = new URL(uri);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.endsWith("reddit.com")) {
    throw new Error("postUri must be an http(s) reddit.com URL");
  }
  if (!/^\/r\/[^/]+\/comments\//.test(parsed.pathname)) {
    throw new Error("postUri must point to a Reddit post detail comments URL");
  }
}

// ─── POST /refresh/reddit — Safe real-device Reddit app-map refresh ─────────

router.post("/refresh/reddit", async (req: Request, res: Response) => {
  if (!requireMappingRefreshAuth(req, res)) return;

  const startedAt = new Date();
  const failures: string[] = [];
  const screenshotPaths: string[] = [];
  const body = req.body as {
    deviceId?: string;
    captureScreenshots?: boolean;
    postUri?: string;
  };
  const deviceId = body.deviceId || DEFAULT_REDDIT_REFRESH_DEVICE;

  if (!isDeviceOnline(deviceId)) {
    return res.status(503).json({ ok: false, error: `Device not connected: ${deviceId}` });
  }

  try {
    const captures: Array<{ id: string; name: string; nodes: UiTreeNode[]; width: number; height: number }> = [];
    let observedAppVersion: string | undefined;

    async function settle(): Promise<void> {
      await dispatchAndAwaitRefresh(deviceId, "wait_for_idle", { timeoutMs: 2500 }, 5000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    async function capture(id: string, name: string): Promise<void> {
      const tree = parseUiTreeResult(await dispatchAndAwaitRefresh(deviceId, "ui_tree_dump", { packageName: REDDIT_APP_ID }, 12000));
      observedAppVersion ??= tree.appVersion;
      captures.push({ id, name, ...tree });
      if (body.captureScreenshots) {
        const shot = await dispatchAndAwaitRefresh(deviceId, "screenshot_for_vlm", { quality: 80 }, 20000);
        const imageBase64 = shot?.output?.image_base64 ?? shot?.output?.screenshotBase64;
        if (imageBase64) {
          await fs.mkdir(REDDIT_REFRESH_ARTIFACT_DIR, { recursive: true });
          const imagePath = path.join(REDDIT_REFRESH_ARTIFACT_DIR, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${id}.jpg`);
          await fs.writeFile(imagePath, Buffer.from(imageBase64, "base64"));
          screenshotPaths.push(imagePath);
        }
      }
    }

    await dispatchAndAwaitRefresh(deviceId, "open_app", { packageName: REDDIT_APP_ID }, 25000);
    await settle();
    const foreground = await dispatchAndAwaitRefresh(deviceId, "get_foreground_app", {}, 10000).catch(() => null);
    observedAppVersion =
      foreground?.output?.appVersion
      ?? foreground?.output?.versionName
      ?? foreground?.output?.packageVersion;
    await capture("reddit_home_feed", "Reddit home/feed");

    await dispatchAndAwaitRefresh(deviceId, "intent_send", {
      action: "android.intent.action.VIEW",
      uri: "https://www.reddit.com/r/AskReddit/",
      packageName: REDDIT_APP_ID,
    }, 25000);
    await settle();
    await capture("askreddit_header", "r/AskReddit header/community page");

    await dispatchAndAwaitRefresh(deviceId, "scroll", { direction: "down", distancePx: 900, durationMs: 450 }, 10000);
    await settle();
    await capture("askreddit_feed_after_scroll", "r/AskReddit feed after scroll");

    await dispatchAndAwaitRefresh(deviceId, "intent_send", {
      action: "android.intent.action.VIEW",
      uri: "https://www.reddit.com/search/?q=AskReddit",
      packageName: REDDIT_APP_ID,
    }, 25000);
    await settle();
    await capture("reddit_search_surface", "Reddit search surface");

    if (body.postUri) {
      try {
        assertSafeRedditPostUri(body.postUri);
        await dispatchAndAwaitRefresh(deviceId, "intent_send", {
          action: "android.intent.action.VIEW",
          uri: body.postUri,
          packageName: REDDIT_APP_ID,
        }, 25000);
        await settle();
        await capture("reddit_post_detail", "Reddit post detail");
      } catch (err) {
        failures.push(`post_detail skipped: ${(err as Error).message}`);
      }
    } else {
      failures.push("post_detail skipped: no validated read-only postUri provided");
    }

    const now = new Date().toISOString();
    const pages: AppMap["pages"] = {};
    captures.forEach((captureEntry, index) => {
      pages[captureEntry.id] = buildCapturedPage(
        captureEntry.id,
        captureEntry.name,
        captureEntry.nodes,
        captureEntry.width,
        captureEntry.height,
        index,
      );
    });

    const map: AppMap = {
      appId: REDDIT_APP_ID,
      appName: "Reddit",
      version: `real-device-refresh-${startedAt.toISOString()}`,
      appVersion: observedAppVersion ?? "observed-live",
      deviceProfile: captures[0] ? { width: captures[0].width, height: captures[0].height } : undefined,
      pages,
      createdAt: now,
      updatedAt: now,
      recordedOn: deviceId,
      pageCount: Object.keys(pages).length,
      transitionCount: countTransitions(pages),
    };

    const quality = validateAppMapQuality(map);
    await saveMap(map);

    const summary = summarizeRefresh(map, failures, screenshotPaths);
    const summaryPath = path.join(
      REDDIT_REFRESH_ARTIFACT_DIR,
      `${startedAt.toISOString().replace(/[:.]/g, "-")}-summary.json`,
    );
    await fs.mkdir(REDDIT_REFRESH_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(summaryPath, `${JSON.stringify({ summary, quality }, null, 2)}\n`, "utf8");

    res.json({
      ok: quality.usable,
      quality,
      summary: { ...summary, summaryPath },
      safety: {
        mode: "read_only_navigation",
        blocked: ["vote", "comment", "join", "login", "settings", "profile_mutation"],
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message, failures });
  }
});

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

// ─── GET /:appId/quality — Validate map selector/coordinate usability ───────

router.get("/:appId/quality", async (req: Request, res: Response) => {
  const { appId } = req.params;

  if (appId.includes("..") || appId.includes("/")) {
    return res.status(400).json({ ok: false, error: "Invalid appId" });
  }

  const map = await loadMap(appId);
  if (!map) {
    return res.status(404).json({ ok: false, error: `Map not found: ${appId}` });
  }

  res.json({ ok: true, appId, quality: validateAppMapQuality(map) });
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

    const quality = validateAppMapQuality(fullMap as any);
    await saveMap(fullMap as any);
    console.log(`[mapping-routes] Uploaded map for ${map.appId}: ${fullMap.pageCount} pages, ${fullMap.transitionCount} transitions`);

    res.json({
      ok: true,
      appId: map.appId,
      pageCount: fullMap.pageCount,
      transitionCount: fullMap.transitionCount,
      quality,
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
