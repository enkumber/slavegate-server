/**
 * agents/executor.agent.ts
 * Per-step execution — cascade first, LLM fallback (Sonnet).
 *
 * INTEGRATION: Uses existing cascade from skill.cascade.ts
 * Flow:
 *   1. Try cascade (L1→L1.5→L2→L2.5→L3) for known elements
 *   2. If cascade succeeds → return coords directly (zero LLM cost)
 *   3. If cascade fails → LLM with screenshot to determine action
 *
 * SPECULATIVE MODE (lookahead > 1):
 *   - LLM predicts actions for current + upcoming steps in ONE call
 *   - Orchestrator executes them sequentially with early exit on fail
 *   - Saves ~51% LLM calls (UFO paper)
 */

import { getLlmClient } from "./llm-client";
import { agentConfig } from "../../config/agents.config";
import {
  EXECUTOR_SYSTEM_PROMPT,
  EXECUTOR_SPECULATIVE_SYSTEM_PROMPT,
  buildExecutorUserPrompt,
  buildSpeculativeExecutorUserPrompt,
} from "./prompts/executor.prompt";
import { buildTipsContext } from "./self-evolution";
import { executeCascadeTap } from "../skills/skill.cascade";
import type { CascadeTapRequest, CascadeTapResult } from "../skills/skill.cascade";
import { extractJson } from "../../utils/json-extract";
import type { PlanStep, ExecutorInput, ExecutorOutput, ExecutorAction, LlmContent } from "./types";

export class ExecutorAgent {

  /**
   * Execute a single step. Returns primary action + optional speculative actions.
   * Cascade is tried first (zero LLM cost). LLM fallback uses speculative mode
   * when lookahead > 1 and remainingSteps are provided.
   */
  async execute(input: ExecutorInput): Promise<{ output: ExecutorOutput; tokens: { input: number; output: number } }> {
    const { step, deviceId, platform, screenshot, screenType } = input;

    // ─── Non-tap actions: no lookup needed ─────────────────────────────────
    if (step.action === "wait") {
      return {
        output: {
          action: { type: "wait", ms: (step.params?.ms as number) || 1000 },
          confidence: 1.0,
          reasoning: "Wait step — no element lookup needed",
          source: "llm_inferred",
        },
        tokens: { input: 0, output: 0 },
      };
    }

    if (step.action === "back") {
      return {
        output: {
          action: { type: "back" },
          confidence: 1.0,
          reasoning: "Back navigation — no element lookup needed",
          source: "llm_inferred",
        },
        tokens: { input: 0, output: 0 },
      };
    }

    if (step.action === "type") {
      // Get text from params.text ONLY — never fallback to target (which is element name)
      const textToType = (step.params?.text as string) || "";
      if (!textToType) {
        console.warn(`[executor] Type action missing params.text for step ${step.id}, skipping`);
      }
      return {
        output: {
          action: { type: "type", text: textToType },
          confidence: textToType ? 1.0 : 0,
          reasoning: textToType ? "Type action — text input" : "Type action missing text",
          source: "llm_inferred",
        },
        tokens: { input: 0, output: 0 },
      };
    }

    // ─── Tap/scroll: try cascade first ─────────────────────────────────────
    if ((step.action === "tap" || step.action === "scroll") && step.target) {
      const cascadeResult = await this.tryCascade(step, deviceId, platform, screenType);

      if (cascadeResult?.success && cascadeResult.coords) {
        console.log(`[executor] Cascade hit for step ${step.id}: ${step.target} via ${cascadeResult.method}`);
        return {
          output: {
            action: {
              type: "tap",
              x: cascadeResult.coords.x,
              y: cascadeResult.coords.y,
              element: step.target,
            },
            confidence: cascadeResult.method === "coords" ? 0.9 : 0.85,
            reasoning: `Found via cascade ${cascadeResult.method} (chain: ${cascadeResult.fallbackChain.join(" → ")})`,
            source: "cascade",
            cascadeLevel: cascadeResult.fallbackChain.find(
              (f: string) => f.startsWith("L") && !f.includes("error") && !f.includes("miss") && !f.includes("failed")
            ) || cascadeResult.method,
            // No speculative actions on cascade — only LLM can predict ahead
          },
          tokens: { input: 0, output: 0 },
        };
      }
      console.log(`[executor] Cascade miss for step ${step.id}: ${step.target}, falling back to LLM`);
    }

    // ─── LLM fallback (with speculative lookahead if configured) ────────────
    const lookahead = input.lookahead ?? agentConfig.executor.lookahead;
    const hasUpcoming = input.remainingSteps && input.remainingSteps.length > 0 && lookahead > 1;

    if (hasUpcoming) {
      return this.speculativeLlmFallback(input, lookahead);
    }
    return this.llmFallback(input);
  }

