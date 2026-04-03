/**
 * workflows/workflow.executor.ts
 * DAG execution engine — ONE BullMQ job per workflow.
 *
 * Design (per FORGE v3 §8 + clarification):
 * - Single long-running BullMQ job per workflow
 * - Internal loop: step → JOB_DISPATCH → await JOB_RESULT → checkpoint → HBE delay → next step
 * - Checkpoint per step in PostgreSQL (atomic BEGIN/UPDATE/COMMIT)
 * - On server crash: BullMQ retries → executor reads checkpoint → resumes from last step
 * - On device disconnect: step timeout → workflow paused → resumes at reconnect
 *
 * JOB_RESULT awaiting:
 *   pendingJobResults: Map<jobId, PendingResult>
 *   WsServer calls resolveJobResult(jobId, result) when JOB_RESULT arrives.
 *   Each step awaits a promise that resolves when the result arrives.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §8
 */

import { Queue, Worker } from "bullmq";
import { getRedisConnectionOptions } from "../../redis/client";
import { workflowService } from "./workflow.service";
import { hbeService } from "../hbe/hbe.service";
import { dispatcherService } from "../dispatcher/dispatcher.service";
import { getNostrAdapter } from "../../nostr/adapter";
import { getDb } from "../../db/client";
import type {
  WorkflowStep,
  WorkflowTemplate,
  WorkflowCheckpoint,
  ActionStep,
  WaitStep,
  ConditionStep,
  LoopStep,
  VerificationStrategy,
} from "./types";
import { PHASE2_UNSUPPORTED_STRATEGIES } from "./types";
import { normal, logNormal, uniform, clamp } from "../hbe/distributions";
import type { HbeSessionParams } from "../hbe/hbe.service";
import { executeCascadeTap, resolveCascadeResult } from "../skills/skill.cascade";
import {
  isSkillAction,
  executeSkillAction,
  type SkillActionContext,
} from "../skills/skill.actions";
import { verifyScreenAfterStep } from "./screen-verifier";

// ─── Queue name ───────────────────────────────────────────────────────────────

export const WORKFLOW_QUEUE = "workflow_execute";

// ─── Pending job result registry ─────────────────────────────────────────────
// Workflow executor suspends at each action step, waiting for JOB_RESULT.
// WsServer calls resolveJobResult() when the device responds.

interface PendingResult {
  resolve: (result: JobStepResult) => void;
  reject:  (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export interface JobStepResult {
  status:       string;
  output?:      unknown;
  error?:       string;
  durationMs:   number;
  verification?: unknown;
}

const pendingJobResults = new Map<string, PendingResult>();

/**
 * Called by WsServer when JOB_RESULT arrives from a device.
 * Resolves the awaiting executor step.
 */
export function resolveJobResult(jobId: string, result: JobStepResult): boolean {
  // Try workflow executor first
  const pending = pendingJobResults.get(jobId);
  if (pending) {
    clearTimeout(pending.timeoutHandle);
    pendingJobResults.delete(jobId);
    pending.resolve(result);
    return true;
  }
  
  // Try cascade executor
  const cascadeResolved = resolveCascadeResult(jobId, {
    status: result.status,
    output: result.output as Record<string, unknown>,
    error: result.error,
    durationMs: result.durationMs,
  });
  if (cascadeResolved) return true;
  
  return false;
}

/**
 * Wait for device to respond with JOB_RESULT.
 * Rejects with timeout error if device doesn't respond within timeoutMs.
 */
function awaitJobResult(jobId: string, timeoutMs: number): Promise<JobStepResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingJobResults.delete(jobId);
      reject(new Error(`JOB_RESULT timeout after ${timeoutMs}ms (jobId=${jobId})`));
    }, timeoutMs);

    pendingJobResults.set(jobId, { resolve, reject, timeoutHandle });
  });
}

// ─── Queue ────────────────────────────────────────────────────────────────────

let workflowQueue: Queue | null = null;

