/**
 * workflow-compiler/recovery.service.ts
 * Nivel 2: AI Recovery — handles execution failures with AI fallback.
 *
 * When the deterministic runner encounters a mismatch or failure:
 *   1. Capture screenshot + UI tree of current state
 *   2. Build recovery prompt with failed step context
 *   3. Call LLM for recovery decision
 *   4. Execute recovery action (retry / adapt / dismiss / navigate back / abort)
 *   5. Track recovery attempts (per-step + per-workflow limits)
 *   6. Log recovery history
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "../../db/client";
import { sendJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import { computePageSignature } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import { llmJson } from "../../utils/llm";
import type { CompiledStep } from "./types";
import type { RunnerContext } from "./runner.service";
import { validateStepSchema } from "./workflow-validator";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type RecoveryAction =
  | { type: "retry_step" }
  | { type: "retry_with_adaptation"; adaptedStep: CompiledStep }
  | { type: "dismiss_and_retry"; dismissActions: CompiledStep[] }
  | { type: "navigate_back_and_retry"; backSteps: number }
  | { type: "abort"; reason: string };

export interface RecoveryContext {
  deviceId: string;
  workflowId: string;
  failedStep: CompiledStep;
  stepIndex: number;
  failureReason: string;
  screenshotBase64?: string;
  uiTree?: UiTreeNode[];
  currentFingerprint?: string;
}

export interface RecoveryResult {
  action: RecoveryAction;
  executed: boolean;
  success: boolean;
  llmLatencyMs: number;
  totalLatencyMs: number;
  error?: string;
}

export interface RecoveryHistoryEntry {
  workflowId: string;
  stepIndex: number;
  stepId: string;
  failureReason: string;
  recoveryAction: string;
  success: boolean;
  screenshotAvailable: boolean;
  uiTreeHash?: string;
  llmModel: string;
  llmLatencyMs: number;
  totalLatencyMs: number;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_RECOVERY_PER_STEP = 3;
const MAX_RECOVERY_PER_WORKFLOW = 10;
const DEFAULT_RECOVERY_MODEL = "openai-codex/gpt-5.5";

// Track per-step recovery counts with TTL (auto-expire after 30 min)
const RECOVERY_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface RecoveryCountEntry {
  count: number;
  expiresAt: number;
}

const stepRecoveryCounts = new Map<string, RecoveryCountEntry>();

function stepKey(workflowId: string, stepIndex: number): string {
  return `${workflowId}:${stepIndex}`;
}

function getStepRecoveryCount(workflowId: string, stepIndex: number): number {
  const entry = stepRecoveryCounts.get(stepKey(workflowId, stepIndex));
  if (!entry) return 0;
  if (Date.now() > entry.expiresAt) {
    stepRecoveryCounts.delete(stepKey(workflowId, stepIndex));
    return 0;
  }
  return entry.count;
}

function incrementStepRecoveryCount(workflowId: string, stepIndex: number): void {
  const key = stepKey(workflowId, stepIndex);
  const existing = stepRecoveryCounts.get(key);
  if (existing && Date.now() <= existing.expiresAt) {
    existing.count++;
  } else {
    stepRecoveryCounts.set(key, { count: 1, expiresAt: Date.now() + RECOVERY_TTL_MS });
  }
}

/**
 * Reset recovery counts for a workflow (called when workflow starts/ends).
 */
