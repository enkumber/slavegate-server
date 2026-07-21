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
import { sendDeviceExecutionJobToDevice, isDeviceOnline, waitForResult } from "../../transport/transport";
import { computePageSignature } from "../app-mapping/page-fingerprint";
import type { UiTreeNode } from "../app-mapping/schema";
import { llmJson } from "../../utils/llm";
import type { CompiledStep } from "./types";
import { normalizeUiTreeOutput } from "./ui-tree-output";
import { canonicalModelOverride } from "./model-routing";
import type { RunnerContext } from "./runner.service";
import { validateStepSchema } from "./workflow-validator";
import { visionService } from "../vision/vision.service";
import { uiGraphRepository } from "../ui-graph/repository";
import type { CandidateObservation } from "../ui-graph/learning-loop";
import { observeRecovery } from "../ui-graph/telemetry";
import { validateRecoveryProposal } from "../ui-graph/recovery-orchestrator";
import type { RecoveryProposal, UiSafetyClass } from "../ui-graph/types";

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

const MAX_RECOVERY_PER_STEP = 1;
const MAX_RECOVERY_PER_WORKFLOW = 10;

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

async function captureScreenshot(deviceId: string, workflowRootExternalId: string): Promise<string | undefined> {
  try {
    const jobId = uuidv4();
    const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
      jobId,
      type: "screenshot",
      params: {},
      timeoutMs: 10_000,
    }, {
      boundary: "recovery_child",
      rootExternalId: workflowRootExternalId,
      actor: "workflow_recovery",
      metadata: { observeSource: "recovery.captureScreenshot" },
    });
    if (!dispatch.sent) return undefined;

    const result = await waitForResult(jobId, 10_000);
    return result?.output?.image_base64 as string | undefined;
  } catch {
    return undefined;
  }
}

async function captureUiTreeForRecovery(deviceId: string, workflowRootExternalId: string): Promise<UiTreeNode[]> {
  try {
    const jobId = uuidv4();
    const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
      jobId,
      type: "ui_tree_dump",
      params: {},
      timeoutMs: 10_000,
    }, {
      boundary: "recovery_child",
      rootExternalId: workflowRootExternalId,
      actor: "workflow_recovery",
      metadata: { observeSource: "recovery.captureUiTree" },
    });
    if (!dispatch.sent) return [];

    const result = await waitForResult(jobId, 10_000);
    return normalizeUiTreeOutput(result?.output);
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
- Failed step JSON: ${JSON.stringify(ctx.failedStep)}

CURRENT STATE:
- Current fingerprint: ${ctx.currentFingerprint || "unknown"}
- UI tree summary (top-level elements):
${uiTreeSummary || "Not available"}

AVAILABLE RECOVERY ACTIONS (respond with JSON):
1. { "type": "retry_step" } — Just retry the same step
2. { "type": "retry_with_adaptation", "adaptedStep": { ...CompiledStep } } — Retry with modified step. Copy every field from the failed step and change only what is required.
3. { "type": "dismiss_and_retry", "dismissActions": [ { ...CompiledStep }, ... ] } — Dismiss popup then retry
4. { "type": "navigate_back_and_retry", "backSteps": 1 } — Press back N times then retry
5. { "type": "abort", "reason": "..." } — Cannot recover, abort workflow

