/**
 * app-mapping/recorder.service.ts
 * BFS-based app crawler that maps pages and transitions by tapping fixed elements.
 *
 * Algorithm:
 * 1. Launch app → UI tree dump → fingerprint → initial page
 * 2. BFS: for each unexplored element on each page:
 *    a. tap(element) → wait → UI tree dump
 *    b. fingerprint → new page or existing page?
 *    c. record transition
 *    d. back → verify return to source page
 * 3. Queue empty → save map
 */

import fs from "fs";
import path from "path";
import { sendJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { computePageSignature, buildPageDetection, isSamePage } from "./page-fingerprint";
import { filterRelevantElements, generateElementId } from "./element-filter";
import type {
  AppMap,
  PageDef,
  ElementDef,
  RecorderState,
  UiTreeNode,
  ExplorationEntry,
} from "./schema";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.env.APP_MAPS_DIR || path.join(process.env.DATA_DIR || "./data", "app-maps"));
const TAP_WAIT_MS = 1500;
const BACK_WAIT_MS = 800;
const UI_TREE_TIMEOUT = 8000;
const LAUNCH_TIMEOUT = 10000;
const MAX_PAGES = 50;
const MAX_EXPLORATIONS = 200;

// ─── State (module-level singleton) ────────────────────────────────────────

let recorderState: RecorderState = { status: "idle", appId: "", deviceId: "", pagesFound: 0, elementsExplored: 0, totalElements: 0, queueRemaining: 0 };

const pageHashMap = new Map<string, string>(); // hash → pageId
const bfsQueue: ExplorationEntry[] = [];
let currentMap: AppMap | null = null;
let stopRequested = false;
let activeDeviceId: string | null = null;

function resetState(): void {
  stopRequested = false;
  bfsQueue.length = 0;
  pageHashMap.clear();
  currentMap = null;
  activeDeviceId = null;
}

export function getRecorderState(): RecorderState {
  return { ...recorderState };
}

// ─── Job Helpers ─────────────────────────────────────────────────────────────

async function dispatchAndAwait(deviceId: string, type: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
  const job = await dispatcherService.dispatch({
    deviceId,
    type: type as any,
    params,
    timeoutMs,
  });

  sendJobToDevice(deviceId, {
    jobId: job.jobId,
    type: type as any,
    params,
    timeoutMs,
  });

  return waitForResult(job.jobId, timeoutMs);
}

async function getUiTree(deviceId: string): Promise<{ nodes: UiTreeNode[]; screenWidth: number; screenHeight: number }> {
  const result = await dispatchAndAwait(deviceId, "ui_tree_dump", {}, UI_TREE_TIMEOUT);

  if (!result?.output) {
    throw new Error("ui_tree_dump returned no output");
  }

  const nodes = result.output.nodes || result.output.tree || result.output;
  const screenWidth = result.output.screenWidth || result.output.width || 1080;
  const screenHeight = result.output.screenHeight || result.output.height || 2400;

  if (screenWidth <= 0 || screenHeight <= 0) {
    throw new Error(`Invalid screen dimensions: ${screenWidth}x${screenHeight}`);
  }

  return { nodes: Array.isArray(nodes) ? nodes : [], screenWidth, screenHeight };
}

async function tapElement(deviceId: string, element: ElementDef, screenWidth: number, screenHeight: number): Promise<void> {
  const x = Math.round(element.bounds.x * screenWidth + element.bounds.w * screenWidth / 2);
  const y = Math.round(element.bounds.y * screenHeight + element.bounds.h * screenHeight / 2);

  await dispatchAndAwait(deviceId, "tap", { x, y }, 5000);
}

async function goBack(deviceId: string): Promise<void> {
  await dispatchAndAwait(deviceId, "press_key", { key: "back" }, 3000);
}

