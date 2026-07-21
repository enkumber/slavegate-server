/**
 * app-mapping/mapping-routes.ts
 * API endpoints for app mapping: start/stop recorder, list/get/delete maps.
 */

import { Router, Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { isDeviceOnline, sendStandaloneJobToDevice, waitForResult } from "../../transport/transport";
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
import {
  assertRuntimeActionSafe,
  listRuntimeProfiles,
  loadRuntimeProfile,
  renderRuntimeParams,
  saveRuntimeProfile,
  type AppRuntimeProfile,
  type RuntimeRecipeStep,
} from "./runtime-profile";

const router = Router();

const MAPPING_REFRESH_ARTIFACT_DIR = "/data/.openclaw/workspace/reports/phone-network/app-map-refresh";

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
  const sendResult = await sendStandaloneJobToDevice(deviceId, {
    jobId: job.jobId,
    type: type as any,
    params,
    timeoutMs,
  });
  if (!sendResult.sent) {
    throw new Error(`Job ${job.jobId} was not dispatched (${sendResult.decision}${sendResult.reason ? `: ${sendResult.reason}` : ""})`);
  }
  return resultPromise;
}

export function a11yTapSucceeded(result: any): boolean {
  return result?.status === "completed"
    && result?.output?.found === true
    && result?.output?.error == null;
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
    packageName: node?.packageName ?? node?.package_name ?? node?.package ?? "",
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

function countUiNodes(nodes: UiTreeNode[]): number {
  let count = 0;
  function scan(node: UiTreeNode): void {
    count += 1;
    for (const child of node.children ?? []) scan(child);
  }
  for (const node of nodes) scan(node);
  return count;
}

function findPackageName(nodes: UiTreeNode[]): string | undefined {
  for (const node of nodes) {
    if (node.packageName?.trim()) return node.packageName;
    const childPackage = findPackageName(node.children ?? []);
    if (childPackage) return childPackage;
  }
  return undefined;
}

function foregroundPackageFromResult(result: any): string | undefined {
  return result?.output?.packageName
    ?? result?.output?.appId
    ?? result?.output?.applicationId
    ?? result?.output?.package
    ?? result?.output?.currentPackage
    ?? result?.output?.currentPackageName
    ?? result?.packageName
    ?? result?.appId
    ?? result?.applicationId
    ?? result?.package;
}

export function parseUiTreeResult(result: any): {
  nodes: UiTreeNode[];
  width: number;
  height: number;
  appVersion?: string;
  packageName?: string;
  nodeCount: number;
} {
  const output = result?.output;
  if (!output) throw new Error("ui_tree_dump returned no output");
  const parsed = typeof output.uiTree === "string"
    ? JSON.parse(output.uiTree)
    : output.uiTree ?? output.nodes ?? output.tree ?? output;
  const roots = extractUiTreeRoots(parsed);
  const nodes = roots.filter(Boolean).map(normalizeUiNode);
  const packageName = output.packageName
    ?? output.appId
    ?? output.applicationId
    ?? output.package
    ?? output.currentPackage
    ?? output.currentPackageName
    ?? parsed?.packageName
    ?? parsed?.appId
    ?? parsed?.applicationId
    ?? parsed?.package
    ?? findPackageName(nodes);
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
  return { nodes, width, height, appVersion, packageName, nodeCount: countUiNodes(nodes) };
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

export function isUsableAppUiTree(
  tree: { nodes: UiTreeNode[]; packageName?: string; nodeCount?: number },
  expectedPackageName: string,
): boolean {
  const observedPackage = tree.packageName ?? findPackageName(tree.nodes);
  if (observedPackage !== expectedPackageName) return false;
  if ((tree.nodeCount ?? countUiNodes(tree.nodes)) <= 1) return false;
  const detection = buildPageDetection(tree.nodes);
  if (detection.signatureHash.startsWith("e3b0c44298fc1c14")) return false;
  if (detection.anchors.length === 0) return false;
  return true;
}

function summarizeRefresh(map: AppMap, failures: string[], screenshotPaths: string[]) {
  const pages = Object.values(map.pages);
  const elementCount = pages.reduce((sum, page) => sum + Object.keys(page.elements ?? {}).length, 0);
  const elements = pages.flatMap((page) => Object.values(page.elements ?? {}));
  const boundsCount = elements.filter((element: any) => element.bounds).length;
  const selectorCount = elements.filter((element: any) =>
    element.resourceId || element.text || element.contentDescription
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

// ─── POST /refresh/:appId — DB-profile-driven safe app-map refresh ──────────

router.get("/runtime-profiles", async (req: Request, res: Response) => {
  if (!requireMappingRefreshAuth(req, res)) return;
  try {
    res.json({ ok: true, profiles: await listRuntimeProfiles() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.get("/runtime-profiles/:appId", async (req: Request, res: Response) => {
  if (!requireMappingRefreshAuth(req, res)) return;
  try {
    const profile = await loadRuntimeProfile(req.params.appId);
    if (!profile) return res.status(404).json({ ok: false, error: `No active runtime profile for ${req.params.appId}` });
    res.json({ ok: true, profile, source: "postgresql" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

router.put("/runtime-profiles/:appId", async (req: Request, res: Response) => {
  if (!requireMappingRefreshAuth(req, res)) return;
  if (req.body?.appId && req.body.appId !== req.params.appId) {
    return res.status(400).json({ ok: false, error: "appId path/body mismatch" });
  }
  try {
    const saved = await saveRuntimeProfile({ ...req.body, appId: req.params.appId });
    res.json({
      ok: true,
      profile: {
        appId: saved.appId,
        appName: saved.appName,
        packageName: saved.packageName,
        profileVersion: saved.profileVersion,
        defaultDeviceId: saved.defaultDeviceId ?? null,
        source: "postgresql",
      },
    });
  } catch (err) {
    res.status(422).json({ ok: false, error: (err as Error).message });
  }
});

router.post("/refresh/:appId", async (req: Request, res: Response) => {
  if (!requireMappingRefreshAuth(req, res)) return;

  const startedAt = new Date();
  const failures: string[] = [];
  const screenshotPaths: string[] = [];
  const body = req.body as {
    deviceId?: string;
    captureScreenshots?: boolean;
    [key: string]: unknown;
  };
  const appId = req.params.appId;
  if (!/^[a-z][a-z0-9_.]+(\.[a-z][a-z0-9_.]+)+$/.test(appId)) {
    return res.status(400).json({ ok: false, error: "Invalid appId format" });
  }

  let profile: AppRuntimeProfile;
  try {
    const loaded = await loadRuntimeProfile(appId);
    if (!loaded) return res.status(404).json({ ok: false, error: `No active runtime profile for ${appId}` });
    profile = loaded;
  } catch (err) {
    return res.status(422).json({ ok: false, error: `Invalid runtime profile: ${(err as Error).message}` });
  }

  const deviceId = String(body.deviceId || profile.defaultDeviceId || "");
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: "deviceId is required when the runtime profile has no default device" });
  }

  if (!isDeviceOnline(deviceId)) {
    return res.status(503).json({ ok: false, error: `Device not connected: ${deviceId}` });
  }

  try {
    const captures: Array<{ id: string; name: string; nodes: UiTreeNode[]; width: number; height: number }> = [];
    const successfulSteps = new Set<string>();
    const transitions: NonNullable<RuntimeRecipeStep["transition"]>[] = [];
    let observedAppVersion: string | undefined;

    async function ensureProfileAppForeground(context: string): Promise<void> {
      const foreground = await dispatchAndAwaitRefresh(deviceId, "get_foreground_app", {}, 10000).catch(() => null);
      const observedPackage = foregroundPackageFromResult(foreground);
      if (observedPackage !== profile.packageName) {
        throw new Error(`${context}: foreground package ${observedPackage ?? "unknown"} does not match ${profile.packageName}`);
      }
    }

    async function capture(id: string, name: string): Promise<void> {
      let lastReject = "";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await ensureProfileAppForeground(`${id} attempt ${attempt}`);
        const tree = parseUiTreeResult(await dispatchAndAwaitRefresh(
          deviceId,
          "ui_tree_dump",
          { packageName: profile.packageName },
          12000,
        ));
        if (isUsableAppUiTree(tree, profile.packageName)) {
          observedAppVersion ??= tree.appVersion;
          captures.push({ id, name, ...tree });
          if (body.captureScreenshots) {
            const shot = await dispatchAndAwaitRefresh(deviceId, "screenshot_for_vlm", { quality: 80 }, 20000);
            const imageBase64 = shot?.output?.image_base64 ?? shot?.output?.screenshotBase64;
            if (imageBase64) {
              await fs.mkdir(MAPPING_REFRESH_ARTIFACT_DIR, { recursive: true });
              const imagePath = path.join(MAPPING_REFRESH_ARTIFACT_DIR, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${id}.jpg`);
              await fs.writeFile(imagePath, Buffer.from(imageBase64, "base64"));
              screenshotPaths.push(imagePath);
            }
          }
          return;
        }

        lastReject = `package=${tree.packageName ?? "unknown"} nodeCount=${tree.nodeCount}`;
        failures.push(`${id} attempt ${attempt}: rejected mismatched/empty UI tree (${lastReject})`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      throw new Error(`${id}: unable to capture usable app UI tree after retries (${lastReject || "no tree"})`);
    }

    async function executeStep(step: RuntimeRecipeStep): Promise<void> {
      if (step.whenInput && body[step.whenInput] == null) {
        failures.push(`${step.id} skipped: input ${step.whenInput} not provided`);
        return;
      }
      if (step.dependsOn && !successfulSteps.has(step.dependsOn)) {
        failures.push(`${step.id} skipped: dependency ${step.dependsOn} did not succeed`);
        return;
      }
      try {
        if (step.type === "capture") {
          await capture(step.stateKey!, step.name!);
        } else {
          const params = renderRuntimeParams(step.params ?? {}, profile, body) as Record<string, unknown>;
          assertRuntimeActionSafe(profile, step, params);
          const timeoutMs = step.type === "open_app" || step.type === "intent_send" ? 25000 : 15000;
          const result = await dispatchAndAwaitRefresh(deviceId, step.type, params, timeoutMs);
          if (step.type === "a11y_find_tap" && !a11yTapSucceeded(result)) {
            throw new Error(String(result?.output?.error ?? "selector was not found"));
          }
        }
        if (step.delayAfterMs) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, step.delayAfterMs!))));
        }
        successfulSteps.add(step.id);
        if (step.transition) transitions.push(step.transition);
      } catch (err) {
        if (!step.optional) throw err;
        failures.push(`${step.id} skipped: ${(err as Error).message}`);
      }
    }

    for (const step of profile.resetRecipe) await executeStep(step);
    for (const step of profile.mappingRecipe) await executeStep(step);

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
    for (const transition of transitions) {
      const source = pages[transition.sourceStateKey];
      const target = pages[transition.targetStateKey];
      const element = source?.elements?.[transition.elementKey];
      if (source && target && element) {
        element.leadsTo = transition.targetStateKey;
      } else {
        failures.push(`transition ${transition.sourceStateKey} -> ${transition.targetStateKey} not materialized: state/element missing`);
      }
    }

    const map: AppMap = {
      appId: profile.appId,
      appName: profile.appName,
      version: `runtime-profile-${profile.profileVersion}-${startedAt.toISOString()}`,
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
    const summary = summarizeRefresh(map, failures, screenshotPaths);
    const summaryPath = path.join(
      MAPPING_REFRESH_ARTIFACT_DIR,
      `${startedAt.toISOString().replace(/[:.]/g, "-")}-summary.json`,
    );
    await fs.mkdir(MAPPING_REFRESH_ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(summaryPath, `${JSON.stringify({ summary, quality }, null, 2)}\n`, "utf8");

    if (!quality.usable) {
      return res.status(422).json({
        ok: false,
        error: "App-map refresh produced an unusable map; refusing to save",
        quality,
        summary: { ...summary, summaryPath },
      });
    }

    await saveMap(map);

    res.json({
      ok: quality.usable,
      quality,
      summary: { ...summary, summaryPath },
      safety: {
        mode: profile.safetyPolicy.mode,
        blocked: profile.safetyPolicy.blocked ?? [],
      },
      runtimeProfile: { appId: profile.appId, version: profile.profileVersion, source: "postgresql" },
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
      appVersion?: string;
      deviceProfile?: { width?: number; height?: number };
      recordedOn?: string;
      createdAt?: string;
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
      appVersion: map.appVersion,
      deviceProfile: map.deviceProfile,
      recordedOn: map.recordedOn,
      pages: map.pages,
      createdAt: map.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageCount: Object.keys(map.pages).length,
      transitionCount: countTransitions(map.pages),
    };

    const quality = validateAppMapQuality(fullMap as any);
    if (!quality.usable) {
      return res.status(422).json({
        ok: false,
        error: "Uploaded app map is unusable; refusing to save",
        quality,
      });
    }

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