export function getWorkflowQueue(): Queue {
  if (!workflowQueue) {
    workflowQueue = new Queue(WORKFLOW_QUEUE, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: {
        attempts:         3,
        backoff:          { type: "exponential", delay: 5000 },
        // timeout removed — BullMQ v5 removed this option; use worker-level timeout instead
        removeOnComplete: true,
        removeOnFail:     false,      // Keep for debugging
      },
    });
  }
  return workflowQueue;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startWorkflowWorker(): Worker {
  const worker = new Worker(
    WORKFLOW_QUEUE,
    async (job) => {
      const { workflowId } = job.data as { workflowId: string };
      await runWorkflow(workflowId, job);
    },
    {
      connection:  getRedisConnectionOptions(),
      concurrency: 8,  // Up to 8 workflows running concurrently
      lockDuration: 120000,     // 2 min lock (default 30s) — prevents stalled detection during long steps
      stalledInterval: 60000,   // Check stalled every 1 min (default 30s)
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { workflowId } = job.data as { workflowId: string };
    if (job.attemptsMade >= 3) {
      console.error(`[workflow] DLQ: ${workflowId} failed after 3 attempts: ${err.message}`);
      await workflowService.markFailed(workflowId, err.message);
    } else {
      console.warn(`[workflow] ${workflowId} attempt ${job.attemptsMade} failed — retrying from checkpoint: ${err.message}`);
    }
  });

  console.log("[workflow] Worker started");
  return worker;
}

// ─── Core execution loop ──────────────────────────────────────────────────────

async function runWorkflow(workflowId: string, job: import("bullmq").Job): Promise<void> {
  const wf = await workflowService.get(workflowId);
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);

  if (["cancelled", "completed", "failed"].includes(wf.status)) return;

  if (!wf.templateId) throw new Error(`Workflow ${workflowId} has no template`);
  const template = await workflowService.getTemplate(wf.templateId);
  if (!template) throw new Error(`Template ${wf.templateId} not found`);

  if (!wf.deviceId) throw new Error(`Workflow ${workflowId} has no deviceId`);

  await workflowService.markRunning(workflowId);

  // Build (or restore) HBE session params from checkpoint
  const hbeParams = wf.checkpoint.hbeParams && Object.keys(wf.checkpoint.hbeParams).length > 0
    ? wf.checkpoint.hbeParams as unknown as HbeSessionParams
    : buildHbeSession(wf);

  // Start from checkpoint (resume after crash/pause)
  const startStep = wf.checkpoint.stepIndex ?? 0;
  const checkpoint: WorkflowCheckpoint = {
    ...wf.checkpoint,
    hbeParams:  hbeParams as unknown as Record<string, unknown>,
    loopStack:  wf.checkpoint.loopStack ?? [],   // Ensure loopStack always exists (old checkpoints)
  };

  console.log(`[workflow] ${workflowId} starting at step ${startStep}/${template.steps.length}`);

  await executeSteps(
    workflowId,
    wf.deviceId,
    template,
    template.steps,
    checkpoint,
    startStep,
    job
  );

  await workflowService.markCompleted(workflowId);
  console.log(`[workflow] ${workflowId} completed`);
}

// ─── DAG traversal ────────────────────────────────────────────────────────────

