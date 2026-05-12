/**
 * agents/verifier.agent.ts
 * Post-action verification — Claude Sonnet, one call per step.
 */

import { getLlmClient } from "./llm-client";
import { agentConfig } from "../../config/agents.config";
import { VERIFIER_SYSTEM_PROMPT, buildVerifierUserPrompt } from "./prompts/verifier.prompt";
import { extractJson } from "../../utils/json-extract";
import type { VerifierInput, VerifierOutput, LlmContent } from "./types";

export class VerifierAgent {

  async verify(input: VerifierInput): Promise<{ output: VerifierOutput; tokens: { input: number; output: number } }> {
    const llm = getLlmClient();

    const userContent: LlmContent[] = [
      { type: "image", base64: input.screenshotBefore },
      { type: "image", base64: input.screenshotAfter },
      {
        type: "text",
        text: buildVerifierUserPrompt(input.step, input.actionTaken),
      },
    ];

    console.log(`[verifier] Verifying step ${input.step.id}: "${input.step.description}"`);

    const response = await llm.complete({
      model: agentConfig.verifier.model,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userContent,
      temperature: agentConfig.verifier.temperature,
      maxTokens: agentConfig.verifier.maxTokens,
    });

    const parsed = extractJson<VerifierOutput>(response.text);
    if (!parsed?.status) {
      return {
        output: {
          status: "retry",
          reason: `Verifier couldn't parse result: ${response.text.slice(0, 100)}`,
          confidence: 0,
          shouldInvalidateCache: false,
        },
        tokens: { input: response.inputTokens, output: response.outputTokens },
      };
    }

    return {
      output: parsed,
      tokens: { input: response.inputTokens, output: response.outputTokens },
    };
  }
}

export const verifierAgent = new VerifierAgent();
