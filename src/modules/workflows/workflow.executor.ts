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
import { sendJobToDevice, isDeviceOnline } from "../../transport/transport";
import { directWsServer } from "../../ws/direct-ws.server";
import { scalabilityConfig } from "../../config/scalability.config";
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

export const WORKFLOW_QUEUE = scalabilityConfig.workflowQueueName;

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
    scalabilityConfig.workflowQueueName,
    async (job) => {
      const { workflowId } = job.data as { workflowId: string };
      await runWorkflow(workflowId, job);
    },
    {
      connection:    getRedisConnectionOptions(),
      concurrency:   scalabilityConfig.workerConcurrency,
      lockDuration:  scalabilityConfig.workerLockDuration,
      stalledInterval: scalabilityConfig.workerStalledInterval,
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
  // ── Batch checkpoint recovery ─────────────────────────────────────────────
  // If resuming from a checkpoint that had an in-progress batch,
  // load the partial results and resume from the failed step.
  const cp = checkpoint as unknown as Record<string, unknown>;
  if (!isNested && cp.batchId) {
    const batchId = cp.batchId as string;
    const batchResults = (cp.batchResults as import("../../protocol/batch-types").StepResult[]) ?? [];
    const nextIdx = cp.nextStepIndex as number | undefined;

    if (batchId && nextIdx !== undefined && nextIdx < steps.length) {
      console.log(`[workflow] ${workflowId}: resuming batch ${batchId.slice(0,8)} from step ${nextIdx} (${batchResults.length} results already collected)`);

      // Find first failed step in batchResults to resume from
      const firstFailed = batchResults.findIndex(
        r => r.status === "failed" || r.status === "timeout"
      );

      if (firstFailed >= 0) {
        // There was a failure in the partial batch — retry remaining steps
        const resumeFrom = startIndex + firstFailed;
        console.log(`[workflow] ${workflowId}: batch had failure at step ${firstFailed} → retry from index ${resumeFrom}`);
        // Continue execution from the failed step (batchResults already collected for earlier steps)
        // This effectively skips re-running already-completed steps in the batch
        // but since device state has advanced, we accept the re-execution risk for retries
        startIndex = resumeFrom;
      } else {
        // No failure in collected results — batch was still running
        // Resume from nextStepIndex
        startIndex = nextIdx;
      }
    }

    // Clear batch checkpoint fields (don't carry over to next checkpoint)
    delete cp.batchId;
    delete cp.batchResults;
    delete cp.nextStepIndex;
  }

  // ── Compile steps into batch segments ────────────────────────────────────
  const segments = compileBatchSegments(steps, startIndex);
  console.log(`[workflow] ${workflowId} compiled ${steps.length} steps into ${segments.length} segments (starting at ${startIndex})`);

  for (const segment of segments) {
    // ── Cancellation / pause check ─────────────────────────────────────────
    const current = await withTimeout(
      workflowService.get(workflowId),
      scalabilityConfig.cancelCheckTimeout,
      `workflowService.get(${workflowId}) timeout during cancel check`
    );
    if (current?.status === "cancelled") {
      console.log(`[workflow] ${workflowId} cancelled`);
      return;
    }
    if (current?.status === "paused") {
      throw new Error(`Workflow paused`);
    }

    if (segment.isBatched) {
      // ══ BATCH SEGMENT ════════════════════════════════════════════════════
      // 2+ consecutive batchable steps → execute as one Fast-Path batch
      await executeBatchSegment(
        workflowId, deviceId, template, segment, checkpoint, job, isNested
      );
    } else {
      // ══ SINGLE STEP ═══════════════════════════════════════════════════════
      // Control flow, skill actions, singletons → execute individually
      for (const step of segment.steps) {
        const segIdx = segment.startIndex + segment.steps.indexOf(step);

        // Cancellation / pause check per step
        const cur = await withTimeout(
          workflowService.get(workflowId),
          scalabilityConfig.cancelCheckTimeout,
          `workflowService.get(${workflowId}) timeout at step ${segIdx}`
        );
        if (cur?.status === "cancelled") { return; }
        if (cur?.status === "paused") { throw new Error(`Workflow paused at step ${segIdx}`); }

        await executeStep(workflowId, deviceId, template, step, checkpoint, segIdx, job);

        // Extend BullMQ lock after each step
        if (job) {
          try {
            await job.extendLock(job.token!, 60000);
          } catch (lockErr) {
            console.warn(`[workflow] ${workflowId} failed to extend lock at step ${segIdx}: ${lockErr}`);
          }
        }

        // Checkpoint after each step (top-level only)
        if (!isNested) {
          const saved = await workflowService.saveCheckpoint(
            workflowId,
            { ...checkpoint, stepIndex: segIdx + 1, checkpointAt: new Date().toISOString() },
            segIdx + 1,
            segIdx
          );
          if (!saved) {
            throw new Error(`Checkpoint conflict at step ${segIdx} — aborting`);
          }
          checkpoint.stepIndex = segIdx + 1;
        }
      }
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
  const stepId = (step as { id?: string }).id ?? step.type;
  const stepAction = (step as ActionStep).action ?? '';
  console.log(`[workflow] ${workflowId} step ${stepIndex} executing: type=${step.type}${stepAction ? ' action='+stepAction : ''}${stepId !== step.type ? ' id='+stepId : ''}`);

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
      const jobType = type as import("../../../shared/protocol/messages").JobType;
      const { jobId } = await dispatcherService.dispatch({
        deviceId,
        type:     jobType,
        params:   params as import("../../../shared/protocol/messages").JobParams,
        timeoutMs,
        workflowId,
        stepIndex,
      });
      const sent = sendJobToDevice(deviceId, { jobId, type: jobType, params: params as import("../../../shared/protocol/messages").JobParams, timeoutMs });
      if (!sent) throw new Error("Failed to send job to device");
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
  if (!isDeviceOnline(deviceId)) {
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
  const jobType = step.action as import("../../../shared/protocol/messages").JobType;

  const { jobId } = await dispatcherService.dispatch({
    deviceId,
    type:        jobType,
    params:      finalParams as import("../../../shared/protocol/messages").JobParams,
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

  // Send to device via DirectWS transport
  sendJobToDevice(deviceId, {
    jobId,
    type:     jobType,
    params:   finalParams as import("../../../shared/protocol/messages").JobParams,
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

// ─── Batch segmentation ───────────────────────────────────────────────────────

/**
 * A segment of steps that can be executed as one batch, or a single control-flow step.
 */
export interface BatchSegment {
  /** Steps in this segment (length === 1 for non-batchable, length >= 1 for batchable) */
  steps: WorkflowStep[];
  /** If true: execute as single BATCH_START. If false: execute steps individually. */
  isBatched: boolean;
  /** Starting step index in the original workflow steps array */
  startIndex: number;
}

/**
 * Actions that can be executed inside a batch (Fast-Path).
 * These map directly to BatchStepActionType in batch-types.ts.
 */
const BATCHABLE_ACTIONS = new Set([
  "tap", "type", "swipe", "scroll",
  "press_back", "press_home", "press_recent",
  "open_app", "close_app",
  "keyevent", "long_press", "double_tap",
]);

/**
 * Actions that require server-side hooks and cannot be batched.
 */
const NON_BATCHABLE_ACTIONS = new Set([
  "cascade_tap", "ui_tree_dump", "screenshot",
  "pm_install", "pm_uninstall", "reboot",
  "ota_update", "screen_detect",
]);

/**
 * Check if a workflow action step is batchable (can run Fast-Path in a batch).
 */
function isBachableActionStep(step: WorkflowStep): boolean {
  if (step.type !== "action") return false;
  const actionStep = step as ActionStep;

  // Must be a batchable action type
  if (!BATCHABLE_ACTIONS.has(actionStep.action)) return false;

  // Non-batchable action types
  if (NON_BATCHABLE_ACTIONS.has(actionStep.action)) return false;

  // Cascade tap (target element without explicit coords) → NOT batchable
  if ((actionStep as { target?: string }).target && !actionStep.x && !actionStep.y) return false;

  // Screen verification required → NOT batchable (needs server-side cascade)
  if ((actionStep as { expectedScreen?: string }).expectedScreen) return false;

  // Error simulation → NOT batchable (HBE server-side hook)
  const hasErrorSim = (actionStep.params as Record<string, unknown>)?.["errorSimulation"];
  if (hasErrorSim) return false;

  // textFromVariable resolution → NOT batchable (server-side)
  const textFromVar = (actionStep.params as Record<string, unknown>)?.["textFromVariable"];
  if (textFromVar) return false;

  // Needs retry logic → batched retries complicate state; execute individually
  if ((actionStep as { retries?: number }).retries && (actionStep as { retries?: number }).retries! > 0) return false;

  return true;
}

/**
 * Compile consecutive workflow steps into BatchSegments.
 *
 * Rule: group consecutive batchable action steps into segments of size >= 2.
 * Singletons and non-batchable steps become their own segments.
 * Control flow steps (condition, loop, checkpoint) are always separate segments.
 *
 * Example:
 *   [tap, tap, condition, tap, tap, tap, wait]
 *   → [{batched:[tap,tap]}, {batched:false:[condition]},
 *      {batched:[tap,tap,tap]}, {batched:false:[wait]}]
 */
export function compileBatchSegments(steps: WorkflowStep[], startIndex = 0): BatchSegment[] {
  const segments: BatchSegment[] = [];
  const slice = steps.slice(startIndex);

  let i = 0;
  while (i < slice.length) {
    const step = slice[i];

    // Non-action steps → always their own segment (not batched)
    if (step.type !== "action") {
      segments.push({ steps: [step], isBatched: false, startIndex: startIndex + i });
      i++;
      continue;
    }

    // Skill actions → not batched (server-side execution)
    if (isSkillAction((step as ActionStep).action)) {
      segments.push({ steps: [step], isBatched: false, startIndex: startIndex + i });
      i++;
      continue;
    }

    // Collect consecutive batchable action steps
    const batchRun: WorkflowStep[] = [];
    const batchStartIndex = i;

    while (i < slice.length && isBachableActionStep(slice[i])) {
      batchRun.push(slice[i]);
      i++;
    }

    if (batchRun.length >= 2) {
      // 2+ consecutive batchable steps → batch segment
      segments.push({ steps: batchRun, isBatched: true, startIndex: startIndex + batchStartIndex });
    } else if (batchRun.length === 1) {
      // Single batchable step → execute individually (overhead not worth a round-trip)
      segments.push({ steps: batchRun, isBatched: false, startIndex: startIndex + batchStartIndex });
    } else {
      // Non-batchable action step (screen_wake, unlock, screenshot, etc.) → singleton, execute individually
      // MUST increment i to avoid infinite loop!
      segments.push({ steps: [slice[i]], isBatched: false, startIndex: startIndex + i });
      i++;
    }
    // which is handled at the top of the next iteration
  }

  return segments;
}

/**
 * Convert a WorkflowStep (action) to a BatchStep for executeBatchSteps.
 */
function workflowStepToBatchStep(step: WorkflowStep, stepId: number): import("../../protocol/batch-types").BatchStep | null {
  if (step.type !== "action") return null;
  const ws = step as ActionStep;

  const batchStep: import("../../protocol/batch-types").ActionStep = {
    id: stepId,
    type: "action",
    action: ws.action as import("../../protocol/batch-types").ActionType,
    target: (ws as { target?: string }).target ?? null,
    params: {
      ...(ws.params as Record<string, unknown>),
      // Resolve explicit coords if present (normalized 0.0-1.0 from workflow)
      ...(ws.x !== undefined && ws.y !== undefined
        ? ({ x: ws.x, y: ws.y } as Record<string, unknown>)
        : {}),
    } as Record<string, unknown>,
    verify: (ws as unknown as Record<string, unknown>).verification as import("../../protocol/batch-types").VerificationConfig | null ?? undefined,
  };

  return batchStep as import("../../protocol/batch-types").BatchStep;
}

// ─── Batch segment execution ────────────────────────────────────────────────

/**
 * Execute a batch segment with checkpoint support.
 *
 * Flow:
 *   1. Build BATCH_START from segment steps
 *   2. Execute via executeBatchSteps()
 *   3. On success / partial_failure (continueOnError=true): checkpoint + continue
 *   4. On failure (continueOnError=false): checkpoint with batchResults + throw → retry
 *   5. On timeout: checkpoint + throw → retry
 */
async function executeBatchSegment(
  workflowId: string,
  deviceId:   string,
  template:   WorkflowTemplate,
  segment:    BatchSegment,
  checkpoint: WorkflowCheckpoint,
  job:        import("bullmq").Job | undefined,
  isNested:   boolean,
): Promise<void> {
  const batchId = uuidv4Batch();
  const stepIndex = segment.startIndex; // global step index of first step in batch

  // Convert workflow steps → batch steps (with 1-based ids matching step position in segment)
  const batchSteps: import("../../protocol/batch-types").BatchStep[] = [];
  for (let i = 0; i < segment.steps.length; i++) {
    const converted = workflowStepToBatchStep(segment.steps[i], i + 1);
    if (converted) batchSteps.push(converted);
  }

  // HBE: compute timing for the batch.
  // Pre-compute post-action delays for the last step only (all other HBE delays
  // are absorbed into the batch execution on device).
  const hbeSession = checkpoint.hbeParams as unknown as HbeSessionParams;
  const lastStep = segment.steps[segment.steps.length - 1] as ActionStep;
  const hbeLast = hbeService.getActionParams(
    mapActionToHbeType(lastStep?.action ?? "tap"),
    hbeSession,
    { verificationStrategy: "local_only" }
  );

  const batchTimeoutMs =
    30_000 * segment.steps.length * 2;

  // Pre-action HBE delay (human micro-pause before batch)
  if (hbeLast.action.preActionDelayMs > 0) {
    await sleep(hbeLast.action.preActionDelayMs);
  }

  let batchResult: import("../../protocol/batch-types").BATCH_RESULT;

  try {
    batchResult = await executeBatchSteps(deviceId, workflowId, stepIndex, batchSteps, {
      continueOnError: false, // We handle continueOnError per-step via retry logic
      timeoutMs: 30_000,
      batchTimeoutMs,
    });
  } catch (err) {
    // Batch failed to execute (device offline, timeout, network error)
    // Save checkpoint with batch state for retry
    if (!isNested) {
      await workflowService.saveCheckpoint(
        workflowId,
        {
          ...checkpoint,
          stepIndex: stepIndex, // retry from first step of this batch
          checkpointAt: new Date().toISOString(),
        },
        stepIndex,
        stepIndex - 1,
      );
    }
    throw err;
  }

  const { status, results } = batchResult;
  const failedStepIdx = results.findIndex(
    r => r.status === "failed" || r.status === "timeout"
  );

  if (status === "completed") {
    // All steps succeeded → checkpoint after last step
    const lastStepIndex = stepIndex + segment.steps.length;

    if (!isNested) {
      const saved = await workflowService.saveCheckpoint(
        workflowId,
        {
          ...checkpoint,
          stepIndex: lastStepIndex,
          checkpointAt: new Date().toISOString(),
        },
        lastStepIndex,
        stepIndex + segment.steps.length - 1,
      );
      if (!saved) throw new Error(`Checkpoint conflict after batch — aborting`);
      checkpoint.stepIndex = lastStepIndex;
    }

    // Post-batch HBE settle
    if (hbeLast.action.postActionDelayMs > 0) {
      await sleep(hbeLast.action.postActionDelayMs);
    }

    console.log(`[workflow] ${workflowId} batch ${batchId.slice(0,8)} completed: ${results.length} steps`);
    return;
  }

  if (status === "partial_failure") {
    // Some steps failed, but continueOnError=true on device → we got partial results
    // Log failures and continue to next segment
    for (const r of results) {
      if (r.status === "failed") {
        console.warn(`[workflow] ${workflowId} batch step ${r.id} failed: ${r.error}`);
      } else if (r.status === "timeout") {
        console.warn(`[workflow] ${workflowId} batch step ${r.id} timed out`);
      }
    }

    const nextStepIndex = stepIndex + segment.steps.length;

    if (!isNested) {
      const saved = await workflowService.saveCheckpoint(
        workflowId,
        {
          ...checkpoint,
          stepIndex: nextStepIndex,
          checkpointAt: new Date().toISOString(),
        },
        nextStepIndex,
        stepIndex + segment.steps.length - 1,
      );
      if (!saved) throw new Error(`Checkpoint conflict after partial batch — aborting`);
      checkpoint.stepIndex = nextStepIndex;
    }

    // Post-batch HBE settle
    if (hbeLast.action.postActionDelayMs > 0) {
      await sleep(hbeLast.action.postActionDelayMs);
    }

    console.log(`[workflow] ${workflowId} batch ${batchId.slice(0,8)} partial_failure at step ${failedStepIdx} — continuing`);
    return;
  }

  // status === "failed" or "timeout": abort the workflow
  // Save batch state for retry (resume from failed step on next attempt)
  const failedGlobalIndex = stepIndex + (failedStepIdx >= 0 ? failedStepIdx : 0);

  if (!isNested) {
    const saved = await workflowService.saveCheckpoint(
      workflowId,
      {
        ...checkpoint,
        stepIndex: failedGlobalIndex, // retry from this step on next attempt
        checkpointAt: new Date().toISOString(),
      },
      failedGlobalIndex,
      stepIndex + segment.steps.length - 1,
    );
    if (!saved) throw new Error(`Checkpoint conflict on batch failure — aborting`);
    checkpoint.stepIndex = failedGlobalIndex;
  }

  const errorMsg =
    status === "timeout"
      ? `Batch timeout after ${batchTimeoutMs}ms`
      : `Batch failed at step ${failedStepIdx + 1} (global=${failedGlobalIndex}): ${
          results.find(r => r.status === "failed" || r.status === "timeout")?.error ?? "Unknown"
        }`;

  throw new Error(errorMsg);
}

// ─── Batch execution (Fast-Path) ────────────────────────────────────────────

/**
 * Send a BATCH_START to a device and await BATCH_RESULT.
 *
 * This replaces multiple individual JOB/JOB_RESULT round-trips with a single
 * message pair. Used for consecutive steps that don't need server-side decisions.
 *
 * @param deviceId   Target device
 * @param workflowId Workflow ID (for tracking)
 * @param stepIndex  Starting step index in workflow
 * @param steps      Array of BatchStep objects (from batch-types.ts)
 * @param options    Batch options (timeout, continueOnError)
 * @returns BATCH_RESULT from device
 */
export async function executeBatchSteps(
  deviceId:   string,
  workflowId: string,
  stepIndex:  number,
  steps:      import("../../protocol/batch-types").BatchStep[],
  options?:   Partial<import("../../protocol/batch-types").BatchOptions>,
): Promise<import("../../protocol/batch-types").BATCH_RESULT> {
  const batchId = uuidv4Batch();

  const batchPayload = {
    type:       "BATCH_START",
    batchId,
    workflowId,
    stepIndex,
    steps,
    options: {
      continueOnError: options?.continueOnError ?? false,
      timeoutMs:       options?.timeoutMs ?? 30_000,
      batchTimeoutMs:  options?.batchTimeoutMs ??
        (options?.timeoutMs ?? 30_000) * steps.length * 2,
    },
  };

  const sent = directWsServer.sendBatch(deviceId, batchPayload);
  if (!sent) {
    throw new Error(`Device ${deviceId} offline — cannot send batch ${batchId}`);
  }

  console.log(`[workflow] Batch ${batchId.slice(0,8)} sent to ${deviceId.slice(0,8)}: ${steps.length} steps`);

  const result = await directWsServer.waitForBatchResult(
    batchId,
    (batchPayload.options as Record<string, unknown>).batchTimeoutMs as number + 30_000,
  );

  console.log(`[workflow] Batch ${batchId.slice(0,8)} result: status=${result.status} steps=${result.results.length} totalMs=${result.totalDurationMs}`);

  return {
    type:       "BATCH_RESULT",
    batchId:    result.batchId,
    workflowId: result.workflowId,
    status:     result.status as import("../../protocol/batch-types").BatchStatus,
    results:    result.results as import("../../protocol/batch-types").StepResult[],
    executedAt: result.executedAt,
  };
}

/**
 * Generate a batch UUID (v4).
 * Uses the same uuid library as the rest of the executor.
 */
function uuidv4Batch(): string {
  const { v4 } = require("uuid");
  return v4();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new workflow execution.
 * Called from routes.ts POST /workflows.
 *
 * Uses a 5s timeout on queue.add() to prevent indefinite blocking
 * if Redis is slow or unresponsive.
 */
export async function startWorkflow(workflowId: string): Promise<void> {
  const queue = getWorkflowQueue();
  const addPromise = queue.add("execute-workflow", { workflowId }, {
    jobId: workflowId,  // Unic per workflow - previne duplicate jobs
    removeOnComplete: true,
    removeOnFail: false  // Keep for debugging
  });

  // Timeout — don't block the caller if Redis is slow
  const result = await Promise.race([
    addPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`queue.add() timeout for ${workflowId}`)), scalabilityConfig.enqueueTimeout)
    ),
  ]);

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

/**
 * Wrap a promise with a timeout. Rejects with the given message if the
 * promise doesn't settle within `ms` milliseconds.
 * Used to prevent DB/Redis operations from hanging indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