export function resetRecoveryCounts(workflowId: string): void {
  const keysToDelete: string[] = [];
  stepRecoveryCounts.forEach((_, key) => {
    if (key.startsWith(`${workflowId}:`)) keysToDelete.push(key);
  });
  for (const key of keysToDelete) {
    stepRecoveryCounts.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT + UI TREE CAPTURE
// ═══════════════════════════════════════════════════════════════════════════════

async function captureScreenshot(deviceId: string): Promise<string | undefined> {
  try {
    const jobId = uuidv4();
    const sent = sendJobToDevice(deviceId, {
      jobId,
      type: "screenshot",
      params: {},
      timeoutMs: 10_000,
    });
    if (!sent) return undefined;

    const result = await waitForResult(jobId, 10_000);
    return result?.output?.image_base64 as string | undefined;
  } catch {
    return undefined;
  }
}

async function captureUiTreeForRecovery(deviceId: string): Promise<UiTreeNode[]> {
  try {
    const jobId = uuidv4();
    const sent = sendJobToDevice(deviceId, {
      jobId,
      type: "ui_tree_dump",
      params: {},
      timeoutMs: 10_000,
    });
    if (!sent) return [];

    const result = await waitForResult(jobId, 10_000);
    const tree = result?.output?.tree || result?.output;
    return Array.isArray(tree) ? tree : [];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOVERY PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildRecoveryPrompt(
  ctx: RecoveryContext,
  uiTreeSummary: string
): string {
  return `You are an Android workflow recovery agent. A deterministic workflow step failed.

FAILED STEP:
- Action: ${ctx.failedStep.action}
- Description: ${ctx.failedStep.description}
- Expected page: ${ctx.failedStep.expectedPage} (hash: ${ctx.failedStep.expectedPageHash})
- Failure reason: ${ctx.failureReason}

CURRENT STATE:
- Current fingerprint: ${ctx.currentFingerprint || "unknown"}
- UI tree summary (top-level elements):
${uiTreeSummary || "Not available"}

AVAILABLE RECOVERY ACTIONS (respond with JSON):
1. { "type": "retry_step" } — Just retry the same step
2. { "type": "retry_with_adaptation", "adaptedStep": { ...CompiledStep } } — Retry with modified step
3. { "type": "dismiss_and_retry", "dismissActions": [ { ...CompiledStep }, ... ] } — Dismiss popup then retry
4. { "type": "navigate_back_and_retry", "backSteps": 1 } — Press back N times then retry
5. { "type": "abort", "reason": "..." } — Cannot recover, abort workflow

DECISION GUIDELINES:
- If a popup/dialog appeared -> dismiss_and_retry (tap OK/Close button)
- If element is scrolled out -> retry_with_adaptation (add swipe up before tap)
- If wrong page -> navigate_back_and_retry
- If element not found but page is correct -> retry_step (element may load async)
- If fatal error (app crashed, permission denied) -> abort
- Be CONSERVATIVE: prefer retry over dismiss. Prefer dismiss over abort.

Respond with ONLY a JSON object with "type" and relevant fields.`;
}

function summarizeUiTree(uiTree: UiTreeNode[], maxNodes = 30): string {
  const lines: string[] = [];
  let count = 0;

  function walk(nodes: UiTreeNode[], depth: number) {
    for (const node of nodes) {
      if (count >= maxNodes) return;
      const indent = "  ".repeat(depth);
      const parts: string[] = [];
      if (node.resourceId) parts.push(`id=${node.resourceId}`);
      if (node.text) parts.push(`text="${node.text.slice(0, 50)}"`);
      if (node.contentDescription) parts.push(`cd="${node.contentDescription.slice(0, 50)}"`);
      if (node.className) parts.push(`class=${node.className.split(".").pop()}`);
      if (node.clickable) parts.push("clickable");
      lines.push(`${indent}- ${parts.join(" | ")}`);
      count++;
      if (node.children) walk(node.children, depth + 1);
    }
  }

  walk(uiTree, 0);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTE RECOVERY ACTION ON DEVICE
// ═══════════════════════════════════════════════════════════════════════════════

async function executeRecoveryAction(
  deviceId: string,
  action: RecoveryAction
): Promise<{ success: boolean; error?: string }> {
  if (!isDeviceOnline(deviceId)) {
    return { success: false, error: "Device offline" };
  }

  switch (action.type) {
    case "retry_step": {
      // Runner will retry — nothing to execute now
      return { success: true };
    }

    case "retry_with_adaptation": {
      // Runner will use the adapted step — nothing to execute now
      return { success: true };
    }

    case "dismiss_and_retry": {
      // Execute dismiss actions (e.g., tap OK/Close on popup)
      for (const dismissStep of action.dismissActions) {
        const coords = dismissStep.target?.coords;
        if (!coords) continue;

        const jobId = uuidv4();
        const sent = sendJobToDevice(deviceId, {
          jobId,
          type: "tap",
          params: { x: coords.x, y: coords.y },
          timeoutMs: 5_000,
        });
        if (sent) {
          await waitForResult(jobId, 5_000).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { success: true };
    }

    case "navigate_back_and_retry": {
      // Press back N times
      for (let i = 0; i < action.backSteps; i++) {
        const jobId = uuidv4();
        const sent = sendJobToDevice(deviceId, {
          jobId,
          type: "press_key",
          params: { key: "back" },
          timeoutMs: 3_000,
        });
        if (sent) {
          await waitForResult(jobId, 3_000).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      return { success: true };
    }

    case "abort": {
      return { success: false, error: action.reason };
    }

    default:
      return { success: false, error: `Unknown recovery action: ${(action as RecoveryAction).type}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG RECOVERY HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

async function logRecoveryHistory(entry: RecoveryHistoryEntry): Promise<void> {
  try {
    const db = getDb();
    await db.query(
      `INSERT INTO recovery_history
        (workflow_id, step_index, step_id, failure_reason, recovery_action,
         success, screenshot_available, ui_tree_hash, llm_model,
         llm_latency_ms, total_latency_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.workflowId,
        entry.stepIndex,
        entry.stepId,
        entry.failureReason,
        entry.recoveryAction,
        entry.success,
        entry.screenshotAvailable,
        entry.uiTreeHash,
        entry.llmModel,
        entry.llmLatencyMs,
        entry.totalLatencyMs,
        entry.createdAt,
      ]
    );
  } catch (err) {
    console.warn("[recovery] Failed to log recovery history:", (err as Error).message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: attemptRecovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attempt AI recovery for a failed workflow step.
 * Captures current state, calls LLM, executes recovery action.
 *
 * @returns true if recovery was successful and runner should continue/retry
 */
export async function attemptRecovery(
  ctx: RunnerContext,
  stepIndex: number,
  reason: string,
  model: string = DEFAULT_RECOVERY_MODEL
): Promise<boolean> {
  const startTime = Date.now();
  const { deviceId, workflow } = ctx;
  const failedStep = workflow.steps[stepIndex];

  // Check per-step limit
  const stepRecoveryCount = getStepRecoveryCount(workflow.id, stepIndex);
  if (stepRecoveryCount >= MAX_RECOVERY_PER_STEP) {
    console.warn(`[recovery] Max recovery attempts (${MAX_RECOVERY_PER_STEP}) reached for step ${stepIndex}`);
    return false;
  }

  // Check per-workflow limit
  if (ctx.recoveryCount >= MAX_RECOVERY_PER_WORKFLOW) {
    console.warn(`[recovery] Max total recovery attempts (${MAX_RECOVERY_PER_WORKFLOW}) reached for workflow ${workflow.id}`);
    return false;
  }

  console.log(
    `[recovery] Step ${stepIndex} failed: "${reason}". ` +
    `Attempt ${stepRecoveryCount + 1}/${MAX_RECOVERY_PER_STEP} for step, ` +
    `${ctx.recoveryCount + 1}/${MAX_RECOVERY_PER_WORKFLOW} for workflow.`
  );

  // 1. Capture current state
  const [screenshotBase64, uiTree] = await Promise.all([
    captureScreenshot(deviceId),
    captureUiTreeForRecovery(deviceId),
  ]);

  const currentFingerprint = uiTree.length > 0 ? computePageSignature(uiTree) : undefined;
  const uiTreeSummary = summarizeUiTree(uiTree);

  // 2. Build recovery context
  const recoveryCtx: RecoveryContext = {
    deviceId,
    workflowId: workflow.id,
    failedStep,
    stepIndex,
    failureReason: reason,
    screenshotBase64,
    uiTree,
    currentFingerprint,
  };

  // 3. Call LLM for recovery decision
  let recoveryAction: RecoveryAction;
  let llmLatencyMs: number;

  try {
    const llmStart = Date.now();
    const prompt = buildRecoveryPrompt(recoveryCtx, uiTreeSummary);

    recoveryAction = await llmJson<RecoveryAction>(
      prompt,
      model,
      {
        max_tokens: 2048,
        system: "You are an Android workflow recovery agent. Respond ONLY with valid JSON recovery action.",
      }
    );

    llmLatencyMs = Date.now() - llmStart;
    console.log(`[recovery] LLM decided: ${recoveryAction.type} (${llmLatencyMs}ms)`);
  } catch (err) {
    console.error(`[recovery] LLM call failed: ${(err as Error).message}`);
    // Default: simple retry
    recoveryAction = { type: "retry_step" };
    llmLatencyMs = Date.now() - startTime;
  }

  // Validate LLM response
  const validTypes = new Set(["retry_step", "retry_with_adaptation", "dismiss_and_retry", "navigate_back_and_retry", "abort"]);
  if (!recoveryAction.type || !validTypes.has(recoveryAction.type)) {
    console.warn(`[recovery] Invalid recovery action from LLM: ${JSON.stringify(recoveryAction).slice(0, 200)}`);
    recoveryAction = { type: "retry_step" };
  }

  // 4. Execute recovery action
  const execResult = await executeRecoveryAction(deviceId, recoveryAction);

  // If retry_with_adaptation, validate & replace the step in the workflow
  if (recoveryAction.type === "retry_with_adaptation" && recoveryAction.adaptedStep) {
    const adaptedStep = recoveryAction.adaptedStep as unknown as Record<string, unknown>;
    const validation = validateStepSchema(adaptedStep);
    if (validation.valid) {
      workflow.steps[stepIndex] = recoveryAction.adaptedStep;
      console.log(`[recovery] Adapted step ${stepIndex}: ${recoveryAction.adaptedStep.description}`);
    } else {
      console.warn(
        `[recovery] Adapted step validation failed (${validation.errors.join(", ")}). ` +
        `Keeping original step for fallback.`
      );
    }
  }

  // 5. Track counts
  incrementStepRecoveryCount(workflow.id, stepIndex);

  // 6. Log recovery history
  const totalLatencyMs = Date.now() - startTime;
  const historyEntry: RecoveryHistoryEntry = {
    workflowId: workflow.id,
    stepIndex,
    stepId: failedStep.id,
    failureReason: reason,
    recoveryAction: recoveryAction.type,
    success: execResult.success,
    screenshotAvailable: !!screenshotBase64,
    uiTreeHash: currentFingerprint,
    llmModel: model,
    llmLatencyMs,
    totalLatencyMs,
    createdAt: new Date().toISOString(),
  };

  await logRecoveryHistory(historyEntry);

  console.log(
    `[recovery] Recovery ${execResult.success ? "succeeded" : "failed"}: ` +
    `${recoveryAction.type} (${totalLatencyMs}ms total)`
  );

  return recoveryAction.type !== "abort" && execResult.success;
}

/**
 * Get recovery history for a workflow.
 */
export async function getRecoveryHistory(
  workflowId: string
): Promise<RecoveryHistoryEntry[]> {
  try {
    const db = getDb();
    const result = await db.query(
      `SELECT * FROM recovery_history
       WHERE workflow_id = $1
       ORDER BY created_at ASC`,
      [workflowId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

/**
 * Get recovery stats across all workflows.
 */
export async function getRecoveryStats(days = 7): Promise<{
  total: number;
  successRate: number;
  avgLatencyMs: number;
  actionBreakdown: Record<string, number>;
}> {
  try {
    const db = getDb();
    const result = await db.query(
      `SELECT
         recovery_action,
         COUNT(*) as total,
         SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes,
         AVG(total_latency_ms) as avg_latency
       FROM recovery_history
       WHERE created_at > NOW() - $1::interval
       GROUP BY recovery_action`,
      [`${days} days`]
    );

    if (result.rows.length === 0) {
      return { total: 0, successRate: 0, avgLatencyMs: 0, actionBreakdown: {} };
    }

    const total = result.rows.reduce((sum, r) => sum + parseInt(r.total), 0);
    const successes = result.rows.reduce((sum, r) => sum + parseInt(r.successes), 0);
    const avgLatency = result.rows.reduce(
      (sum, r) => sum + parseFloat(r.avg_latency) * parseInt(r.total), 0
    ) / total;

    const actionBreakdown: Record<string, number> = {};
    for (const row of result.rows) {
      actionBreakdown[row.recovery_action] = parseInt(row.total);
    }

    return {
      total,
      successRate: total > 0 ? (successes / total) * 100 : 0,
      avgLatencyMs: avgLatency,
      actionBreakdown,
    };
  } catch {
    return { total: 0, successRate: 0, avgLatencyMs: 0, actionBreakdown: {} };
  }
}