DECISION GUIDELINES:
- If a popup/dialog appeared -> dismiss_and_retry (tap OK/Close button)
- If element is scrolled out -> retry_with_adaptation (add swipe up before tap)
- If wrong page -> navigate_back_and_retry
- If the failure says an Accessibility selector was not found, the stored selector is stale. Do NOT use retry_step with the same selector. If the current UI tree contains the intended element, use retry_with_adaptation, keep action="tap", and copy its robust descriptors from the tree: resourceId, contentDescription, and text when present. Runtime tries them separately in that priority order, so a transient resourceId change can fall back without turning the fields into one broad query.
- Use retry_step for a missing element only when the failure is plausibly transient (loading/animation) and the stored selector is still present in the current UI tree.
- adaptedStep must remain a CompiledStep (screen_wake/unlock/tap/type/swipe/press_key/wait/open_app/intent_send/screenshot), not a device job type such as a11y_find_tap.
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
      const parts: string[] = [];
      if (node.resourceId) parts.push(`id=${node.resourceId}`);
      if (node.text) parts.push(`text="${node.text.slice(0, 50)}"`);
      if (node.contentDescription) parts.push(`cd="${node.contentDescription.slice(0, 50)}"`);
      const editable = (node as UiTreeNode & { editable?: boolean }).editable === true;
      const semanticallyUseful = parts.length > 0 || node.clickable || editable;
      if (semanticallyUseful) {
        const indent = "  ".repeat(Math.min(depth, 6));
        if (node.className) parts.push(`class=${node.className.split(".").pop()}`);
        if (node.clickable) parts.push("clickable");
        if (editable) parts.push("editable");
        lines.push(`${indent}- ${parts.join(" | ")}`);
        count++;
      }
      if (node.children) walk(node.children, depth + 1);
    }
  }

  walk(uiTree, 0);
  return lines.join("\n");
}

function hasActionableUiTreeSignals(uiTree: UiTreeNode[]): boolean {
  let signals = 0;
  const walk = (nodes: UiTreeNode[]) => {
    for (const node of nodes) {
      if (node.resourceId?.trim() || node.contentDescription?.trim() || node.text?.trim()) signals++;
      if (node.children && signals < 3) walk(node.children);
      if (signals >= 3) return;
    }
  };
  walk(uiTree);
  return signals >= 2;
}

function parseRecoveryAction(raw: string): RecoveryAction | null {
  const candidates = [raw.trim(), raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as RecoveryAction;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed;
    } catch { /* try next representation */ }
  }
  return null;
}

function recoverySafety(step: CompiledStep): UiSafetyClass {
  if (["screen_wake", "unlock", "screenshot", "wait"].includes(step.action)) return "read_only";
  if (["open_app", "intent_send", "press_key", "swipe", "tap"].includes(step.action)) return "navigation";
  if (step.action === "type") return "mutating";
  return "sensitive";
}

function asRecoveryProposal(action: RecoveryAction, failedStep: CompiledStep): RecoveryProposal {
  const encodedStep = (step: CompiledStep): Record<string, unknown> => ({
    type: step.action,
    safetyClass: recoverySafety(step),
    target: step.target,
    params: step.params,
  });
  if (action.type === "abort") {
    return { type: "abort", actions: [], confidence: 1, reason: action.reason, learningEligible: false };
  }
  if (action.type === "retry_step") {
    return { type: "retry", actions: [encodedStep(failedStep)], confidence: 0.6, reason: "retry failed step", learningEligible: false };
  }
  if (action.type === "retry_with_adaptation") {
    return { type: "adapt", actions: [encodedStep(action.adaptedStep)], confidence: 0.7, reason: "adapt failed step", learningEligible: true };
  }
  if (action.type === "dismiss_and_retry") {
    return { type: "dismiss_overlay", actions: action.dismissActions.map(encodedStep), confidence: 0.7, reason: "dismiss overlay", learningEligible: true };
  }
  return {
    type: "navigate",
    actions: Array.from({ length: Math.max(0, action.backSteps) }, () => ({ type: "press_key", safetyClass: "navigation", params: { key: "BACK" } })),
    confidence: 0.7,
    reason: "navigate back",
    learningEligible: true,
  };
}

