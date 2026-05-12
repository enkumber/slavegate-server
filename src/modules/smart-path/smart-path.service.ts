/**
 * smart-path.service.ts
 * Smart-Path fallback: when a batch step fails, analyze screen and determine recovery action.
 */

import { getDb } from "../../db/client";
import { visionService } from "../vision/vision.service";
import { isDenyListed } from "./prompts/recovery-prompt";
import type { BatchStep } from "../../protocol/batch-types";

export interface RecoveryAction {
  type: "dismiss" | "wait" | "scroll" | "retry" | "navigate_back" | "escalate";
  target?: string;
  direction?: "up" | "down" | "left" | "right";
  params?: Record<string, unknown>;
  reason?: string;
}

export interface SmartPathAnalysis {
  analysis: string;
  currentScreen: string;
  blockingElement: string | null;
  recoveryAction: RecoveryAction;
  denyList: boolean;
  confidence: number;
}

export interface SmartPathContext {
  workflowId: string;
  deviceId: string;
  failedStep: BatchStep;
  errorDescription: string;
  screenshot?: string;      // base64
  uiTree?: string;           // accessibility tree dump
  attempt: number;           // 1 = first retry, 2 = escalate
}

const SMART_PATH_TIMEOUT_MS = 30_000;
const MIN_CONFIDENCE = 0.6;

export const smartPathService = {
  /**
   * Handle a failed batch step with Smart-Path recovery.
   * Returns recovery action to take, or "escalate" if cannot recover.
   */
  async analyzeAndRecover(ctx: SmartPathContext): Promise<RecoveryAction> {
    const { failedStep, errorDescription, screenshot, uiTree, attempt } = ctx;

    // Check deny-list FIRST
    const target = failedStep.target ?? "";
    if (isDenyListed(target)) {
      console.warn(`[smart-path] DENY_LIST triggered for: ${target}`);
      return {
        type: "escalate",
        reason: `Target "${target}" is on deny-list — manual intervention required`,
      };
    }

    // Check attempt count
    if (attempt >= 2) {
      console.warn(`[smart-path] Max retries reached for step`);
      return {
        type: "escalate",
        reason: "Max retries (2) exhausted — escalate to human review",
      };
    }

    // Need screenshot + uiTree for VLM analysis
    if (!screenshot || !uiTree) {
      console.warn(`[smart-path] Missing screenshot or uiTree — cannot analyze`);
      return { type: "escalate", reason: "Missing screen data for analysis" };
    }

    // Call VLM for analysis
    const analysis = await analyzeScreenImpl(
      screenshot,
      uiTree,
      failedStep,
      errorDescription
    );

    if (!analysis) {
      return { type: "escalate", reason: "VLM analysis failed" };
    }

    // Log analysis
    await logAnalysisImpl(ctx, analysis);

    // Validate confidence
    if (analysis.confidence < MIN_CONFIDENCE) {
      console.warn(`[smart-path] Low confidence (${analysis.confidence}) — escalate`);
      return {
        type: "escalate",
        reason: `Low confidence (${analysis.confidence}) — manual review needed`,
      };
    }

    // Deny-list check on recovered target
    if (analysis.recoveryAction.target && isDenyListed(analysis.recoveryAction.target)) {
      console.warn(`[smart-path] Recovery target "${analysis.recoveryAction.target}" is deny-listed`);
      return {
        type: "escalate",
        reason: `Recovery action targets deny-listed element`,
      };
    }

    console.log(
      `[smart-path] Recovery: ${analysis.recoveryAction.type} → ${analysis.recoveryAction.target ?? "none"} ` +
      `(confidence: ${analysis.confidence})`
    );

    return analysis.recoveryAction;
  },

  /**
   * Build a recovery step from a Smart-Path action.
   * Used by workflow executor to inject recovery step into batch.
   */
  buildRecoveryStep(
    action: RecoveryAction,
    _originalStepId: number
  ): { type: "action"; action: string; target: string | null; params: Record<string, unknown> } {
    switch (action.type) {
      case "dismiss":
        return {
          type: "action",
          action: "tap",
          target: action.target ?? "outside",
          params: {},
        };

      case "scroll":
        return {
          type: "action",
          action: "swipe",
          target: null,
          params: {
            direction: action.direction ?? "up",
            durationMs: 300,
          },
        };

      case "wait":
        return {
          type: "action",
          action: "wait",
          target: null,
          params: { durationMs: action.params?.durationMs ?? 2000 },
        };

      case "navigate_back":
        return {
          type: "action",
          action: "press_back",
          target: null,
          params: {},
        };

      case "retry":
      case "escalate":
      default:
        return {
          type: "action",
          action: "escalate",
          target: null,
          params: { reason: action.reason },
        };
    }
  },
};

