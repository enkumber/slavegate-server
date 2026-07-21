import type { UiTreeNode } from "../app-mapping/schema";

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Normalize every Android UI-tree result envelope used by the fleet. */
export function normalizeUiTreeOutput(output: unknown): UiTreeNode[] {
  const envelope = output && typeof output === "object"
    ? output as Record<string, unknown>
    : null;
  const parsed = parseJson(envelope?.tree ?? envelope?.uiTree ?? output);

  if (Array.isArray(parsed)) return parsed as UiTreeNode[];
  if (!parsed || typeof parsed !== "object") return [];

  const object = parsed as Record<string, unknown>;
  if (Array.isArray(object.nodes)) return object.nodes as UiTreeNode[];

  const root = parseJson(object.root);
  if (Array.isArray(root)) return root as UiTreeNode[];
  if (root && typeof root === "object") return [root as UiTreeNode];

  // Current Android agents serialize a single accessibility root node.
  if ("children" in object || "className" in object || "resourceId" in object) {
    return [object as unknown as UiTreeNode];
  }

  return [];
}