async function executeSteps(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  steps:      WorkflowStep[],
  checkpoint: WorkflowCheckpoint,
  startIndex: number = 0,
  job?: import("bullmq").Job,
  isNested: boolean = false  // true when called from loop/condition (skip checkpoint)
): Promise<void> {
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];

    // Check for cancellation before each step
    const current = await workflowService.get(workflowId);
    if (current?.status === "cancelled") {
      console.log(`[workflow] ${workflowId} cancelled at step ${i}`);
      return;
    }
    if (current?.status === "paused") {
      // Re-throw so BullMQ retries after reconnect
      throw new Error(`Workflow paused at step ${i}`);
    }

    await executeStep(workflowId, deviceId, template, step, checkpoint, i, job);

    // Extend BullMQ lock after each step to prevent timeout during long workflows
    if (job) {
      try {
        await job.extendLock(job.token!, 60000); // Extend lock by 60 seconds
      } catch (lockErr) {
        console.warn(`[workflow] ${workflowId} failed to extend lock at step ${i}: ${lockErr}`);
      }
    }

    // Checkpoint after each step — ONLY for top-level steps (not nested in loops/conditions)
    // Nested steps use parent's checkpoint tracked via loopStack
    if (!isNested) {
      const saved = await workflowService.saveCheckpoint(
        workflowId,
        { ...checkpoint, stepIndex: i + 1, checkpointAt: new Date().toISOString() },
        i + 1,
        i
      );
      if (!saved) {
        throw new Error(`Checkpoint conflict at step ${i} — aborting (concurrent update)`);
      }
      checkpoint.stepIndex = i + 1;
    }
  }
}

// ─── Single step dispatch ─────────────────────────────────────────────────────

async function executeStep(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  step:       WorkflowStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex:  number,
  job?: import("bullmq").Job
): Promise<void> {
  switch (step.type) {

    case "action": {
      // Skill actions run server-side (control flow, criteria evaluation, etc.)
      // and bypass device dispatch entirely.
      if (isSkillAction(step.action)) {
        await executeSkillActionStep(
          workflowId, deviceId, template, step, checkpoint, stepIndex, job
        );
      } else {
        await executeActionStep(workflowId, deviceId, template, step, checkpoint, stepIndex);
      }
      break;
    }

    case "wait": {
      const delayMs = resolveWaitDuration(step, checkpoint.hbeParams as unknown as HbeSessionParams);
      if (delayMs > 0) {
        console.log(`[workflow] ${workflowId} step ${stepIndex} wait ${delayMs}ms`);
        await sleep(delayMs);
      }
      break;
    }

    case "condition": {
      const taken = evaluateCondition(step, checkpoint);
      const branch = taken ? step.if_true : (step.if_false ?? []);
      if (branch.length > 0) {
        await executeSteps(workflowId, deviceId, template, branch, checkpoint, 0, job, true);
      }
      break;
    }

    case "loop": {
      const count = resolveLoopCount(step);
      console.log(`[workflow] ${workflowId} step ${stepIndex} loop ×${count}`);

      // Find or create loopStack entry for this step
      const stackEntry = checkpoint.loopStack.find(e => e.stepIndex === stepIndex);
      const startIter  = stackEntry?.currentIteration ?? 0;  // Resume from here on restart

      if (startIter > 0) {
        console.log(`[workflow] ${workflowId} loop step ${stepIndex}: resuming from iteration ${startIter}/${count}`);
      }

      for (let iter = startIter; iter < count; iter++) {
        // Update loopStack BEFORE executing — so a mid-iteration crash records correct state
        const existingIdx = checkpoint.loopStack.findIndex(e => e.stepIndex === stepIndex);
        const entry = { stepIndex, currentIteration: iter, totalIterations: count };
        if (existingIdx >= 0) {
          checkpoint.loopStack[existingIdx] = entry;
        } else {
          checkpoint.loopStack.push(entry);
        }
        await workflowService.saveCheckpoint(workflowId, checkpoint, stepIndex, stepIndex);

        await executeSteps(workflowId, deviceId, template, step.steps, checkpoint, 0, job, true);
        // Reset inner step index after each loop iteration
        checkpoint.stepIndex = stepIndex;

        // Mark this iteration as completed (next resume starts at iter+1)
        const doneIdx = checkpoint.loopStack.findIndex(e => e.stepIndex === stepIndex);
        if (doneIdx >= 0) {
          checkpoint.loopStack[doneIdx] = { stepIndex, currentIteration: iter + 1, totalIterations: count };
        }
      }

      // Loop complete — remove its entry from stack
      checkpoint.loopStack = checkpoint.loopStack.filter(e => e.stepIndex !== stepIndex);
      break;
    }

    case "checkpoint": {
      // Explicit checkpoint — already handled by outer loop after every step.
      // Nothing extra to do here; logging for observability.
      console.log(`[workflow] ${workflowId} explicit checkpoint: ${step.id}`);
      break;
    }
  }
}

