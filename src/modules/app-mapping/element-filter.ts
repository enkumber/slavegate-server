/**
 * app-mapping/element-filter.ts
 * Filters UI tree nodes to find "fixed" interactive elements worth mapping.
 *
 * Ignores: RecyclerView/ScrollView children, feed items, list items, invisible/decorative nodes.
 * Keeps: bottom nav, toolbar buttons, FABs, menu items, tabs, fixed buttons.
 */

import type { UiTreeNode, ElementDef } from "./schema";

// ─── Container classes whose children are dynamic (feed items, list items) ──

const DYNAMIC_CONTAINER_CLASSES = [
  "RecyclerView",
  "ScrollView",
  "HorizontalScrollView",
  "NestedScrollView",
  "ViewPager",
  "ViewPager2",
  "ListView",
  "GridView",
  "RecyclerView",
  "StaggeredGridLayoutManager",
  "LinearLayoutManager",
];

// ─── Element type detection ──────────────────────────────────────────────────

const TAB_INDICATORS = ["tab", "bottom_nav", "navigation_bar", "nav"];
const FAB_INDICATORS = ["fab", "floating_action", "action_button"];
const MENU_INDICATORS = ["menu", "overflow", "more", "settings", "navigation_drawer"];
const INPUT_INDICATORS = ["edittext", "input", "search", "textinput", "autocomplete"];
const TOGGLE_INDICATORS = ["switch", "toggle", "checkbox", "radiobutton", "compound_button"];

/**
 * Filter a UI tree and return only the relevant clickable elements.
 * Returns normalized ElementDefs ready for the app map.
 */
export function filterRelevantElements(
  uiTree: UiTreeNode[],
  screenWidth: number,
  screenHeight: number,
): ElementDef[] {
  const elements: ElementDef[] = [];
  const seenBounds = new Set<string>();

  function walk(nodes: UiTreeNode[], parentClassName: string, depth: number) {
    for (const node of nodes) {
      const cls = node.className || "";
      const parentCls = parentClassName;

      // Skip dynamic containers — don't recurse into them
      if (isDynamicContainer(cls)) {
        continue;
      }

      // Check if this node is worth including
      if (isRelevantElement(node, parentCls, depth)) {
        const el = toElementDef(node, screenWidth, screenHeight);
        if (el) {
          // Dedup by approximate bounds (avoid same-position duplicates)
          const boundsKey = `${Math.round(el.bounds.x * 100)},${Math.round(el.bounds.y * 100)}`;
          if (!seenBounds.has(boundsKey)) {
            seenBounds.add(boundsKey);
            elements.push(el);
          }
        }
      }

      // Recurse into children
      if (node.children) {
        walk(node.children, cls, depth + 1);
      }
    }
  }

  walk(uiTree, "", 0);
  return elements.length > 0 ? elements : collectFallbackBindableElements(uiTree, screenWidth, screenHeight);
}

/**
 * Is this element worth mapping?
 */
function isRelevantElement(node: UiTreeNode, parentClassName: string, depth: number): boolean {
  // Must be clickable
  if (!node.clickable) return false;

  // Must have valid bounds
  if (!node.bounds) return false;

  const { left, top, right, bottom } = node.bounds;
  const width = right - left;
  const height = bottom - top;

  // Skip tiny elements (< 20px)
  if (width < 20 || height < 20) return false;

  // Skip elements that are off-screen
  if (left < 0 || top < 0 || right < 0 || bottom < 0) return false;

  // Skip if parent is a dynamic container
  if (isDynamicContainer(parentClassName)) return false;

  // Skip very deep elements (likely dynamic content)
  if (depth > 20) return false;

  // Skip elements with generic or empty content (probably decorative)
  const hasContent =
    (node.resourceId && node.resourceId.length > 0) ||
    (node.text && node.text.trim().length > 0) ||
    (node.contentDescription && node.contentDescription.trim().length > 0);

  // At shallow depth, include even without content (might be icon buttons)
  if (depth <= 3) return true;

  return !!hasContent;
}

function collectFallbackBindableElements(
  uiTree: UiTreeNode[],
  screenWidth: number,
  screenHeight: number,
): ElementDef[] {
  const elements: ElementDef[] = [];
  const seen = new Set<string>();

  function walk(nodes: UiTreeNode[]) {
    for (const node of nodes) {
      if (elements.length >= 20) return;
      const el = isFallbackBindableNode(node, screenWidth, screenHeight)
        ? toElementDef(node, screenWidth, screenHeight)
        : null;

      if (el) {
        const key = el.resourceId || el.contentDescription || el.text || `${el.bounds.x}:${el.bounds.y}:${el.bounds.w}:${el.bounds.h}`;
        if (!seen.has(key)) {
          seen.add(key);
          elements.push(el);
        }
      }

      if (node.children) walk(node.children);
    }
  }

  walk(uiTree);
  return elements;
}

