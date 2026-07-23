/**
 * workflow-compiler/prompt-builder.ts
 * Build LLM prompts from AppMap for AI Planning (Level 3).
 *
 * Takes an AppMap (pages, elements, transitions) and a natural language
 * instruction, then produces a structured prompt that guides the LLM
 * to output a valid CompiledWorkflow JSON.
 *
 * Story: US-WORKFLOW-COMPILER
 */

import type { AppMap, PageDef, ElementDef } from "../app-mapping/schema";
import type { CompiledAction } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildPromptOptions {
  /** Include verbose element details (bounds, clickable, etc.) — default: false */
  verbose?: boolean;
  /** Max pages to include in prompt (avoids token overflow for large apps) — default: 50 */
  maxPages?: number;
}

/**
 * Build a complete LLM prompt for workflow compilation.
 *
 * @param appMap     — The app map from DB (pages, elements, transitions)
 * @param instruction — Natural language workflow instruction.
 * @param options    — Optional tuning
 * @returns The full prompt string ready to send to an LLM
 */
export function buildCompilePrompt(
  appMap: AppMap,
  instruction: string,
  options?: BuildPromptOptions,
): string {
  const verbose = options?.verbose ?? false;
  const maxPages = options?.maxPages ?? 50;

  const pagesSection = buildPagesSection(appMap, verbose, maxPages);
  const transitionsSection = buildTransitionsSection(appMap, maxPages);

  return [
    SYSTEM_HEADER,
    "",
    PAGES_HEADER,
    pagesSection,
    "",
    TRANSITIONS_HEADER,
    transitionsSection,
    "",
    ACTIONS_HEADER,
    AVAILABLE_ACTIONS.map(describeAction).join("\n"),
    "",
    OUTPUT_FORMAT_HEADER,
    OUTPUT_FORMAT_SPEC,
    "",
    RULES_HEADER,
    RULES,
    "",
    INSTRUCTION_HEADER,
    instruction,
    "",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_HEADER = `You are a workflow compiler. Given an app map (pages, elements, transitions) and a natural language instruction, produce a compiled workflow JSON.`;

const PAGES_HEADER = "## APP MAP — PAGES & ELEMENTS";

const TRANSITIONS_HEADER = "## APP MAP — PAGE TRANSITIONS";

const ACTIONS_HEADER = "## AVAILABLE ACTIONS";

const OUTPUT_FORMAT_HEADER = "## OUTPUT FORMAT";

const OUTPUT_FORMAT_SPEC = `Return a JSON object with a single key "steps" — an array of step objects:

\`\`\`json
{
  "steps": [
    {
      "id": "s1",
      "action": "screen_wake" | "unlock" | "tap" | "type" | "swipe" | "press_key" | "wait" | "open_app" | "intent_send" | "screenshot",
      "target": {
        "elementId": "<element-id-from-app-map>",
        "resourceId": "<android-resource-id>",
        "text": "<visible-text>",
        "coords": { "x": 0.5, "y": 0.5 }
      },
      "params": { "text": "value to type", "packageName": "com.example.app" },
      "expectedPage": "<page-id-from-app-map>",
      "expectedPageHash": "<signatureHash-from-app-map>",
      "retries": 1,
      "retryDelay": 500,
      "description": "Human-readable: what this step does"
    }
  ]
}
\`\`\`

Rules for each field:
- "id": unique step identifier, format "s1", "s2", ...
- "action": one of the available actions listed above
- "target": optional — use elementId from app map when available (most reliable), then resourceId, text, coords as fallbacks. Omit for actions like open_app or wait.
- "params": action-specific parameters (e.g. "text" for type, "direction" for swipe, "key" for press_key, "durationMs" for wait, "packageName" for open_app, "uri" for intent_send)
- "expectedPage": the page ID from the app map you expect to be on after this step
- "expectedPageHash": the signatureHash from the page detection in the app map
- "retries": number of retry attempts (default: 1)
- "retryDelay": ms between retries (default: 500)
- "description": human-readable explanation (used for AI recovery context)`;

const RULES_HEADER = "## RULES";

const RULES = `1. Use elementId from the app map when available — it is the most reliable targeting method.
2. Each step MUST have expectedPage and expectedPageHash from the app map for verification.
3. Include a human-readable description for every step.
4. Start from the app's home/main page (discoveryOrder: 0).
5. Navigate using the page transitions defined in the app map — do not invent transitions.
6. For "type" actions, put the text value in params.text.
7. For "open_app", put the package name in params.packageName. For "intent_send", put the URL/deep link in params.uri.
8. For "swipe", use params.direction ("up", "down", "left", "right") and optionally params.distance (0.0–1.0).
9. For "press_key", use params.key (e.g. "back", "enter", "home").
10. For "wait", use params.durationMs (ms) — use sparingly, only when needed for loading.
11. Use coords as last resort — resource-id and text are more stable across devices.
12. Keep the workflow minimal — fewest steps to accomplish the task.`;

const INSTRUCTION_HEADER = "## INSTRUCTION";

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

const AVAILABLE_ACTIONS: CompiledAction[] = [
  "screen_wake",
  "unlock",
  "tap",
  "type",
  "swipe",
  "press_key",
  "wait",
  "open_app",
  "intent_send",
  "screenshot",
];

function describeAction(action: CompiledAction): string {
  const descriptions: Record<CompiledAction, string> = {
    screen_wake: "- screen_wake: Wake the device display. No target or params needed.",
    unlock:     "- unlock: Unlock the device before app interaction. No target or params needed.",
    tap:        "- tap: Click on a UI element. Requires target (elementId, resourceId, text, or coords).",
    type:       "- type: Type text into a focused input field. Requires params.text. Tap the input first to focus it.",
    swipe:      "- swipe: Swipe gesture. Requires params.direction (up/down/left/right). Optionally params.distance (0.0–1.0).",
    press_key:  "- press_key: Press a hardware/system key. Requires params.key (back, enter, home, tab, etc.).",
    wait:       "- wait: Wait for a duration. Requires params.durationMs (ms). Use only when loading is expected.",
    open_app:   "- open_app: Open an app by package name. Requires params.packageName. No target needed.",
    intent_send: "- intent_send: Open a URL or deep link through Android intent resolution. Requires params.uri. Optional params.packageName only when a specific installed app is required.",
    screenshot: "- screenshot: Capture current screen. No target or params needed. Used for verification.",
  };
  return descriptions[action];
}

function buildPagesSection(
  appMap: AppMap,
  verbose: boolean,
  maxPages: number,
): string {
  const pages = Object.entries(appMap.pages)
    .sort(([, a], [, b]) => a.discoveryOrder - b.discoveryOrder)
    .slice(0, maxPages);

  const lines: string[] = [`App: ${appMap.appName} (${appMap.appId})`];
  lines.push(`Version: ${appMap.version}`);
  lines.push(`Pages: ${appMap.pageCount} | Transitions: ${appMap.transitionCount}`);
  lines.push("");

  for (const [pageId, page] of pages) {
    lines.push(`### Page: ${pageId}`);
    lines.push(`  Name: ${page.name}`);
    lines.push(`  Signature: ${page.detection.signatureHash}`);
    lines.push(`  Anchors: ${page.detection.anchors.join(", ") || "none"}`);
    lines.push(`  Discovery order: ${page.discoveryOrder}`);
    lines.push("");

    const elements = Object.entries(page.elements);
    if (elements.length === 0) {
      lines.push("  (no elements)");
    } else {
      lines.push("  Elements:");
      for (const [elemId, elem] of elements) {
        lines.push(buildElementLine(elemId, elem, verbose));
      }
    }
    lines.push("");
  }

  if (Object.keys(appMap.pages).length > maxPages) {
    lines.push(`[... ${Object.keys(appMap.pages).length - maxPages} more pages omitted]`);
  }

  return lines.join("\n");
}

function buildElementLine(elemId: string, elem: ElementDef, verbose: boolean): string {
  const parts = [`    ${elemId}: [${elem.type}]`];

  if (elem.resourceId) parts.push(`resourceId="${elem.resourceId}"`);
  if (elem.text) parts.push(`text="${elem.text}"`);
  if (elem.contentDescription) parts.push(`desc="${elem.contentDescription}"`);
  if (elem.leadsTo) parts.push(`→ ${elem.leadsTo}`);

  if (verbose) {
    const b = elem.bounds;
    parts.push(`bounds=(${b.x.toFixed(2)},${b.y.toFixed(2)} ${b.w.toFixed(2)}x${b.h.toFixed(2)})`);
    if (elem.clickable) parts.push("clickable");
  }

  return parts.join(" ");
}

function buildTransitionsSection(appMap: AppMap, maxPages: number): string {
  const lines: string[] = [];
  const pages = Object.entries(appMap.pages)
    .slice(0, maxPages);

  for (const [pageId, page] of pages) {
    const transitions: string[] = [];
    for (const [elemId, elem] of Object.entries(page.elements)) {
      if (elem.leadsTo && elem.leadsTo !== "self") {
        transitions.push(`  ${elemId} → ${elem.leadsTo}`);
      } else if (elem.leadsTo === "self") {
        transitions.push(`  ${elemId} → (same page)`);
      }
    }

    if (transitions.length > 0) {
      lines.push(`From ${pageId}:`);
      lines.push(...transitions);
    }
  }

  if (lines.length === 0) {
    lines.push("(no transitions recorded)");
  }

  return lines.join("\n");
}
