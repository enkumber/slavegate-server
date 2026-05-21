/**
 * generated-workflow-prompt.ts
 * Prompt builder for agent-generated WorkflowTemplate JSON.
 *
 * Agents use this contract before calling /api/workflows/generated/validate.
 */

import { getGeneratedWorkflowContract } from "./workflow-validator";
import type { AppMap } from "../app-mapping/schema";
import { ALL_SCREEN_IDS } from "../screen-detection/types";

export interface BuildGeneratedWorkflowPromptInput {
  platform: string;
  packageName: string;
  goal: string;
  clientContext?: string;
  availableScreens?: string[];
  appMapHints?: string[];
}

export function buildGeneratedWorkflowAppMapHints(appMap: AppMap, maxPages = 8, maxElementsPerPage = 6): string[] {
  const hints: string[] = [
    `App map ${appMap.appName} (${appMap.appId}) version ${appMap.version}: ${appMap.pageCount} pages, ${appMap.transitionCount} transitions`,
  ];

  const pages = Object.entries(appMap.pages)
    .sort(([, a], [, b]) => a.discoveryOrder - b.discoveryOrder)
    .slice(0, maxPages);

  for (const [pageId, page] of pages) {
    const anchors = page.detection.anchors.slice(0, 6).join(", ") || "no anchors";
    hints.push(`${pageId}: ${page.name}; signature=${page.detection.signatureHash}; anchors=${anchors}`);

    const elements = Object.entries(page.elements).slice(0, maxElementsPerPage);
    for (const [elementId, element] of elements) {
      const target = element.leadsTo ? ` -> ${element.leadsTo}` : "";
      const label = element.text || element.contentDescription || element.resourceId || "unlabeled";
      hints.push(`  ${elementId}: ${element.type}; label=${label}; center=${element.bounds.x + element.bounds.w / 2},${element.bounds.y + element.bounds.h / 2}${target}`);
    }
  }

  if (Object.keys(appMap.pages).length > maxPages) {
    hints.push(`... ${Object.keys(appMap.pages).length - maxPages} more app-map pages omitted`);
  }

  return hints;
}

export function resolveGeneratedWorkflowScreens(platform: string, provided?: string[]): string[] {
  if (provided && provided.length > 0) return provided;

  const normalized = platform.toLowerCase();
  const shared = ["KEYBOARD_OPEN", "ACTION_SHEET", "CONFIRMATION_DIALOG", "SUGGESTIONS_POPUP", "LOGIN_REQUIRED", "ACTION_BLOCKED", "UNKNOWN"];

  if (normalized === "reddit") {
    return ALL_SCREEN_IDS.filter((screen) => screen.startsWith("REDDIT_") || shared.includes(screen));
  }

  if (normalized === "instagram") {
    return ALL_SCREEN_IDS.filter((screen) => !screen.startsWith("REDDIT_"));
  }

  return shared;
}

function renderList(items: string[] | undefined, fallback: string): string {
  if (!items || items.length === 0) return fallback;
  return items.map((item) => `- ${item}`).join("\n");
}

export function buildGeneratedWorkflowPrompt(input: BuildGeneratedWorkflowPromptInput): string {
  const contract = getGeneratedWorkflowContract();

  return [
    "You are generating a Phone Network WorkflowTemplate for deterministic Android execution.",
    "Return ONLY valid JSON. Do not wrap it in markdown.",
    "",
    "## Goal",
    input.goal,
    "",
    "## Platform",
    `platform: ${input.platform}`,
    `packageName: ${input.packageName}`,
    "",
    "## Client Context",
    input.clientContext ?? "No extra client context provided.",
    "",
    "## Available Screens",
    renderList(input.availableScreens, "- No screen list provided; use conservative checkpoint ids."),
    "",
    "## App Map Hints",
    renderList(input.appMapHints, "- No app map hints provided; use target names from platform skills."),
    "",
    "## Server Contract",
    JSON.stringify(contract, null, 2),
    "",
    "## Rules",
    "- Generate a complete WorkflowTemplate object, not a wrapper.",
    "- The workflow id must be stable, lowercase, and specific to this generated goal.",
    "- Use action steps for deterministic device actions only.",
    "- Use wait steps for loading, debounce, or explicit UI conditions.",
    "- Use checkpoint steps after important navigation or irreversible actions.",
    "- Include expectedScreen on action steps when a known screen should result.",
    "- Keep runtime LLM calls at zero on the happy path.",
    "- After validation, cache compiledPlan.cacheKey and reuse the same validated workflow for identical goals/context.",
    "- Do not include client secrets, account passwords, API keys, or private tokens.",
    "- Do not add hardcoded content unless it is present in the client context or goal.",
    "- Prefer dry-run validation before persistence or execution.",
    "",
    "Return JSON now.",
  ].join("\n");
}