function learningPayload(action: RecoveryAction, failedStep: CompiledStep, reason: string): Record<string, unknown> {
  const base = {
    failureClass: reason.split(":", 1)[0],
    expectedPage: failedStep.expectedPage,
    failedAction: failedStep.action,
    recoveryType: action.type,
  };
  if (action.type === "navigate_back_and_retry") return { ...base, backSteps: action.backSteps };
  if (action.type === "dismiss_and_retry") {
    return {
      ...base,
      dismissActions: action.dismissActions.map((step) => ({
        action: step.action,
        target: step.target ? {
          elementId: step.target.elementId,
          resourceId: step.target.resourceId,
          contentDescription: step.target.contentDescription,
          text: step.target.text,
          coords: step.target.coords,
        } : undefined,
      })),
    };
  }
  if (action.type === "retry_with_adaptation") {
    return {
      ...base,
      adaptedAction: action.adaptedStep.action,
      target: action.adaptedStep.target ? {
        elementId: action.adaptedStep.target.elementId,
        resourceId: action.adaptedStep.target.resourceId,
        contentDescription: action.adaptedStep.target.contentDescription,
        text: action.adaptedStep.target.text,
        coords: action.adaptedStep.target.coords,
      } : undefined,
    };
  }
  return base;
}

function learnedElementKey(step: CompiledStep, target: NonNullable<CompiledStep["target"]>): string {
  const explicit = step.target?.elementId?.trim();
  if (explicit) return explicit;
  const descriptor = target.resourceId || target.contentDescription || target.text || "recovered_target";
  return descriptor
    .split("/").pop()!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "recovered_target";
}

export async function recoveryLearningCandidate(input: {
  workflow: RunnerContext["workflow"];
  failedStep: CompiledStep;
  recoveryAction: RecoveryAction;
  reason: string;
  graphContext: CandidateObservation["context"];
  currentFingerprint?: string;
  screenshotAvailable: boolean;
  usedVision: boolean;
}): Promise<CandidateObservation> {
  const { workflow, failedStep, recoveryAction } = input;
  if (recoveryAction.type === "retry_with_adaptation" && recoveryAction.adaptedStep.target) {
    const target = recoveryAction.adaptedStep.target;
    const semantic = target.resourceId?.trim()
      ? { strategy: "resource_id" as const, value: target.resourceId.trim(), priority: 10 }
      : target.contentDescription?.trim()
        ? { strategy: "content_description" as const, value: target.contentDescription.trim(), priority: 20 }
        : target.text?.trim()
          ? { strategy: "text" as const, value: target.text.trim(), priority: 40 }
          : null;
    const sourceState = (await uiGraphRepository.loadStates(workflow.appId))
      .find((state) => state.key === failedStep.expectedPage);
    if (semantic && sourceState) {
      return {
        appId: workflow.appId,
        type: "selector",
        sourceStateId: sourceState.id,
        payload: {
          elementKey: learnedElementKey(failedStep, target),
          strategy: semantic.strategy,
          selector: { value: semantic.value },
          priority: semantic.priority,
          dynamic: false,
        },
        evidence: {
          currentFingerprint: input.currentFingerprint,
          screenshotAvailable: input.screenshotAvailable,
          usedVision: input.usedVision,
          recoveryType: recoveryAction.type,
          expectedPage: failedStep.expectedPage,
        },
        context: { ...input.graphContext, currentStateId: sourceState.id },
        discoveryMethod: input.usedVision ? "vlm" : "llm_recovery",
        confidence: input.usedVision ? 0.7 : 0.75,
        safetyClass: recoverySafety(failedStep),
      };
    }
  }

  return {
    appId: workflow.appId,
    type: "recovery_rule",
    payload: learningPayload(recoveryAction, failedStep, input.reason),
    evidence: {
      currentFingerprint: input.currentFingerprint,
      screenshotAvailable: input.screenshotAvailable,
      usedVision: input.usedVision,
    },
    context: input.graphContext,
    discoveryMethod: input.usedVision ? "vlm" : "llm_recovery",
    confidence: input.usedVision ? 0.7 : 0.75,
    safetyClass: recoverySafety(failedStep),
  };
}