/**
 * Call VLM to analyze the screen and determine recovery action.
 */
async function analyzeScreenImpl(
  screenshot: string,
  uiTree: string,
  failedStep: BatchStep,
  errorDescription: string
): Promise<SmartPathAnalysis | null> {
  try {
    const prompt = buildAnalysisPrompt(failedStep, errorDescription, uiTree);
    const response = await visionService.analyzeCustomPrompt(screenshot, prompt, {
      timeoutMs: SMART_PATH_TIMEOUT_MS,
      maxTokens: 1024,
    });

    return parseVlmResponse(response);
  } catch (err) {
    console.error(`[smart-path] VLM analysis failed:`, err);
    return null;
  }
}

/**
 * Build the analysis prompt for VLM.
 */
function buildAnalysisPrompt(
  failedStep: BatchStep,
  errorDescription: string,
  uiTree: string
): string {
  const actionStep = failedStep.type === "action" ? failedStep : null;
  return `STEP THAT FAILED:
- Action: ${actionStep?.action ?? "unknown"}
- Target: ${actionStep?.target ?? "unknown"}
- Expected result: ${actionStep?.verify?.expectedScreen ?? "verification passed"}

ERROR FROM DEVICE:
${errorDescription}

UI_ACCESSIBILITY_TREE:
${uiTree.slice(0, 8000)}

ANALYZE the current screen and determine the best recovery action.
Return ONLY valid JSON:
{
  "analysis": "brief description",
  "current_screen": "feed|home|post_detail|profile|settings|popup|dialog|unknown",
  "blocking_element": "element_id or null",
  "recovery_action": {
    "type": "dismiss|wait|scroll|retry|navigate_back|escalate",
    "target": "element_id or null",
    "direction": "up|down|left|right or null",
    "params": {}
  },
  "deny_list": true|false,
  "confidence": 0.0-1.0
}`;
}

/**
 * Parse VLM response to extract recovery action.
 */
function parseVlmResponse(response: string): SmartPathAnalysis | null {
  if (!response) return null;

  // Extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      analysis: parsed.analysis ?? "unknown",
      currentScreen: parsed.current_screen ?? "unknown",
      blockingElement: parsed.blocking_element ?? null,
      recoveryAction: {
        type: parsed.recovery_action?.type ?? "escalate",
        target: parsed.recovery_action?.target,
        direction: parsed.recovery_action?.direction,
        params: parsed.recovery_action?.params ?? {},
      },
      denyList: parsed.deny_list ?? false,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.0,
    };
  } catch {
    return null;
  }
}

/**
 * Log Smart-Path analysis to DB for audit/debugging.
 */
async function logAnalysisImpl(
  ctx: SmartPathContext,
  analysis: SmartPathAnalysis
): Promise<void> {
  try {
    const db = getDb();
    await db.query(
      `INSERT INTO smart_path_logs
       (workflow_id, device_id, step_type, target, error, analysis, recovery_type, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        ctx.workflowId,
        ctx.deviceId,
        ctx.failedStep.type,
        ctx.failedStep.target ?? "",
        ctx.errorDescription,
        analysis.analysis,
        analysis.recoveryAction.type,
        analysis.confidence,
      ]
    );
  } catch (err) {
    console.warn(`[smart-path] Failed to log analysis:`, err);
  }
}
