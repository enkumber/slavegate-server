/**
 * app-mapping/schema.ts
 * Types and validation for the App Map JSON schema.
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface AppMap {
  appId: string;
  appName: string;
  version: string;
  /** App version observed when this map was recorded, if known. */
  appVersion?: string;
  /** Device profile observed when this map was recorded. Bounds remain normalized. */
  deviceProfile?: {
    model?: string;
    width?: number;
    height?: number;
    density?: number;
  };
  pages: Record<string, PageDef>;
  /** When this map was created */
  createdAt: string;
  /** Last modification time */
  updatedAt: string;
  /** Device model used for recording (info only — coords are normalized) */
  recordedOn?: string;
  /** Number of pages discovered */
  pageCount: number;
  /** Number of transitions recorded */
  transitionCount: number;
}

export interface PageDef {
  /** Human-readable page name (auto-generated during mapping) */
  name: string;
  detection: PageDetection;
  elements: Record<string, ElementDef>;
  /** Order of discovery (0 = first page) */
  discoveryOrder: number;
  /** Screenshot hash for reference (not stored, just metadata) */
  screenshotHash?: string;
}

export interface PageDetection {
  method: "ui_tree_signature";
  /** Anchor nodes used for matching (resourceId:xxx, text:yyy, etc.) */
  anchors: string[];
  /** Hash of the page's signature for quick comparison */
  signatureHash: string;
}

export interface ElementDef {
  /** Semantic element type */
  type: "tab" | "button" | "input" | "toggle" | "fab" | "menu_item" | "icon" | "unknown";
  /** Normalized bounds (0.0 - 1.0) */
  bounds: { x: number; y: number; w: number; h: number };
  /** Android resource ID (if any) */
  resourceId: string;
  /** Visible text */
  text: string;
  /** Content description (accessibility) */
  contentDescription: string;
  /** Selector fields present on the source UI node, for compiler/binding provenance. */
  selectorProvenance?: Array<"resourceId" | "text" | "contentDescription" | "semanticId">;
  /** Stable semantic-ish ID derived from selector metadata and page context. */
  semanticId?: string;
  /** Whether the element is clickable */
  clickable: boolean;
  /** Target page ID after tapping this element, or "self" if stays on same page, or null if unknown */
  leadsTo: string | null | "self";
}

// ─── Recorder State ──────────────────────────────────────────────────────────

export type RecorderStatus = "idle" | "running" | "stopping" | "error";

export interface RecorderState {
  status: RecorderStatus;
  appId: string;
  deviceId: string;
  /** Pages discovered so far */
  pagesFound: number;
  /** Elements explored so far */
  elementsExplored: number;
  /** Total clickable elements identified */
  totalElements: number;
  /** BFS queue remaining */
  queueRemaining: number;
  /** Error message if status === "error" */
  error?: string;
  /** Started at */
  startedAt?: string;
}

// ─── UI Tree Node (from device) ──────────────────────────────────────────────

export interface UiTreeNode {
  packageName?: string;
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  className?: string;
  bounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  clickable?: boolean;
  scrollable?: boolean;
  focusable?: boolean;
  visible?: boolean;
  enabled?: boolean;
  checked?: boolean;
  children?: UiTreeNode[];
  /** Parent node reference (added during processing) */
  parentClassName?: string;
}

// ─── BFS Queue Entry ─────────────────────────────────────────────────────────

export interface ExplorationEntry {
  /** Page where the element lives */
  sourcePageId: string;
  /** Element ID within that page */
  elementId: string;
  /** The element to tap */
  element: ElementDef;
}

// ─── Quality Gate ───────────────────────────────────────────────────────────

export interface AppMapQualityStats {
  pagesMissingSignatureHash: number;
  pagesWithEmptyContentSignature: number;
  elementsMissingBounds: number;
  pageCount: number;
  elementCount: number;
  elementsInvalidBounds: number;
  elementsMissingSelector: number;
  /** @deprecated use elementsMissingSelector */
  elementsMissingSelectorMetadata: number;
  pagesMissingAnchors: number;
  staleVersion?: boolean;
}

export interface AppMapQualityReport {
  usable: boolean;
  errors: string[];
  warnings: string[];
  stats: AppMapQualityStats;
}

export interface AppMapQualityOptions {
  expectedAppVersion?: string | null;
  expectedResolution?: {
    width?: number | null;
    height?: number | null;
  } | null;
}

function hasNormalizedBounds(element: Partial<ElementDef> | null | undefined): boolean {
  const b = element?.bounds;
  if (!b) return false;
  return (
    Number.isFinite(b.x)
    && Number.isFinite(b.y)
    && Number.isFinite(b.w)
    && Number.isFinite(b.h)
    && b.x >= 0
    && b.y >= 0
    && b.w > 0
    && b.h > 0
    && b.x <= 1
    && b.y <= 1
    && b.x + b.w <= 1.02
    && b.y + b.h <= 1.02
  );
}

function hasSelectorMetadata(elementId: string, element: Partial<ElementDef> | null | undefined): boolean {
  return Boolean(
    element?.resourceId?.trim()
    || element?.text?.trim()
    || element?.contentDescription?.trim()
  );
}