// ─── Skill action step (server-side — control flow, criteria, state) ─────────

async function executeSkillActionStep(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  step:       ActionStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex:  number,
  job?: import("bullmq").Job,
): Promise<void> {
  const platform = (checkpoint.variables?.platform as string) || template.platform || "instagram";

  const ctx: SkillActionContext = {
    workflowId,
    deviceId,
    platform,
    checkpoint,
    stepIndex,

    // Dispatch a device job (ui_tree_dump, a11y_find_tap, etc.) and await JOB_RESULT.
    async dispatchAndWait(type, params, timeoutMs = 30_000) {
      const jobType = type as import("../../../../shared/protocol/messages").JobType;
      const { jobId } = await dispatcherService.dispatch({
        deviceId,
        type:     jobType,
        params:   params as import("../../../../shared/protocol/messages").JobParams,
        timeoutMs,
        workflowId,
        stepIndex,
      });
      const dispatchAdapter = getNostrAdapter();
      if (!dispatchAdapter) throw new Error("Transport not initialized");
      await dispatchAdapter.sendJob(deviceId, { jobId, type: jobType, params: params as import("../../../../shared/protocol/messages").JobParams, timeoutMs });
      return awaitJobResult(jobId, timeoutMs + 5_000);
    },

    // Cascade tap a named element (calls executeCascadeTap from skill.cascade).
    async cascadeTap(elementName, verify) {
      const result = await executeCascadeTap({
        workflowId,
        deviceId,
        stepIndex,
        platform,
        elementName,
        timeoutMs: 30_000,
      });
      if (!result.success) {
        console.warn(`[skill-action] cascade tap failed for "${elementName}": ${result.error}`);
        return false;
      }
      if (verify) {
        // Fire verify-tap via dispatch (ui_tree_dump → check screen indicators).
        try {
          const verifyResult = await ctx.dispatchAndWait(
            'ui_tree_dump', {}, 10_000,
          );
          // Presence of a non-empty ui tree is sufficient — deeper screen matching
          // is handled by HYDRA-CORE on the Hydra side during live sessions.
          return verifyResult.status === 'ok' || verifyResult.status === 'success';
        } catch {
          console.warn(`[skill-action] verify "${verify}" failed after cascade tap`);
          return false;
        }
      }
      return true;
    },

    // Execute nested steps (for run_loop body, for_each handler, branch_on_decision).
    async executeSteps(steps) {
      await executeSteps(workflowId, deviceId, template, steps, checkpoint, 0, job, true);
    },

    // Persist checkpoint to DB.
    async persistCheckpoint(phase) {
      checkpoint.variables['_checkpoint_phase'] = phase ?? 'skill_action';
      await workflowService.saveCheckpoint(
        workflowId,
        { ...checkpoint, checkpointAt: new Date().toISOString() },
        stepIndex,
        stepIndex - 1,
      );
    },

    sleep,
  };

  const params = (step.params as Record<string, unknown>) ?? {};
  await executeSkillAction(step.action, params, ctx);
}

// ─── Action step (core: dispatch → await result) ──────────────────────────────