  private async tryCascade(
    step: PlanStep,
    deviceId: string,
    platform: string,
    screenType?: string
  ): Promise<CascadeTapResult | null> {
    if (!step.target) return null;

    try {
      const req: CascadeTapRequest = {
        workflowId: "",
        deviceId,
        stepIndex: step.id,
        platform,
        elementName: step.target,
        currentScreen: screenType || step.expectedScreen,
        timeoutMs: 5_000,
      };
      return await executeCascadeTap(req);
    } catch (err) {
      console.warn(`[executor] Cascade error for ${step.target}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Single-action LLM fallback ───────────────────────────────────────────

  private async llmFallback(
    input: ExecutorInput
  ): Promise<{ output: ExecutorOutput; tokens: { input: number; output: number } }> {
    const llm = getLlmClient();
    const tips = await buildTipsContext(input.platform);

    const userContent: LlmContent[] = [
      { type: "image", base64: input.screenshot },
    ];

    if (input.uiTree) {
      userContent.push({ type: "text", text: `UI Accessibility Tree:\n${input.uiTree}` });
    }

    userContent.push({
      type: "text",
      text: buildExecutorUserPrompt(input.step, !!input.uiTree, undefined, tips),
    });

    const response = await llm.complete({
      model: agentConfig.executor.model,
      systemPrompt: EXECUTOR_SYSTEM_PROMPT,
      userContent,
      temperature: agentConfig.executor.temperature,
      maxTokens: agentConfig.executor.maxTokens,
    });

    const parsed = extractJson<ExecutorOutput>(response.text);
    if (!parsed?.action) {
      return {
        output: {
          action: { type: "skip", reason: `LLM couldn't determine action: ${response.text.slice(0, 100)}` },
          confidence: 0,
          reasoning: "LLM fallback failed to parse",
          source: "llm_inferred",
        },
        tokens: { input: response.inputTokens, output: response.outputTokens },
      };
    }

    return {
      output: { ...parsed, source: "llm_inferred" },
      tokens: { input: response.inputTokens, output: response.outputTokens },
    };
  }

  // ─── Speculative multi-action LLM fallback ────────────────────────────────

  private async speculativeLlmFallback(
    input: ExecutorInput,
    lookahead: number,
  ): Promise<{ output: ExecutorOutput; tokens: { input: number; output: number } }> {
    const llm = getLlmClient();
    const upcoming = (input.remainingSteps || []).slice(0, lookahead - 1);

    console.log(`[executor] Speculative mode: step ${input.step.id} + ${upcoming.length} lookahead`);

    const userContent: LlmContent[] = [
      { type: "image", base64: input.screenshot },
    ];

    if (input.uiTree) {
      userContent.push({ type: "text", text: `UI Accessibility Tree:\n${input.uiTree}` });
    }

    userContent.push({
      type: "text",
      text: buildSpeculativeExecutorUserPrompt(input.step, upcoming, !!input.uiTree),
    });

    const response = await llm.complete({
      model: agentConfig.executor.model,
      systemPrompt: EXECUTOR_SPECULATIVE_SYSTEM_PROMPT,
      userContent,
      temperature: agentConfig.executor.temperature,
      maxTokens: agentConfig.executor.maxTokens * 2, // More tokens for multi-action output
    });

    const parsed = extractJson<{
      action: ExecutorAction;
      confidence: number;
      reasoning: string;
      speculativeActions?: Array<ExecutorAction & {
        _stepId?: number;
        _confidence?: number;
        _reasoning?: string;
      }>;
    }>(response.text);

    if (!parsed?.action) {
      return {
        output: {
          action: { type: "skip", reason: `Speculative LLM failed: ${response.text.slice(0, 100)}` },
          confidence: 0,
          reasoning: "Speculative LLM fallback failed to parse",
          source: "llm_inferred",
        },
        tokens: { input: response.inputTokens, output: response.outputTokens },
      };
    }

    // Convert speculative actions (strip _ prefixed metadata into clean ExecutorActions)
    const specActions: ExecutorAction[] = [];
    if (parsed.speculativeActions && Array.isArray(parsed.speculativeActions)) {
      for (const sa of parsed.speculativeActions) {
        const { _stepId, _confidence, _reasoning, ...cleanAction } = sa;
        // Only keep speculative actions with reasonable confidence
        if ((_confidence ?? 0.5) >= 0.5) {
          specActions.push(cleanAction);
          console.log(`[executor] Speculative action for step ${_stepId}: ${cleanAction.type} (conf=${_confidence?.toFixed(2)})`);
        } else {
          console.log(`[executor] Dropping low-confidence speculative step ${_stepId} (conf=${_confidence?.toFixed(2)})`);
          break; // Stop at first low-confidence — later ones are even less reliable
        }
      }
    }

    console.log(`[executor] Speculative result: 1 primary + ${specActions.length} predicted actions`);

    return {
      output: {
        action: parsed.action,
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning ?? "Speculative execution",
        source: "llm_inferred",
        speculativeActions: specActions.length > 0 ? specActions : undefined,
      },
      tokens: { input: response.inputTokens, output: response.outputTokens },
    };
  }
}

export const executorAgent = new ExecutorAgent();