function isEmptyContentSignature(signatureHash: string | null | undefined): boolean {
  const hash = signatureHash?.trim().toLowerCase();
  return Boolean(hash && "e3b0c44298fc1c149afbf4c8996fb924".startsWith(hash));
}

export function validateAppMapQuality(map: AppMap | null | undefined, options: AppMapQualityOptions = {}): AppMapQualityReport {
  const stats: AppMapQualityStats = {
    pagesMissingSignatureHash: 0,
    pagesWithEmptyContentSignature: 0,
    elementsMissingBounds: 0,
    pageCount: 0,
    elementCount: 0,
    elementsInvalidBounds: 0,
    elementsMissingSelector: 0,
    elementsMissingSelectorMetadata: 0,
    pagesMissingAnchors: 0,
  };
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!map || !map.appId || !map.version || !map.pages || typeof map.pages !== "object") {
    return {
      usable: false,
      errors: ["app map is missing required root metadata"],
      warnings,
      stats,
    };
  }

  const pages = Object.entries(map.pages);
  stats.pageCount = pages.length;
  if (pages.length === 0) {
    errors.push("app map has no pages");
  }

  for (const [pageId, page] of pages) {
    if (!page?.detection?.signatureHash?.trim()) {
      stats.pagesMissingSignatureHash += 1;
    } else if (isEmptyContentSignature(page.detection.signatureHash)) {
      stats.pagesWithEmptyContentSignature += 1;
    }
    if (!Array.isArray(page?.detection?.anchors) || page.detection.anchors.length === 0) {
      stats.pagesMissingAnchors += 1;
    }

    const elements = Object.entries(page?.elements ?? {});
    for (const [elementId, element] of elements) {
      stats.elementCount += 1;
      if (!element?.bounds) {
        stats.elementsMissingBounds += 1;
      } else if (!hasNormalizedBounds(element)) {
        stats.elementsInvalidBounds += 1;
      }
      if (!hasSelectorMetadata(elementId, element)) {
        stats.elementsMissingSelector += 1;
        stats.elementsMissingSelectorMetadata += 1;
      }
      if (element?.leadsTo && element.leadsTo !== "self" && !map.pages[element.leadsTo]) {
        warnings.push(`${pageId}.${elementId} leadsTo missing page "${element.leadsTo}"`);
      }
    }
  }

  if (stats.pagesMissingSignatureHash > 0) {
    errors.push(`${stats.pagesMissingSignatureHash} page(s) missing detection.signatureHash`);
  }
  if (stats.pagesWithEmptyContentSignature > 0) {
    errors.push(`${stats.pagesWithEmptyContentSignature} page(s) have empty-content signatureHash`);
  }
  if (stats.pageCount > 0 && stats.elementCount === 0) {
    errors.push("app map has pages but no bindable elements");
  }
  if (stats.elementsMissingBounds > 0) {
    errors.push(`${stats.elementsMissingBounds} element(s) missing normalized bounds`);
  }
  if (stats.elementsInvalidBounds > 0) {
    errors.push(`${stats.elementsInvalidBounds} element(s) have invalid normalized bounds`);
  }
  if (stats.elementsMissingSelector > 0) {
    warnings.push(`${stats.elementsMissingSelector} element(s) missing stable selector metadata`);
  }
  if (stats.pageCount > 0 && stats.elementCount > 0 && stats.elementsMissingBounds + stats.elementsInvalidBounds >= stats.elementCount) {
    errors.push("app map has zero bounds coverage");
  }
  if (stats.pageCount > 0 && stats.elementCount > 0 && stats.elementsMissingSelector >= stats.elementCount) {
    errors.push("app map has zero selector coverage");
  }
  if (stats.pagesMissingAnchors > 0) {
    warnings.push(`${stats.pagesMissingAnchors} page(s) missing detection anchors`);
  }
  if (stats.pageCount > 0 && stats.pagesMissingAnchors >= stats.pageCount) {
    errors.push("all pages are missing required detection anchors");
  }
  if (!map.appVersion) {
    warnings.push("appVersion metadata missing; cannot compare map against live app version");
  }
  if (!map.deviceProfile?.width || !map.deviceProfile?.height) {
    warnings.push("deviceProfile resolution metadata missing; bounds are normalized but recording profile is unknown");
  }

  const expectedAppVersion = options.expectedAppVersion?.trim();
  if (expectedAppVersion && map.appVersion && map.appVersion !== expectedAppVersion) {
    stats.staleVersion = true;
    warnings.push(`appVersion mismatch: map=${map.appVersion}, expected=${expectedAppVersion}`);
  }

  const expectedWidth = options.expectedResolution?.width;
  const expectedHeight = options.expectedResolution?.height;
  if (
    expectedWidth
    && expectedHeight
    && map.deviceProfile?.width
    && map.deviceProfile?.height
    && (map.deviceProfile.width !== expectedWidth || map.deviceProfile.height !== expectedHeight)
  ) {
    stats.staleVersion = true;
    warnings.push(`resolution mismatch: map=${map.deviceProfile.width}x${map.deviceProfile.height}, expected=${expectedWidth}x${expectedHeight}`);
  }

  return {
    usable: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}
