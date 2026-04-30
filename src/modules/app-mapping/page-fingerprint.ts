/**
 * app-mapping/page-fingerprint.ts
 * Page fingerprinting via UI tree signature hashing.
 *
 * Strategy: hash the combination of top-level node signatures (resourceId + className).
 * This is fast, reliable, and resolution-independent.
 */

import crypto from "crypto";
import type { UiTreeNode, PageDetection } from "./schema";

/**
 * Compute a signature hash for a UI tree.
 * Uses top-level children only (ignores deep nesting for stability).
 */
export function computePageSignature(uiTree: UiTreeNode[]): string {
  const parts: string[] = [];

  function collectTopLevel(nodes: UiTreeNode[], depth: number) {
    for (const node of nodes) {
      // Only go 2 levels deep for signature (stable across minor layout changes)
      if (depth > 2) return;

      const sig = nodeSignature(node);
      if (sig) parts.push(sig);

      if (node.children && depth < 2) {
        collectTopLevel(node.children, depth + 1);
      }
    }
  }

  collectTopLevel(uiTree, 0);

  // Sort for deterministic hashing
  parts.sort();

  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Single node signature: resourceId + className (normalized).
 */
function nodeSignature(node: UiTreeNode): string | null {
  const rid = node.resourceId?.trim();
  const cls = node.className?.trim();

  // Skip generic containers that add noise
  if (!rid && (!cls || isGenericContainer(cls))) return null;

  const ridPart = rid || "";
  const clsPart = simplifyClassName(cls || "");
  return `${ridPart}:${clsPart}`;
}

/**
 * Extract anchors from UI tree for page detection config.
 * Returns up to 5 distinctive anchors.
 */
export function extractAnchors(uiTree: UiTreeNode[]): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();

  function walk(nodes: UiTreeNode[]) {
    for (const node of nodes) {
      if (anchors.length >= 5) return;

      if (node.resourceId) {
        const anchor = `resourceId:${node.resourceId}`;
        if (!seen.has(anchor)) {
          anchors.push(anchor);
          seen.add(anchor);
        }
      }

      if (node.text && node.text.trim().length > 0 && node.text.trim().length < 50) {
        const anchor = `text:${node.text.trim()}`;
        if (!seen.has(anchor)) {
          anchors.push(anchor);
          seen.add(anchor);
        }
      }

      if (node.children) walk(node.children);
    }
  }

  walk(uiTree);
  return anchors;
}

/**
 * Build a PageDetection object from a UI tree.
 */
export function buildPageDetection(uiTree: UiTreeNode[]): PageDetection {
  return {
    method: "ui_tree_signature",
    anchors: extractAnchors(uiTree),
    signatureHash: computePageSignature(uiTree),
  };
}

/**
 * Compare two page signatures.
 * Returns true if they represent the same page.
 */
export function isSamePage(hash1: string, hash2: string): boolean {
  return hash1 === hash2;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isGenericContainer(className: string): boolean {
  return (
    className.includes("FrameLayout") ||
    className.includes("LinearLayout") ||
    className.includes("RelativeLayout") ||
    className.includes("ConstraintLayout") ||
    className.includes("ViewGroup") ||
    className === "android.view.View"
  );
}

function simplifyClassName(className: string): string {
  const parts = className.split(".");
  return parts[parts.length - 1] || className;
}