function isFallbackBindableNode(node: UiTreeNode, screenWidth: number, screenHeight: number): boolean {
  if (!node.bounds) return false;
  if (node.visible === false || node.enabled === false) return false;
  if (!node.resourceId?.trim() && !node.text?.trim() && !node.contentDescription?.trim()) return false;

  const { left, top, right, bottom } = node.bounds;
  const width = right - left;
  const height = bottom - top;
  if (width < 20 || height < 20) return false;
  if (left < 0 || top < 0 || right <= left || bottom <= top) return false;

  const coversScreen = screenWidth > 0
    && screenHeight > 0
    && width / screenWidth > 0.9
    && height / screenHeight > 0.9;
  if (coversScreen) return false;

  return true;
}

/**
 * Convert a UI tree node to a normalized ElementDef.
 */
function toElementDef(
  node: UiTreeNode,
  screenWidth: number,
  screenHeight: number,
): ElementDef | null {
  if (!node.bounds) return null;

  const { left, top, right, bottom } = node.bounds;

  if (screenWidth === 0 || screenHeight === 0) return null;

  const x = left / screenWidth;
  const y = top / screenHeight;
  const w = (right - left) / screenWidth;
  const h = (bottom - top) / screenHeight;

  return {
    type: detectElementType(node),
    bounds: {
      x: Math.round(x * 10000) / 10000,
      y: Math.round(y * 10000) / 10000,
      w: Math.round(w * 10000) / 10000,
      h: Math.round(h * 10000) / 10000,
    },
    resourceId: node.resourceId || "",
    text: node.text || "",
    contentDescription: node.contentDescription || "",
    selectorProvenance: selectorProvenance(node),
    semanticId: semanticId(node),
    clickable: true,
    leadsTo: null, // filled in later by recorder
  };
}

function selectorProvenance(node: UiTreeNode): ElementDef["selectorProvenance"] {
  const provenance: NonNullable<ElementDef["selectorProvenance"]> = [];
  if (node.resourceId?.trim()) provenance.push("resourceId");
  if (node.text?.trim()) provenance.push("text");
  if (node.contentDescription?.trim()) provenance.push("contentDescription");
  return provenance;
}

function semanticId(node: UiTreeNode): string {
  const source = node.resourceId || node.contentDescription || node.text;
  if (!source?.trim()) return "";
  return source
    .split("/")
    .pop()!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Detect semantic element type from node properties.
 */
function detectElementType(node: UiTreeNode): ElementDef["type"] {
  const rid = (node.resourceId || "").toLowerCase();
  const desc = (node.contentDescription || "").toLowerCase();
  const text = (node.text || "").toLowerCase();
  const cls = (node.className || "").toLowerCase();
  const combined = `${rid} ${desc} ${text}`;

  if (TAB_INDICATORS.some((t) => combined.includes(t))) return "tab";
  if (FAB_INDICATORS.some((t) => combined.includes(t))) return "fab";
  if (MENU_INDICATORS.some((t) => combined.includes(t))) return "menu_item";
  if (INPUT_INDICATORS.some((t) => cls.includes(t) || combined.includes(t))) return "input";
  if (TOGGLE_INDICATORS.some((t) => cls.includes(t) || combined.includes(t))) return "toggle";
  if (cls.includes("imageview") || cls.includes("imagebutton")) return "icon";
  if (cls.includes("button") || node.clickable) return "button";

  return "unknown";
}

/**
 * Check if a className represents a dynamic list/scroll container.
 */
function isDynamicContainer(className: string): boolean {
  if (!className) return false;
  return DYNAMIC_CONTAINER_CLASSES.some((dc) => className.includes(dc));
}

/**
 * Generate a stable element ID from its properties.
 */
export function generateElementId(element: ElementDef, pageIndex: number): string {
  // Prefer resourceId-based ID
  if (element.resourceId) {
    const short = element.resourceId.split("/").pop() || element.resourceId;
    return `${short}`;
  }

  // Fall back to text or content description
  if (element.text) {
    return `text_${element.text.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 30)}`;
  }
  if (element.contentDescription) {
    return `desc_${element.contentDescription.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 30)}`;
  }

  // Last resort: position-based
  return `el_${pageIndex}_${Math.round(element.bounds.x * 100)}_${Math.round(element.bounds.y * 100)}`;
}
