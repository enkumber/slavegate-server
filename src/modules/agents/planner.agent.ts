/**
 * agents/planner.agent.ts
 * Task decomposition — Claude Opus, one call per task.
 */

import { getLlmClient } from "./llm-client";
import { agentConfig } from "../../config/agents.config";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "./prompts/planner.prompt";
import { extractJson } from "../../utils/json-extract";
import type { PlannerInput, PlannerOutput, LlmContent } from "./types";

export class PlannerAgent {
  async plan(input: PlannerInput): Promise<{ output: PlannerOutput; tokens: { input: number; output: number } }> {
    const llm = getLlmClient();
    const hasScreenshot = !!input.currentScreenshot;

    const userContent: LlmContent[] = [];
    if (input.currentScreenshot) {
      userContent.push({ type: "image", base64: input.currentScreenshot });
    }
    userContent.push({
      type: "text",
      text: buildPlannerUserPrompt(input.task, input.appContext, hasScreenshot),
    });

    console.log(`[planner] Planning task: "${input.task}" for ${input.appContext}`);

    const response = await llm.complete({
      model: agentConfig.planner.model,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userContent,
      temperature: agentConfig.planner.temperature,
      maxTokens: agentConfig.planner.maxTokens,
    });

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
      tokens: { input: response.inputTokens, output: response.outputTokens },
    };
  }
}

export const plannerAgent = new PlannerAgent();