async function launchApp(deviceId: string, appId: string): Promise<void> {
  await dispatchAndAwait(deviceId, "open_app", { packageName: appId }, LAUNCH_TIMEOUT);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sanitize appId to prevent path traversal in file operations. */
function sanitizeAppId(appId: string): string {
  return appId.replace(/[^a-zA-Z0-9._-]/g, "");
}

// ─── Page Management ─────────────────────────────────────────────────────────

let pageCounter = 0;

function generatePageId(): string {
  return `page_${pageCounter++}`;
}

function generatePageName(pageId: string, anchors: string[]): string {
  // Try to make a human-readable name from anchors
  for (const anchor of anchors.slice(0, 3)) {
    if (anchor.startsWith("text:")) {
      const text = anchor.slice(5).trim();
      if (text.length > 0 && text.length < 30) {
        return text.replace(/\s+/g, "_").toLowerCase();
      }
    }
  }
  return pageId;
}

function findOrCreatePage(
  uiTree: UiTreeNode[],
  screenWidth: number,
  screenHeight: number,
): { pageId: string; isNew: boolean } {
  const detection = buildPageDetection(uiTree);
  const hash = detection.signatureHash;

  // Check if we've seen this page before
  const existingPageId = pageHashMap.get(hash);
  if (existingPageId) {
    return { pageId: existingPageId, isNew: false };
  }

  // New page
  if (!currentMap) throw new Error("No active map");
  if (Object.keys(currentMap.pages).length >= MAX_PAGES) {
    throw new Error(`Max pages (${MAX_PAGES}) reached`);
  }

  const pageId = generatePageId();
  const elements = filterRelevantElements(uiTree, screenWidth, screenHeight);

  // Assign IDs to elements
  const elementsWithIds: Record<string, ElementDef> = {};
  for (const el of elements) {
    const elId = generateElementId(el, pageCounter);
    // Make unique
    const uniqueId = elementsWithIds[elId] ? `${elId}_${Object.keys(elementsWithIds).length}` : elId;
    elementsWithIds[uniqueId] = { ...el, leadsTo: null };
  }

  const name = generatePageName(pageId, detection.anchors);

  currentMap.pages[pageId] = {
    name,
    detection,
    elements: elementsWithIds,
    discoveryOrder: Object.keys(currentMap.pages).length,
  };

  pageHashMap.set(hash, pageId);

  // Add unexplored elements to BFS queue
  for (const [elId, elDef] of Object.entries(elementsWithIds)) {
    bfsQueue.push({
      sourcePageId: pageId,
      elementId: elId,
      element: elDef,
    });
  }

  return { pageId, isNew: true };
}

// ─── Main BFS Loop ───────────────────────────────────────────────────────────

export async function startRecording(deviceId: string, appId: string, appName?: string): Promise<void> {
  if (recorderState.status === "running") {
    throw new Error("Recorder already running");
  }

  if (!isDeviceOnline(deviceId)) {
    throw new Error("Device not online");
  }

  // Reset state
  resetState();
  pageCounter = 0;
  activeDeviceId = deviceId;

  currentMap = {
    appId,
    appName: appName || appId,
    version: "1.0.0",
    pages: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pageCount: 0,
    transitionCount: 0,
  };

  recorderState = {
    status: "running",
    appId,
    deviceId,
    pagesFound: 0,
    elementsExplored: 0,
    totalElements: 0,
    queueRemaining: 0,
    startedAt: new Date().toISOString(),
  };

  const deviceLabel = deviceId.slice(0, 8);
  console.log(`[app-mapping] Starting mapping for ${appId} on device ${deviceLabel}**`);

  try {
    // 1. Launch app
    await launchApp(deviceId, appId);
    await sleep(TAP_WAIT_MS);

    // 2. Initial UI tree dump
    const initialTree = await getUiTree(deviceId);
    findOrCreatePage(initialTree.nodes, initialTree.screenWidth, initialTree.screenHeight);

    // 3. BFS exploration
    let explorations = 0;
    while (bfsQueue.length > 0 && !stopRequested && explorations < MAX_EXPLORATIONS) {
      const entry = bfsQueue.shift()!;
      recorderState.queueRemaining = bfsQueue.length;

      console.log(
        `[app-mapping] Exploring: page=${entry.sourcePageId} element=${entry.elementId} (queue=${bfsQueue.length})`,
      );

      try {
        await exploreElement(deviceId, entry, explorations);
      } catch (err: any) {
        console.warn(`[app-mapping] Failed to explore ${entry.elementId}: ${err.message}`);
        // Continue with next element
      }

      explorations++;
      recorderState.elementsExplored = explorations;
      recorderState.pagesFound = Object.keys(currentMap.pages).length;
      recorderState.totalElements = bfsQueue.length + explorations;
    }

    // 4. Save map
    if (currentMap) {
      currentMap.updatedAt = new Date().toISOString();
      currentMap.pageCount = Object.keys(currentMap.pages).length;
      currentMap.transitionCount = countTransitions(currentMap);
      await saveMap(currentMap);
    }

    recorderState.status = stopRequested ? "idle" : "idle";
    activeDeviceId = null;
    console.log(
      `[app-mapping] Done: ${recorderState.pagesFound} pages, ${recorderState.elementsExplored} elements explored`,
    );
  } catch (err: any) {
    console.error(`[app-mapping] Recording failed: ${err.message}`);
    recorderState.status = "error";
    recorderState.error = err.message;
    activeDeviceId = null;
  }
}

async function exploreElement(deviceId: string, entry: ExplorationEntry, explorationIndex: number): Promise<void> {
  if (!currentMap) return;

  // Get current screen dimensions (from a fresh tree dump)
  const preTree = await getUiTree(deviceId);

  // Verify we're on the expected source page
  const preHash = computePageSignature(preTree.nodes);
  const expectedHash = currentMap.pages[entry.sourcePageId]?.detection.signatureHash;

  if (expectedHash && !isSamePage(preHash, expectedHash)) {
    // We're not on the expected page — attempt recovery
    console.warn(`[app-mapping] Not on expected page (expected ${entry.sourcePageId}), attempting back recovery`);
    await goBack(deviceId);
    await sleep(BACK_WAIT_MS);
    const retryTree = await getUiTree(deviceId);
    const retryHash = computePageSignature(retryTree.nodes);
    if (!isSamePage(retryHash, expectedHash)) {
      console.warn(`[app-mapping] Recovery failed, skipping element ${entry.elementId}`);
      return;
    }
  }

  // Tap the element
  await tapElement(deviceId, entry.element, preTree.screenWidth, preTree.screenHeight);
  await sleep(TAP_WAIT_MS);

  // Dump new UI tree
  const postTree = await getUiTree(deviceId);
  const { pageId: targetPageId, isNew: isNewPage } = findOrCreatePage(
    postTree.nodes,
    postTree.screenWidth,
    postTree.screenHeight,
  );

  // Record transition
  if (currentMap.pages[entry.sourcePageId]) {
    if (targetPageId === entry.sourcePageId) {
      currentMap.pages[entry.sourcePageId].elements[entry.elementId].leadsTo = "self";
    } else {
      currentMap.pages[entry.sourcePageId].elements[entry.elementId].leadsTo = targetPageId;
    }
  }

  console.log(
    `[app-mapping] Transition: ${entry.sourcePageId} → ${targetPageId} via ${entry.elementId} (${isNewPage ? "NEW" : "existing"})`,
  );

  // Go back
  await goBack(deviceId);
  await sleep(BACK_WAIT_MS);

  // Verify we're back on the source page (don't block on failure)
  try {
    const backTree = await getUiTree(deviceId);
    const backHash = computePageSignature(backTree.nodes);
    if (expectedHash && !isSamePage(backHash, expectedHash)) {
      console.warn(`[app-mapping] Back navigation didn't return to source page`);
      // Try one more back
      await goBack(deviceId);
      await sleep(BACK_WAIT_MS);
    }
  } catch {
    // Non-critical — continue exploration
  }
}

// ─── Stop ────────────────────────────────────────────────────────────────────

export function stopRecording(): void {
  if (recorderState.status !== "running") return;
  stopRequested = true;
  recorderState.status = "stopping";
  console.log(`[app-mapping] Stop requested`);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function saveMap(map: AppMap): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const safeId = sanitizeAppId(map.appId);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf8");
  console.log(`[app-mapping] Saved map to ${filePath}`);
}

export function loadMap(appId: string): AppMap | null {
  const safeId = sanitizeAppId(appId);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AppMap;
  } catch {
    return null;
  }
}

export function deleteMap(appId: string): boolean {
  const safeId = sanitizeAppId(appId);
  const filePath = path.join(DATA_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function listMaps(): Array<{ appId: string; appName: string; pageCount: number; updatedAt: string }> {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as AppMap;
        return {
          appId: map.appId,
          appName: map.appName,
          pageCount: map.pageCount || Object.keys(map.pages).length,
          updatedAt: map.updatedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ appId: string; appName: string; pageCount: number; updatedAt: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countTransitions(map: AppMap): number {
  let count = 0;
  for (const page of Object.values(map.pages)) {
    for (const el of Object.values(page.elements)) {
      if (el.leadsTo && el.leadsTo !== "self" && el.leadsTo !== null) {
        count++;
      }
    }
  }
  return count;
}