function normalizeAdaptedTarget(target: CompiledStep["target"]): CompiledStep["target"] {
  if (!target) return target;

  // Keep semantic fallbacks, but never send them as one ambiguous Accessibility
  // query. The runner executes these descriptors separately in priority order.
  // This matters for apps whose view ID changes after focus/animation while the
  // label remains stable. Coordinates never override semantic descriptors.
  const semantic = {
    ...(target.resourceId?.trim() ? { resourceId: target.resourceId.trim() } : {}),
    ...(target.contentDescription?.trim() ? { contentDescription: target.contentDescription.trim() } : {}),
    ...(target.text?.trim() ? { text: target.text.trim() } : {}),
  };
  if (Object.keys(semantic).length > 0) return semantic;
  if (target.elementId?.trim()) return { elementId: target.elementId.trim() };
  if (target.coords) return { coords: target.coords };
  return {};
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTE RECOVERY ACTION ON DEVICE
// ═══════════════════════════════════════════════════════════════════════════════

async function executeRecoveryAction(
  deviceId: string,
  action: RecoveryAction,
  workflowRootExternalId: string,
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
        const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
          jobId,
          type: "tap",
          params: { x: coords.x, y: coords.y },
          timeoutMs: 5_000,
        }, {
          boundary: "recovery_child",
          rootExternalId: workflowRootExternalId,
          actor: "workflow_recovery",
          metadata: { observeSource: "recovery.dismissAction" },
        });
        if (dispatch.sent) {
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
        const dispatch = await sendDeviceExecutionJobToDevice(deviceId, {
          jobId,
          type: "press_key",
          params: { key: "back" },
          timeoutMs: 3_000,
        }, {
          boundary: "recovery_child",
          rootExternalId: workflowRootExternalId,
          actor: "workflow_recovery",
          metadata: { observeSource: "recovery.navigateBack" },
        });
        if (dispatch.sent) {
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
  model?: string
): Promise<boolean> {
  const startTime = Date.now();
  const { deviceId, workflow } = ctx;
  const failedStep = workflow.steps[stepIndex];
  ctx.pendingRecoveryLearning = undefined;

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

  const graphContext = { appId: workflow.appId, deviceId, workflowId: workflow.id, stepId: failedStep.id };
  const graphFlags = await uiGraphRepository.resolveFlags(graphContext);

  // 1. Capture the cheap semantic state first. Screenshot/VLM stays lazy.
  const uiTree = await captureUiTreeForRecovery(deviceId, ctx.workflowRootExternalId);
  let screenshotBase64: string | undefined;

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
  let usedVision = false;
  const modelOverride = canonicalModelOverride(model);

  try {
    const llmStart = Date.now();
    const prompt = buildRecoveryPrompt(recoveryCtx, uiTreeSummary);

    if (graphFlags.mode !== "disabled" && graphFlags.aiRecovery && !hasActionableUiTreeSignals(uiTree)) {
      screenshotBase64 = await captureScreenshot(deviceId, ctx.workflowRootExternalId);
      if (!screenshotBase64) throw new Error("VLM recovery required but screenshot unavailable");
      const raw = await visionService.analyzeCustomPrompt(screenshotBase64, `${prompt}\nThe accessibility tree was insufficient. Analyze the screenshot and return only the recovery JSON.`);
      const parsed = parseRecoveryAction(raw);
      if (!parsed) throw new Error("VLM returned invalid recovery JSON");
      recoveryAction = parsed;
      usedVision = true;
    } else {
      recoveryAction = await llmJson<RecoveryAction>(
        prompt,
        modelOverride,
        {
          max_tokens: 2048,
          system: "You are an Android workflow recovery agent. Respond ONLY with valid JSON recovery action.",
        }
      );
    }

    llmLatencyMs = Date.now() - llmStart;
    console.log(`[recovery] ${usedVision ? "VLM" : "UI-tree LLM"} decided: ${recoveryAction.type} (${llmLatencyMs}ms)`);
  } catch (err) {
    console.error(`[recovery] AI recovery decision failed: ${(err as Error).message}`);
    if (graphFlags.mode !== "disabled" && graphFlags.aiRecovery && !usedVision) {
      try {
        screenshotBase64 = screenshotBase64 ?? await captureScreenshot(deviceId, ctx.workflowRootExternalId);
        if (!screenshotBase64) throw new Error("screenshot unavailable");
        const prompt = buildRecoveryPrompt(recoveryCtx, uiTreeSummary);
        const raw = await visionService.analyzeCustomPrompt(screenshotBase64, `${prompt}\nThe UI-tree recovery failed. Analyze the screenshot and return only the recovery JSON.`);
        const parsed = parseRecoveryAction(raw);
        if (!parsed) throw new Error("invalid VLM recovery JSON");
        recoveryAction = parsed;
        usedVision = true;
      } catch (visionError) {
        console.error(`[recovery] VLM fallback failed: ${(visionError as Error).message}`);
        recoveryAction = { type: "retry_step" };
      }
    } else {
      // Fail-safe deterministic retry does not escalate privileges.
      recoveryAction = { type: "retry_step" };
    }
    llmLatencyMs = Date.now() - startTime;
  }

  // Validate LLM response
  const validTypes = new Set(["retry_step", "retry_with_adaptation", "dismiss_and_retry", "navigate_back_and_retry", "abort"]);
  if (!recoveryAction.type || !validTypes.has(recoveryAction.type)) {
    console.warn(`[recovery] Invalid recovery action from LLM: ${JSON.stringify(recoveryAction).slice(0, 200)}`);
    recoveryAction = { type: "retry_step" };
  }

  const safetyErrors = validateRecoveryProposal(asRecoveryProposal(recoveryAction, failedStep), recoverySafety(failedStep), {
    maxActions: 6,
    maxAttempts: MAX_RECOVERY_PER_STEP,
    maxDurationMs: 120_000,
  });
  if (safetyErrors.length > 0) {
    console.warn(`[recovery] Recovery proposal rejected by canonical safety policy: ${safetyErrors.join(",")}`);
    recoveryAction = { type: "abort", reason: `Recovery proposal rejected: ${safetyErrors.join(",")}` };
  }

  // 4. Execute recovery action
  const execResult = await executeRecoveryAction(deviceId, recoveryAction, ctx.workflowRootExternalId);
  if (graphFlags.mode !== "disabled") {
    observeRecovery(workflow.appId, usedVision ? "vlm" : "ui_tree_llm", execResult.success ? "completed" : recoveryAction.type === "abort" ? "aborted" : "failed");
  }

  // If retry_with_adaptation, validate & replace the step in the workflow
  if (recoveryAction.type === "retry_with_adaptation" && recoveryAction.adaptedStep) {
    const adaptedStep: CompiledStep = {
      ...failedStep,
      ...recoveryAction.adaptedStep,
      target: recoveryAction.adaptedStep.target
        ? normalizeAdaptedTarget(recoveryAction.adaptedStep.target)
        : failedStep.target,
      params: recoveryAction.adaptedStep.params ?? failedStep.params,
    };
    const validation = validateStepSchema(adaptedStep as unknown as Record<string, unknown>);
    if (validation.valid) {
      workflow.steps[stepIndex] = adaptedStep;
      recoveryAction.adaptedStep = adaptedStep;
      console.log(`[recovery] Adapted step ${stepIndex}: ${adaptedStep.description}`);
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
    llmModel: usedVision ? "vision_vlm" : modelOverride || "decision_llm",
    llmLatencyMs,
    totalLatencyMs,
    createdAt: new Date().toISOString(),
  };

  await logRecoveryHistory(historyEntry);

  if (execResult.success && recoveryAction.type !== "retry_step" && graphFlags.mode !== "disabled" && graphFlags.candidateLearning) {
    ctx.pendingRecoveryLearning = await recoveryLearningCandidate({
      workflow,
      failedStep,
      recoveryAction,
      reason,
      graphContext,
      currentFingerprint,
      screenshotAvailable: Boolean(screenshotBase64),
      usedVision,
    });
  }

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
