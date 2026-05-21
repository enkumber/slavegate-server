/**
 * generated-workflow-prompt.ts
 * Prompt builder for agent-generated WorkflowTemplate JSON.
 *
 * Agents use this contract before calling /api/workflows/generated/validate.
 */

import { getGeneratedWorkflowContract } from "./workflow-validator";

export interface BuildGeneratedWorkflowPromptInput {
  platform: string;
  packageName: string;
  goal: string;
  clientContext?: string;
  availableScreens?: string[];
  appMapHints?: string[];
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
    "- Do not include client secrets, account passwords, API keys, or private tokens.",
    "- Do not add hardcoded content unless it is present in the client context or goal.",
    "- Prefer dry-run validation before persistence or execution.",
    "",
    "Return JSON now.",
  ].join("\n");
}