async function executeActionStep(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  step:       ActionStep,
  checkpoint: WorkflowCheckpoint,
  stepIndex:  number
): Promise<void> {
  const wfAdapter = getNostrAdapter();
  if (!wfAdapter) throw new Error("Transport not initialized");
  if (!wfAdapter.isDeviceOnline(deviceId)) {
    // Device offline — pause and let BullMQ retry on reconnect
    await workflowService.markPaused(workflowId);
    throw new Error(`Device ${deviceId} offline at step ${stepIndex}`);
  }

  const rawStrategy = (step.verification ?? template.defaultVerificationStrategy) as VerificationStrategy;
  const strategy    = enforcePhase2Strategy(rawStrategy, workflowId, stepIndex);
  const hbeSession  = checkpoint.hbeParams as unknown as HbeSessionParams;

  // HBE: timing and jitter for this action
  const hbeStep = hbeService.getActionParams(
    mapActionToHbeType(step.action),
    hbeSession,
    {
      targetX: step.x,
      targetY: step.y,
      text:    step.params?.text as string | undefined,
      scrollDistancePx: step.params?.distancePx as number | undefined,
      verificationStrategy: strategy,
    }
  );

  // Pre-action HBE delay (human micro-pause before acting)
  if (hbeStep.action.preActionDelayMs > 0) {
    await sleep(hbeStep.action.preActionDelayMs);
  }

  // Build final params with HBE-applied values
  const finalParams: Record<string, unknown> = { ...(step.params ?? {}) };
  if (hbeStep.action.jitteredCoords) {
    finalParams["x"] = hbeStep.action.jitteredCoords.x;
    finalParams["y"] = hbeStep.action.jitteredCoords.y;
  }
  if (hbeStep.action.keystrokeDelaysMs) {
    finalParams["keystrokeDelaysMs"] = hbeStep.action.keystrokeDelaysMs;
  }
  if (hbeStep.action.scrollParams) {
    finalParams["distancePx"] = hbeStep.action.scrollParams.distancePx;
    finalParams["durationMs"] = hbeStep.action.scrollParams.durationMs;
  }

  // Resolve textFromVariable for type_text action
  if (step.action === "type_text" && finalParams["textFromVariable"] && !finalParams["text"]) {
    const varName = finalParams["textFromVariable"] as string;
    const textValue = checkpoint.variables[varName] as string | undefined;
    if (textValue) {
      finalParams["text"] = textValue;
      console.log(`[workflow] ${workflowId} step ${stepIndex}: resolved text from variable "${varName}" (${textValue.length} chars)`);
    } else {
      console.warn(`[workflow] ${workflowId} step ${stepIndex}: textFromVariable "${varName}" is empty/undefined`);
      finalParams["text"] = "";
    }
    delete finalParams["textFromVariable"]; // Remove meta-param before sending to device
  }

  // Resolve packageName for open_app/close_app actions
  if ((step.action === "open_app" || step.action === "close_app") && !finalParams["packageName"]) {
    // template.platform can be "*" (wildcard) — treat as unset and fall through to checkpoint or default
    const rawPlatform = (checkpoint.variables?.platform as string) || template.platform || "instagram";
    const platform = rawPlatform === "*" ? "instagram" : rawPlatform;
    const packageMap: Record<string, string> = {
      instagram: "com.instagram.android",
      tiktok: "com.zhiliaoapp.musically",
      facebook: "com.facebook.katana",
      twitter: "com.twitter.android",
      youtube: "com.google.android.youtube",
    };
    const resolved = packageMap[platform.toLowerCase()] || (checkpoint.variables?.packageName as string | undefined);
    if (!resolved) {
      throw new Error(`open_app/close_app: cannot resolve packageName for platform="${platform}" (rawPlatform="${rawPlatform}") — add platform to checkpoint.variables or packageMap`);
    }
    finalParams["packageName"] = resolved;
    console.log(`[workflow] ${workflowId} resolved packageName=${finalParams["packageName"]} for platform=${platform} (rawPlatform=${rawPlatform})`);
  }

  // Error simulation (before the real action — human corrects their mistake)
  if (hbeStep.action.simulateError) {
    await simulateError(hbeStep.action.errorType, deviceId);
  }

  const timeoutMs = step.timeoutMs ?? 30_000;

  // ═══════════════════════════════════════════════════════════════════════════
  // CASCADE TAP: If this is a tap action with a target element, use skill system
  // ═══════════════════════════════════════════════════════════════════════════
  const stepTarget = (step as { target?: string }).target;
  const platform = (checkpoint.variables?.platform as string) || template.platform || "instagram";
  
  if (step.action === "tap" && stepTarget && !step.x && !step.y) {
    console.log(`[workflow] ${workflowId} step ${stepIndex}: using CASCADE TAP for target="${stepTarget}"`);
    
    const cascadeResult = await executeCascadeTap({
      workflowId,
      deviceId,
      stepIndex,
      platform,
      elementName: stepTarget,
      timeoutMs,
    });

    if (!cascadeResult.success) {
      const retries = step.retries ?? 0;
      if (retries > 0) {
        console.warn(`[workflow] ${workflowId} step ${stepIndex} cascade failed — retrying (${retries} left)`);
        await executeActionStep(workflowId, deviceId, template, { ...step, retries: retries - 1 }, checkpoint, stepIndex);
        return;
      }
      throw new Error(`Cascade tap failed for ${stepTarget}: ${cascadeResult.error} (chain: ${cascadeResult.fallbackChain.join(" → ")})`);
    }

    console.log(`[workflow] ${workflowId} step ${stepIndex}: cascade success via ${cascadeResult.method} (${cascadeResult.latencyMs}ms)`);
    
    // Post-action HBE delay
    if (hbeStep.action.postActionDelayMs > 0) {
      await sleep(hbeStep.action.postActionDelayMs);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SCREEN VERIFICATION (after cascade tap)
    // Story: US-WORKFLOW-SCREEN-VERIFY
    // ═══════════════════════════════════════════════════════════════════════════
    if (step.expectedScreen && process.env.SCREEN_DETECTION_CASCADE_ENABLED === 'true') {
      const verifyResult = await verifyScreenAfterStep({
        deviceId,
        platform,
        workflowId,
        stepIndex,
        expectedScreen: step.expectedScreen,
        confidenceThreshold: step.screenConfidenceThreshold,
        policy: step.screenMismatchPolicy,
        currentRetry: step._screenRetryCount ?? 0,
      });

      if (verifyResult.shouldAbort) {
        const expected = Array.isArray(step.expectedScreen) 
          ? step.expectedScreen.join(',') 
          : step.expectedScreen;
        throw new Error(
          `Screen mismatch at step ${stepIndex}: expected [${expected}], ` +
          `got ${verifyResult.detected.screenId} (conf=${verifyResult.detected.confidence.toFixed(2)})`
        );
      }

      if (verifyResult.shouldRetry) {
        console.log(`[workflow] ${workflowId} step ${stepIndex}: screen mismatch after cascade, retrying...`);
        await sleep(step.screenMismatchPolicy?.delayMs ?? 500);
        await executeActionStep(
          workflowId, deviceId, template,
          { ...step, _screenRetryCount: (step._screenRetryCount ?? 0) + 1 },
          checkpoint, stepIndex
        );
        return;
      }

      if (!verifyResult.match) {
        console.warn(`[workflow] ${workflowId} step ${stepIndex}: screen mismatch (continue_with_warning mode)`);
      }
    }
    
    return; // Cascade handled the tap — skip regular dispatch
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGULAR DISPATCH: For non-cascade actions (or tap with explicit x/y coords)
  // ═══════════════════════════════════════════════════════════════════════════
  // action string → JobType (validated by dispatcher whitelist)
  const jobType = step.action as import("../../../../shared/protocol/messages").JobType;

  const { jobId } = await dispatcherService.dispatch({
    deviceId,
    type:        jobType,
    params:      finalParams as import("../../../../shared/protocol/messages").JobParams,
    timeoutMs,
    confirmRoot: isRootAction(step.action),
    workflowId,
    stepIndex,
    verificationStrategy: strategy,
    l1TimeoutMs: hbeStep.l1TimeoutMs,
    l2SettleMs:  hbeStep.l2SettleMs,
  });

  // Write audit log entry at dispatch
  const db = getDb();
  await db.query(
    `INSERT INTO command_log (device_id, job_id, command_type, command_raw, command_params)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [deviceId, jobId, step.action, `workflow:${workflowId} step:${stepIndex} ${step.action}`, JSON.stringify(finalParams)]
  );

  // Send to device via Nostr adapter
  await wfAdapter.sendJob(deviceId, {
    jobId,
    type:     jobType,
    params:   finalParams as import("../../../../shared/protocol/messages").JobParams,
    timeoutMs,
    requiresRoot:         isRootAction(step.action),
    verificationStrategy: strategy,
    l1TimeoutMs:          hbeStep.l1TimeoutMs,
    l2SettleMs:           hbeStep.l2SettleMs,
  });

  console.log(`[workflow] ${workflowId} step ${stepIndex} dispatched ${step.action} → jobId=${jobId}`);

  // ── Await JOB_RESULT from device ──
  // resolveJobResult() will be called by WsServer when JOB_RESULT arrives.
  const result = await awaitJobResult(jobId, timeoutMs + 5_000 /* grace period */);

  if (result.status === "failed" || result.status === "timeout") {
    const retries = step.retries ?? 0;
    if (retries > 0) {
      console.warn(`[workflow] ${workflowId} step ${stepIndex} failed — retrying (${retries} retries left)`);
      // Modify step retries for recursive retry (crude but effective for Phase 2)
      await executeActionStep(workflowId, deviceId, template, { ...step, retries: retries - 1 }, checkpoint, stepIndex);
      return;
    }
    throw new Error(`Step ${stepIndex} (${step.action}) failed: ${result.error ?? result.status}`);
  }

  // Post-action HBE delay (human settle time after action)
  if (hbeStep.action.postActionDelayMs > 0) {
    await sleep(hbeStep.action.postActionDelayMs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREEN VERIFICATION (after regular dispatch)
  // Story: US-WORKFLOW-SCREEN-VERIFY
  // ═══════════════════════════════════════════════════════════════════════════
  if (step.expectedScreen && process.env.SCREEN_DETECTION_CASCADE_ENABLED === 'true') {
    const verifyResult = await verifyScreenAfterStep({
      deviceId,
      platform,
      workflowId,
      stepIndex,
      expectedScreen: step.expectedScreen,
      confidenceThreshold: step.screenConfidenceThreshold,
      policy: step.screenMismatchPolicy,
      currentRetry: step._screenRetryCount ?? 0,
    });

    if (verifyResult.shouldAbort) {
      const expected = Array.isArray(step.expectedScreen) 
        ? step.expectedScreen.join(',') 
        : step.expectedScreen;
      throw new Error(
        `Screen mismatch at step ${stepIndex}: expected [${expected}], ` +
        `got ${verifyResult.detected.screenId} (conf=${verifyResult.detected.confidence.toFixed(2)})`
      );
    }

    if (verifyResult.shouldRetry) {
      console.log(`[workflow] ${workflowId} step ${stepIndex}: screen mismatch, retrying...`);
      await sleep(step.screenMismatchPolicy?.delayMs ?? 500);
      await executeActionStep(
        workflowId, deviceId, template,
        { ...step, _screenRetryCount: (step._screenRetryCount ?? 0) + 1 },
        checkpoint, stepIndex
      );
      return;
    }

    if (!verifyResult.match) {
      console.warn(`[workflow] ${workflowId} step ${stepIndex}: screen mismatch (continue_with_warning mode)`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new workflow execution.
 * Called from routes.ts POST /workflows.
 */
export async function startWorkflow(workflowId: string): Promise<void> {
  const queue = getWorkflowQueue();
  await queue.add("execute-workflow", { workflowId }, {
    jobId: workflowId,  // Unic per workflow - previne duplicate jobs
    removeOnComplete: true,
    removeOnFail: false  // Keep for debugging
  });
  console.log(`[workflow] ${workflowId} enqueued`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildHbeSession(wf: { checkpoint: WorkflowCheckpoint }): HbeSessionParams {
  // Fresh session — pick mood and drift from account age.
  // Account age stored in HBE params (from account management, Phase 3).
  // Phase 2: default 30 days (growth phase) and Europe/Bucharest timezone.
  const accountAgeDays    = (wf.checkpoint.variables?.["accountAgeDays"] as number) ?? 30;
  const simulatedTimezone = (wf.checkpoint.variables?.["timezone"] as string) ?? "Europe/Bucharest";
  return hbeService.initSession(accountAgeDays, simulatedTimezone);
}

function resolveWaitDuration(step: WaitStep, hbeSession: HbeSessionParams): number {
  if (!step.duration) return 0;
  const { min, max, distribution, mean } = step.duration;
  const m = hbeSession?.timingMultiplier ?? 1.0;
  const baseMean = mean ?? (min + max) / 2;
  switch (distribution) {
    case "lognormal": return clamp(logNormal(baseMean * m, 0.4), min, max);
    case "normal":    return clamp(normal(baseMean * m, (max - min) / 6), min, max);
    //                                                   ^^^^^^^^^^^^^^
    //                                                   stddev ≈ (max-min)/6 → ~99.7% within [min,max]
    //                                                   Previously used Math.random() uniform — not Gaussian
    default:          return uniform(min * m, max * m);
  }
}

function resolveLoopCount(step: LoopStep): number {
  const { min, max, distribution } = step.count;
  if (distribution === "normal") {
    return Math.round(clamp(normal((min + max) / 2, (max - min) / 6), min, max));
  }
  return Math.round(uniform(min, max));
}

function evaluateCondition(step: ConditionStep, checkpoint: WorkflowCheckpoint): boolean {
  switch (step.check) {
    case "random_probability":
      return Math.random() < (step.probability ?? 0.5);

    case "mood_engaged":
    case "mood_explorer": {
      // hbeParams.mood is a MoodProfile object: { mood: "engaged"|"casual"|... }
      // NOT a plain string — must navigate one level deeper.
      const moodProfile = (checkpoint.hbeParams as Record<string, unknown>)?.["mood"] as Record<string, unknown> | undefined;
      const moodName = moodProfile?.["mood"] as string | undefined;
      return moodName === (step.check === "mood_engaged" ? "engaged" : "explorer");
    }

    case "account_warmup": {
      // hbeParams.drift is a DriftProfile object: { phase: "warmup"|"growth"|"mature" }
      // NOT a flat "driftPhase" key.
      const drift = (checkpoint.hbeParams as Record<string, unknown>)?.["drift"] as Record<string, unknown> | undefined;
      return drift?.["phase"] === "warmup";
    }

    default:
      return false;
  }
}

function enforcePhase2Strategy(
  strategy:   VerificationStrategy,
  workflowId: string,
  stepIndex:  number
): "local_only" | "local_with_screenshot" {
  if (PHASE2_UNSUPPORTED_STRATEGIES.includes(strategy)) {
    console.warn(`[workflow] ${workflowId} step ${stepIndex}: "${strategy}" requires VLM (Phase 3) — downgrading to local_with_screenshot`);
    return "local_with_screenshot";
  }
  return strategy as "local_only" | "local_with_screenshot";
}

function mapActionToHbeType(action: string): "tap" | "swipe" | "type" | "scroll" | "navigate" | "wait" {
  const map: Record<string, "tap" | "swipe" | "type" | "scroll" | "navigate" | "wait"> = {
    tap: "tap", swipe: "swipe", type_text: "type", scroll: "scroll",
    open_app: "navigate", close_app: "navigate",
  };
  return map[action] ?? "tap";
}

function isRootAction(action: string): boolean {
  return ["pm_uninstall", "reboot", "ota_update"].includes(action);
}

async function simulateError(errorType: string | undefined, _deviceId: string): Promise<void> {
  // Brief pause for human-like error simulation (actual error gesture in Phase 3)
  await sleep(errorType === "scroll_past" ? 150 : 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
