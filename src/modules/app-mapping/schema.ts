/**
 * app-mapping/schema.ts
 * Types and validation for the App Map JSON schema.
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface AppMap {
  appId: string;
  appName: string;
  version: string;
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
