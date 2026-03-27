/**
 * agents/planner.agent.ts
 * Task decomposition — Claude Opus, one call per task.
 * 
 * Two-step process when screenshot provided:
 * 1. Ollama LLaVA describes the screen (vision) → text description
 * 2. Anthropic plans based on text description (no image) → JSON steps
 */

import { getLlmClient } from "./llm-client";
import { agentConfig } from "../../config/agents.config";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "./prompts/planner.prompt";
import { extractJson } from "../../utils/json-extract";
import type { PlannerInput, PlannerOutput, LlmContent } from "./types";

const SCREEN_DESCRIBE_PROMPT = `Describe this mobile app screenshot concisely for an automation planner.
Include:
- What app is shown and what screen/page (home feed, profile, search, etc.)
- Main visible UI elements (buttons, tabs, icons, text fields)
- Current state (e.g., "logged in as @username", "showing search results for X")
- Bottom navigation tabs if visible
- Any popups, dialogs, or overlays

Be factual and brief. Focus on actionable UI elements.`;

export class PlannerAgent {
  async plan(input: PlannerInput): Promise<{ output: PlannerOutput; tokens: { input: number; output: number } }> {
    const llm = getLlmClient();
    let screenDescription = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Step 1: If screenshot provided, describe it with Ollama (vision)
    if (input.currentScreenshot) {
      console.log(`[planner] Step 1: Describing screenshot with local vision...`);
      const describeResponse = await llm.complete({
        model: "llava:34b", // Force Ollama model
        systemPrompt: "",
        userContent: [
          { type: "image", base64: input.currentScreenshot },
          { type: "text", text: SCREEN_DESCRIBE_PROMPT },
        ],
        temperature: 0.3,
        maxTokens: 500,
      });
      screenDescription = describeResponse.text;
      totalInputTokens += describeResponse.inputTokens;
      totalOutputTokens += describeResponse.outputTokens;
      console.log(`[planner] Screen description: ${screenDescription.slice(0, 150)}...`);
    }

    // Step 2: Plan with Anthropic (text only, no image)
    const userContent: LlmContent[] = [];
    let userPrompt = buildPlannerUserPrompt(input.task, input.appContext, !!input.currentScreenshot);
    
    // Inject screen description into prompt
    if (screenDescription) {
      userPrompt = `Current screen state:\n${screenDescription}\n\n${userPrompt}`;
    }
    userContent.push({ type: "text", text: userPrompt });

    console.log(`[planner] Step 2: Planning task "${input.task}" for ${input.appContext} (text-only)`);

    const response = await llm.complete({
      model: agentConfig.planner.model,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userContent,
      temperature: agentConfig.planner.temperature,
      maxTokens: agentConfig.planner.maxTokens,
    });
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    const parsed = extractJson<PlannerOutput>(response.text);
    if (!parsed || !Array.isArray(parsed.steps)) {
      throw new Error(`Planner returned invalid output: ${response.text.slice(0, 200)}`);
    }

    // Ensure sequential IDs
    parsed.steps.forEach((step, i) => {
      if (step.id === undefined) step.id = i + 1;
    });

    console.log(`[planner] Plan created: ${parsed.steps.length} steps, complexity=${parsed.complexity}`);

    return {
      output: parsed,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
    };
  }
}

export const plannerAgent = new PlannerAgent();
