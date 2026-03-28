/**
 * agents/orchestrator.ts
 * Coordinates Planner → Executor → Verifier loop.
 */

import { v4 as uuidv4 } from "uuid";
import { plannerAgent } from "./planner.agent";
import { executorAgent } from "./executor.agent";
import { verifierAgent } from "./verifier.agent";
import { getCachedPlan, savePlanToCache, recordPlanOutcome } from "./plan-cache";
import { learnFromSuccess, learnFromFailure } from "./self-evolution";
import { getLlmClient } from "./llm-client";
import { agentConfig } from "../../config/agents.config";
import { wsServer } from "../../ws/ws.server";
import { getDb } from "../../db/client";
import * as skillService from "../skills/skill.service";
import type {
  ExecutorOutput,
  TaskResult,
  TokenUsage,
} from "./types";

// ─── Screen dimensions cache ─────────────────────────────────────────────────

const _dimsCache = new Map<string, { w: number; h: number; ts: number }>();
const DIMS_TTL = 5 * 60_000;

/**
 * Known screen resolutions by device model substring (lowercase match).
 * Fallback when health JSONB lacks explicit screenResolution.
 */
const MODEL_SCREEN_DIMS: Array<{ pattern: string; w: number; h: number }> = [
  // OnePlus 5  (A5000) — 1080×1920
  { pattern: "a5000",      w: 1080, h: 1920 },
  { pattern: "oneplus5 ",  w: 1080, h: 1920 },   // trailing space to avoid matching 5T
  { pattern: "cheeseburger", w: 1080, h: 1920 },  // codename
  // OnePlus 5T (A5010) — 1080×2160 (18:9)
  { pattern: "a5010",      w: 1080, h: 2160 },
  { pattern: "oneplus 5t", w: 1080, h: 2160 },
  { pattern: "oneplus5t",  w: 1080, h: 2160 },
  { pattern: "dumpling",   w: 1080, h: 2160 },    // codename
  // OnePlus 6T (A6013) — 1080×2340 (19.5:9)
  { pattern: "a6013",      w: 1080, h: 2340 },
  { pattern: "oneplus 6t", w: 1080, h: 2340 },
  { pattern: "oneplus6t",  w: 1080, h: 2340 },
  { pattern: "fajita",     w: 1080, h: 2340 },    // codename
];

function dimsFromModel(model: string | undefined): { w: number; h: number } | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const entry of MODEL_SCREEN_DIMS) {
    if (lower.includes(entry.pattern)) return { w: entry.w, h: entry.h };
  }
  return null;
}

async function getScreenDims(deviceId: string): Promise<{ w: number; h: number }> {
  const cached = _dimsCache.get(deviceId);
  if (cached && Date.now() - cached.ts < DIMS_TTL) return { w: cached.w, h: cached.h };

  try {
    const db = getDb();
    const row = await db.query<{ health: Record<string, unknown>; model: string | null; friendly_name: string | null }>(
      "SELECT health, model, friendly_name FROM devices WHERE id = $1",
      [deviceId]
    );
    if (row.rows.length > 0) {
      const health = row.rows[0].health || {};

      // Source 1: explicit screen dims in health JSONB (future: sent from Android heartbeat)
      const res = health.screenResolution as string | undefined;
      if (res && res.includes("x")) {
        const [ws, hs] = res.split("x");
        const w = parseInt(ws, 10);
        const h = parseInt(hs, 10);
        if (w > 0 && h > 0) {
          _dimsCache.set(deviceId, { w, h, ts: Date.now() });
          return { w, h };
        }
      }
      if (health.screenWidth && health.screenHeight) {
        const w = health.screenWidth as number;
        const h = health.screenHeight as number;
        _dimsCache.set(deviceId, { w, h, ts: Date.now() });
        return { w, h };
      }

      // Source 2: derive from device model (DB column or health.model from HELLO)
      const modelStr = row.rows[0].model
        ?? row.rows[0].friendly_name
        ?? (health.model as string | undefined)
        ?? (health.agentVersion as string | undefined); // last resort: version string sometimes has model
      const modelDims = dimsFromModel(modelStr);
      if (modelDims) {
        console.log(`[orchestrator] Screen dims from model lookup "${modelStr}": ${modelDims.w}x${modelDims.h} (device ${deviceId.slice(0, 8)})`);
        _dimsCache.set(deviceId, { ...modelDims, ts: Date.now() });
        return modelDims;
      }

      console.warn(`[orchestrator] No screen dims and model lookup failed for device ${deviceId.slice(0, 8)} (model="${modelStr}")`);
    }
  } catch { /* non-fatal */ }

  // Last resort fallback — log clearly so we notice
  // B5 fix: OnePlus 5 (cheeseburger/A5000) is 1080x1920, NOT 2160. 2160 is OnePlus 5T.
  // Fallback remains 2160 for the majority (5T/6T fleet) but model lookup above should
  // catch OnePlus 5 via its codename "cheeseburger" or model "a5000" before we get here.
  console.warn(`[orchestrator] FALLBACK screen dims for device ${deviceId.slice(0, 8)}: 1080x2160`);
  return { w: 1080, h: 2160 }; // 5T/6T default — OnePlus 5 must be caught by model lookup above
}

// ─── Pending screenshot results ───────────────────────────────────────────────

interface PendingScreenshot {
  resolve: (base64: string | null) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingScreenshots = new Map<string, PendingScreenshot>();

/**
 * Called externally (e.g., from ws.server.ts) when a screenshot JOB_RESULT arrives.
 */
export function resolveScreenshotResult(
  jobId: string,
  result: { status: string; output?: Record<string, unknown> }
): boolean {
  const pending = pendingScreenshots.get(jobId);
  if (!pending) {
    // Not a screenshot job OR already timed out
    return false;
  }
  clearTimeout(pending.timeoutHandle);
  pendingScreenshots.delete(jobId);

  const base64 = result.output?.image_base64 ?? result.output?.base64 ?? result.output?.imageBase64;
  if (result.status === "completed" && base64) {
    console.log(`[orchestrator] resolveScreenshot: jobId=${jobId.slice(0, 8)} OK (${((base64 as string).length / 1024).toFixed(0)}KB)`);
    pending.resolve(base64 as string);
  } else {
    const outputKeys = result.output ? Object.keys(result.output) : [];
    console.warn(`[orchestrator] resolveScreenshot: jobId=${jobId.slice(0, 8)} status=${result.status}, outputKeys=[${outputKeys.join(",")}]`);
    pending.resolve(null);
  }
  return true;
}

function awaitScreenshot(jobId: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingScreenshots.delete(jobId);
      resolve(null);
    }, timeoutMs);

    pendingScreenshots.set(jobId, { resolve, timeoutHandle });
  });
}

// ─── Pending action results ───────────────────────────────────────────────────

interface PendingAction {
  resolve: (success: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingActions = new Map<string, PendingAction>();

/**
 * Called externally (from ws.server.ts) when an action JOB_RESULT arrives.
 */
export function resolveActionResult(
  jobId: string,
  result: { status: string }
): boolean {
  const pending = pendingActions.get(jobId);
  if (!pending) return false;
  clearTimeout(pending.timeoutHandle);
  pendingActions.delete(jobId);
  pending.resolve(result.status === "completed");
  return true;
}

function awaitAction(jobId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingActions.delete(jobId);
      // B6 fix: timeout = failure, not success. Silently resolving true caused
      // the chain to continue on dead/offline/slow devices with no real feedback.
      resolve(false);
    }, timeoutMs);
    pendingActions.set(jobId, { resolve, timeoutHandle });
  });
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class AgentOrchestrator {

  async executeTask(
    task: string,
    deviceId: string,
    platform: string,
    currentScreenshot?: string,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const tokenUsage: TokenUsage = {
      planner: { input: 0, output: 0 },
      executor: { input: 0, output: 0, calls: 0 },
      verifier: { input: 0, output: 0, calls: 0 },
      total: 0,
    };

    // Check device is online
    if (!wsServer.isDeviceConnected(deviceId)) {
      return {
        success: false, stepsCompleted: 0, totalSteps: 0,
        failReason: `Device ${deviceId} is offline`,
        tokenUsage, durationMs: Date.now() - startTime,
      };
    }

    // 0. Navigation preamble — ensure app is on home screen
    console.log(`[orchestrator] Starting task: "${task}" on device ${deviceId.slice(0, 8)}`);
    const t0 = Date.now();
    const preambleOk = await this.ensureAppHomeScreen(deviceId, platform);
    console.log(`[orchestrator] ⏱ Preamble: ${Date.now() - t0}ms (ok=${preambleOk})`);
    if (!preambleOk) {
      console.warn(`[orchestrator] Preamble failed — continuing anyway`);
    }

    // Capture initial screenshot for planner context
    const t1 = Date.now();
    const initialScreenshot = currentScreenshot || await this.captureScreenshot(deviceId);
    console.log(`[orchestrator] ⏱ Initial screenshot: ${Date.now() - t1}ms`);

    // 1. Plan (cache-first, LLM fallback)
    let plan;
    let planCacheId: number | undefined;
    const tPlan = Date.now();

    // B4 fix: plan cache disabled until screen-state validation is implemented.
    // A cached plan assumes screen state from when it was created. If device is on
    // Reels instead of Feed, the plan taps wrong elements from step 1.
    // TODO: re-enable after getCachedPlan() validates currentScreenshot vs plan entry screen.
    //
    // When re-enabling: validate that initialScreenshot matches the plan's entry screen
    // before using the cached plan. Otherwise: always replan.
    /* DISABLED B4
    const cached = await getCachedPlan(task, platform);
    if (cached) {
      plan = cached.plan;
      planCacheId = cached.id;
      console.log(`[orchestrator] ⏱ Planner: ${Date.now() - tPlan}ms (CACHE HIT, hits=${cached.hitCount})`);
    } else { */
    {
      // Cache miss — call LLM planner
      try {
        const planResult = await plannerAgent.plan({
          task, appContext: platform, deviceId, currentScreenshot: initialScreenshot || undefined,
        });
        console.log(`[orchestrator] ⏱ Planner: ${Date.now() - tPlan}ms (LLM, ${planResult.tokens.input}+${planResult.tokens.output} tokens)`);
        plan = planResult.output;
        tokenUsage.planner = planResult.tokens;
      } catch (err) {
        return {
          success: false, stepsCompleted: 0, totalSteps: 0,
          failReason: `Planner failed: ${(err as Error).message}`,
          tokenUsage, durationMs: Date.now() - startTime,
        };
      }
    }

    // A9: empty plan guard
    if (plan.steps.length === 0) {
      return {
        success: false, stepsCompleted: 0, totalSteps: 0,
        failReason: "Planner returned empty plan",
        tokenUsage, durationMs: Date.now() - startTime,
      };
    }

    if (plan.steps.length > agentConfig.orchestrator.maxStepsPerTask) {
      return {
        success: false, stepsCompleted: 0, totalSteps: plan.steps.length,
        failReason: `Plan has ${plan.steps.length} steps (max: ${agentConfig.orchestrator.maxStepsPerTask})`,
        tokenUsage, durationMs: Date.now() - startTime,
      };
    }

    console.log(`[orchestrator] Plan: ${plan.steps.length} steps, complexity=${plan.complexity}`);

    // 2. Execute each step
    let stepsCompleted = 0;
    let consecutiveFailures = 0;
    let firstFailedStep: number | undefined;
    let firstFailReason: string | undefined;
    let skipUntilStepId = -1; // For speculative: skip steps already executed

    for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
      const step = plan.steps[stepIdx];

      // Skip steps already executed speculatively
      if (step.id <= skipUntilStepId) {
        console.log(`[orchestrator] Step ${step.id} already executed speculatively — skipping`);
        stepsCompleted++;
        continue;
      }

      if (consecutiveFailures >= agentConfig.orchestrator.abortOnConsecutiveFailures) {
        console.error(`[orchestrator] Aborting: ${consecutiveFailures} consecutive failures`);
        return {
          success: false, stepsCompleted, totalSteps: plan.steps.length,
          failedStep: step.id,
          failReason: `Aborted after ${consecutiveFailures} consecutive failures`,
          tokenUsage, durationMs: Date.now() - startTime,
        };
      }

      let stepSuccess = false;
      let attempts = 0;

      while (attempts <= agentConfig.orchestrator.maxRetries && !stepSuccess) {
        attempts++;
        console.log(`[orchestrator] Step ${step.id}/${plan.steps.length}: "${step.description}" (attempt ${attempts})`);

        try {
          const tStep = Date.now();

          // a. Capture before-screenshot
          const tSS1 = Date.now();
          const beforeScreenshot = await this.captureScreenshot(deviceId);
          console.log(`[orchestrator] ⏱ Screenshot-before: ${Date.now() - tSS1}ms`);
          if (!beforeScreenshot) {
            console.warn(`[orchestrator] Screenshot failed for step ${step.id}`);
            break;
          }

          // b. Execute (cascade first, LLM fallback with speculative lookahead)
          const remainingSteps = plan.steps.slice(stepIdx + 1);
          const tExec = Date.now();
          const execResult = await executorAgent.execute({
            step, deviceId, platform, screenshot: beforeScreenshot, screenType: step.expectedScreen,
            remainingSteps,
            lookahead: agentConfig.executor.lookahead,
          });
          console.log(`[orchestrator] ⏱ Executor: ${Date.now() - tExec}ms (source=${execResult.output.source}, confidence=${execResult.output.confidence.toFixed(2)})`);
          tokenUsage.executor.input += execResult.tokens.input;
          tokenUsage.executor.output += execResult.tokens.output;
          tokenUsage.executor.calls++;

          const { action } = execResult.output;

          if (action.type === "skip") {
            if (step.optional) {
              console.log(`[orchestrator] Step ${step.id} skipped (optional): ${action.reason}`);
              stepSuccess = true;
              break;
            }
            // Non-optional skip = element not found. Retry with back press (might need scroll/transition).
            console.log(`[orchestrator] Step ${step.id} skip on attempt ${attempts}: ${action.reason}`);
            if (attempts <= agentConfig.orchestrator.maxRetries) {
              console.log(`[orchestrator] Pressing back + will retry`);
              const backJobId = uuidv4();
              const backPromise = awaitAction(backJobId, 3_000);
              wsServer.sendJob(deviceId, {
                jobId: backJobId,
                type: "press_key" as import("../../../../shared/protocol/messages").JobType,
                params: { key: "back" } as Record<string, unknown>,
                timeoutMs: 3_000,
              });
              await backPromise;
              await sleep(500);
            }
            continue; // Retry the while loop
          }

          // c. Perform action on device
          const tAction = Date.now();
          await this.performAction(deviceId, execResult.output);
          console.log(`[orchestrator] ⏱ Action (${action.type}): ${Date.now() - tAction}ms`);

          // d. Wait for UI to settle
          await sleep(agentConfig.orchestrator.screenshotDelayMs);

          // e. Capture after-screenshot
          const tSS2 = Date.now();
          const afterScreenshot = await this.captureScreenshot(deviceId);
          console.log(`[orchestrator] ⏱ Screenshot-after: ${Date.now() - tSS2}ms`);
          if (!afterScreenshot) {
            stepSuccess = true;
            break;
          }

          // f. Verify
          const tVerify = Date.now();
          const verifyResult = await verifierAgent.verify({
            step, actionTaken: action,
            screenshotBefore: beforeScreenshot, screenshotAfter: afterScreenshot,
            platform,
          });
          console.log(`[orchestrator] ⏱ Verifier: ${Date.now() - tVerify}ms (status=${verifyResult.output.status})`);
          console.log(`[orchestrator] ⏱ Step attempt total: ${Date.now() - tStep}ms`);
          tokenUsage.verifier.input += verifyResult.tokens.input;
          tokenUsage.verifier.output += verifyResult.tokens.output;
          tokenUsage.verifier.calls++;

          const verification = verifyResult.output;

          switch (verification.status) {
            case "success":
              console.log(`[orchestrator] Step ${step.id} verified ✓`);
              stepSuccess = true;
              consecutiveFailures = 0;
              // Learn from success
              learnFromSuccess(platform, step, action, Date.now() - tStep).catch(() => {});

              // ─── Execute speculative actions (if any) ──────────────────
              if (execResult.output.speculativeActions && execResult.output.speculativeActions.length > 0) {
                const specActions = execResult.output.speculativeActions;
                console.log(`[orchestrator] Executing ${specActions.length} speculative actions`);

                let specExecuted = 0;
                for (let si = 0; si < specActions.length; si++) {
                  const specAction = specActions[si];
                  const specStep = plan.steps[stepIdx + 1 + si];
                  if (!specStep) break;

                  console.log(`[orchestrator] Speculative ${si + 1}/${specActions.length}: "${specStep.description}" (${specAction.type})`);

                  // Execute speculative action
                  const specExecOutput: ExecutorOutput = {
                    action: specAction,
                    confidence: 0.7,
                    reasoning: "Speculative prediction",
                    source: "llm_inferred",
                  };
                  await this.performAction(deviceId, specExecOutput);
                  await sleep(agentConfig.orchestrator.screenshotDelayMs);

                  // Verify speculative action
                  const specBefore = afterScreenshot; // previous after = current before
                  const specAfter = await this.captureScreenshot(deviceId);
                  if (!specAfter) {
                    // Can't verify — count as done, stop speculation
                    specExecuted++;
                    break;
                  }

                  const specVerify = await verifierAgent.verify({
                    step: specStep,
                    actionTaken: specAction,
                    screenshotBefore: specBefore,
                    screenshotAfter: specAfter,
                    platform,
                  });
                  tokenUsage.verifier.input += specVerify.tokens.input;
                  tokenUsage.verifier.output += specVerify.tokens.output;
                  tokenUsage.verifier.calls++;

                  if (specVerify.output.status === "success" || specVerify.output.status === "skip") {
                    console.log(`[orchestrator] Speculative step ${specStep.id} verified ✓`);
                    specExecuted++;
                    // Update afterScreenshot for next speculative iteration
                    // (afterScreenshot is const, but specAfter serves this role)
                  } else {
                    // Early exit — speculative prediction was wrong
                    console.log(`[orchestrator] Speculative step ${specStep.id} failed (${specVerify.output.status}) — early exit`);
                    break;
                  }
                }

                // Mark speculatively executed steps for skipping
                if (specExecuted > 0) {
                  const lastSpecStep = plan.steps[stepIdx + specExecuted];
                  if (lastSpecStep) {
                    skipUntilStepId = lastSpecStep.id;
                    stepsCompleted += specExecuted;
                    console.log(`[orchestrator] Speculative: ${specExecuted} extra steps done, skipping until step ${skipUntilStepId}`);
                  }
                }
              }
              break;
            case "skip":
              console.log(`[orchestrator] Step ${step.id} skipped by verifier`);
              stepSuccess = true;
              consecutiveFailures = 0;
              break;
            case "retry":
              console.log(`[orchestrator] Step ${step.id} retry: ${verification.reason}`);
              learnFromFailure(platform, step, action, verification.reason).catch(() => {});
              // Invalidate coordinate cache if verifier flagged it
              if (verification.shouldInvalidateCache && action.element) {
                await this.invalidateElementCoords(platform, action.element);
              }
              // On retry: press back to escape potential overlay/fullscreen, then re-attempt
              if (attempts < agentConfig.orchestrator.maxRetries) {
                console.log(`[orchestrator] Pressing back before retry (escape potential overlay)`);
                const backJobId = uuidv4();
                const backPromise = awaitAction(backJobId, 3_000);
                wsServer.sendJob(deviceId, {
                  jobId: backJobId,
                  type: "press_key" as import("../../../../shared/protocol/messages").JobType,
                  params: { key: "back" } as Record<string, unknown>,
                  timeoutMs: 3_000,
                });
                await backPromise;
                await sleep(500);
              }
              break;
            case "abort":
              console.error(`[orchestrator] Step ${step.id} ABORT: ${verification.reason}`);
              tokenUsage.total = tokenUsage.planner.input + tokenUsage.planner.output +
                tokenUsage.executor.input + tokenUsage.executor.output +
                tokenUsage.verifier.input + tokenUsage.verifier.output;
              return {
                success: false, stepsCompleted, totalSteps: plan.steps.length,
                failedStep: step.id, failReason: `Verifier abort: ${verification.reason}`,
                tokenUsage, durationMs: Date.now() - startTime,
              };
          }
        } catch (err) {
          console.error(`[orchestrator] Step ${step.id} error: ${(err as Error).message}`);
        }
      }

      // A3: single increment point — after while loop
      if (stepSuccess) {
        stepsCompleted++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        // Track first failure for reporting
        if (!firstFailedStep) {
          firstFailedStep = step.id;
          firstFailReason = `Step "${step.description}" failed after ${attempts} attempts (max retries exhausted)`;
        }
      }
    }

    tokenUsage.total = tokenUsage.planner.input + tokenUsage.planner.output +
      tokenUsage.executor.input + tokenUsage.executor.output +
      tokenUsage.verifier.input + tokenUsage.verifier.output;

    const requiredSteps = plan.steps.filter((s) => !s.optional).length;
    const requiredCompleted = plan.steps.filter((s, i) => !s.optional && i < stepsCompleted).length;
    const success = stepsCompleted >= requiredSteps;

    console.log(`[orchestrator] Task done: ${stepsCompleted}/${plan.steps.length} steps, success=${success}, tokens=${tokenUsage.total}`);

    // Plan cache: record outcome + save on success
    if (planCacheId !== undefined) {
      recordPlanOutcome(planCacheId, success).catch(() => {});
    } else if (success) {
      // New plan succeeded — cache it for future reuse
      savePlanToCache(task, platform, plan).catch(() => {});
    }

    return {
      success, stepsCompleted, totalSteps: plan.steps.length,
      failedStep: success ? undefined : firstFailedStep,
      failReason: success ? undefined : (firstFailReason || `${stepsCompleted}/${plan.steps.length} steps completed`),
      tokenUsage, durationMs: Date.now() - startTime,
    };
  }

  // ─── Navigation preamble ─────────────────────────────────────────────────────

  /** Platform → Android package name */
  private static readonly PLATFORM_PACKAGES: Record<string, string> = {
    instagram: "com.instagram.android",
    tiktok:    "com.zhiliaoapp.musically",
    facebook:  "com.facebook.katana",
    twitter:   "com.twitter.android",
    pinterest: "com.pinterest",
    threads:   "com.instagram.barcelona",
  };

  /**
   * Platform → explicit intent params to launch HOME/FEED screen.
   * intent_send on device expects: { uri, action, packageName, flags }
   * Using LAUNCHER category + CLEAR_TOP forces feed, not last-viewed Reels.
   */
  private static readonly PLATFORM_HOME_INTENTS: Record<string, {
    uri: string;
    action: string;
    packageName: string;
    flags: string[];
  }> = {
    instagram: {
      // instagram://feed — forces home feed.
      // Use CLEAR_TASK to destroy back stack fully (prevents Reels restore).
      uri: "instagram://feed",
      action: "android.intent.action.VIEW",
      packageName: "com.instagram.android",
      flags: ["FLAG_ACTIVITY_CLEAR_TASK"],
    },
    tiktok: {
      uri: "android-app://com.zhiliaoapp.musically",
      action: "android.intent.action.MAIN",
      packageName: "com.zhiliaoapp.musically",
      flags: ["FLAG_ACTIVITY_CLEAR_TOP", "FLAG_ACTIVITY_SINGLE_TOP"],
    },
    facebook: {
      uri: "android-app://com.facebook.katana",
      action: "android.intent.action.MAIN",
      packageName: "com.facebook.katana",
      flags: ["FLAG_ACTIVITY_CLEAR_TOP", "FLAG_ACTIVITY_SINGLE_TOP"],
    },
    twitter: {
      uri: "android-app://com.twitter.android",
      action: "android.intent.action.MAIN",
      packageName: "com.twitter.android",
      flags: ["FLAG_ACTIVITY_CLEAR_TOP", "FLAG_ACTIVITY_SINGLE_TOP"],
    },
  };

  /**
   * Ensure the target app is on its home/feed screen before plan execution.
   *
   * Strategy (3 phases):
   *   Phase 1: force-stop app (clean slate)
   *   Phase 2: launch with explicit intent (MainTabActivity → feed, not Reels)
   *   Phase 3: back x3 to dismiss overlays + tap home tab as safety net
   */
  private async ensureAppHomeScreen(deviceId: string, platform: string): Promise<boolean> {
    const pkg = AgentOrchestrator.PLATFORM_PACKAGES[platform];
    if (!pkg) {
      console.warn(`[orchestrator] Unknown platform "${platform}" — skipping preamble`);
      return true;
    }

    // Phase 0: wake screen + unlock — devices sleep between tasks
    console.log(`[orchestrator] Preamble P0: screen_wake + unlock`);
    const wakeId = uuidv4();
    const wakeP = awaitAction(wakeId, 5_000);
    wsServer.sendJob(deviceId, {
      jobId: wakeId,
      type: "screen_wake" as import("../../../../shared/protocol/messages").JobType,
      params: {} as Record<string, unknown>,
      timeoutMs: 5_000,
    });
    await wakeP;

    const unlockId = uuidv4();
    const unlockP = awaitAction(unlockId, 5_000);
    wsServer.sendJob(deviceId, {
      jobId: unlockId,
      type: "unlock" as import("../../../../shared/protocol/messages").JobType,
      params: {} as Record<string, unknown>,
      timeoutMs: 5_000,
    });
    await unlockP;
    console.log(`[orchestrator] Preamble P0: wake+unlock done`);
    await sleep(500);

    // Phase 1: force-stop + fresh launch via open_app_fresh
    // This guarantees main activity (feed), not last-viewed (Reels/Stories)
    console.log(`[orchestrator] Preamble P1: open_app_fresh ${pkg}`);
    const freshId = uuidv4();
    const freshP = awaitAction(freshId, 10_000);
    wsServer.sendJob(deviceId, {
      jobId: freshId,
      type: "open_app_fresh" as import("../../../../shared/protocol/messages").JobType,
      params: { packageName: pkg } as Record<string, unknown>,
      timeoutMs: 10_000,
    });
    const freshOk = await freshP;
    console.log(`[orchestrator] Preamble P1: open_app_fresh ${freshOk ? "OK" : "TIMEOUT"}`);

    // Wait for app to fully load (splash → feed)
    await sleep(3500);

    // Phase 2: VLM screen check — identify current screen after open_app_fresh.
    // Instagram may restore last-viewed screen (Reels, Profile, DMs) instead of Home feed.
    // We ask the VLM to classify the screen, then navigate to Home if needed.
    console.log(`[orchestrator] Preamble P2: screenshot + VLM screen identification`);
    const isOnHome = await this.ensureHomeFeedVLM(deviceId, platform);
    console.log(`[orchestrator] Preamble P2: VLM screen check — on Home: ${isOnHome}`);

    if (!isOnHome) {
      // Not on Home feed — press BACK x3 to dismiss overlays/Reels, then tap nav.home
      console.log(`[orchestrator] Preamble P2: not on Home — pressing BACK x3`);
      for (let i = 0; i < 3; i++) {
        const backId = uuidv4();
        const backP = awaitAction(backId, 3_000);
        wsServer.sendJob(deviceId, {
          jobId: backId,
          type: "press_key" as import("../../../../shared/protocol/messages").JobType,
          params: { key: "back" } as Record<string, unknown>,
          timeoutMs: 3_000,
        });
        await backP;
        await sleep(400);
      }

      // Explicit tap on nav.home coordinate (0.1, 0.912)
      console.log(`[orchestrator] Preamble P2: tapping nav.home (0.1, 0.912)`);
      const dims2 = await getScreenDims(deviceId);
      const navId2 = uuidv4();
      const navP2 = awaitAction(navId2, 5_000);
      wsServer.sendJob(deviceId, {
        jobId: navId2,
        type: "tap" as import("../../../../shared/protocol/messages").JobType,
        params: {
          x: Math.round(0.1 * dims2.w),
          y: Math.round(0.912 * dims2.h),
        } as Record<string, unknown>,
        timeoutMs: 5_000,
      });
      await navP2;
      await sleep(1200);

      // Re-verify after navigation
      console.log(`[orchestrator] Preamble P2: re-verify screen after nav.home tap`);
      const isOnHome2 = await this.ensureHomeFeedVLM(deviceId, platform);
      console.log(`[orchestrator] Preamble P2: re-verify — on Home: ${isOnHome2}`);
    }

    // Phase 2.5: keyboard dismiss guard
    // If Instagram was on Reels with comment box open, the software keyboard hides the nav bar.
    // A tap on nav.home coordinates would land in the comment text field instead.
    // We take a fresh screenshot and ask the VLM if a keyboard is currently visible.
    // If yes, send a single BACK key to dismiss it before proceeding to P3.
    console.log(`[orchestrator] Preamble P2.5: checking for visible keyboard before nav tap`);
    try {
      const kbScreenshot = await this.captureScreenshot(deviceId);
      if (kbScreenshot) {
        const llm = getLlmClient();
        const kbResponse = await llm.complete({
          model: agentConfig.planner.model,
          systemPrompt: "",
          userContent: [
            { type: "image", base64: kbScreenshot },
            {
              type: "text",
              text: `Look at this mobile screenshot. Is a software keyboard (on-screen keyboard / virtual keyboard) currently visible on screen? Also check if there is an open comment input box or comment section overlay.

Reply with EXACTLY one word: YES or NO`,
            },
          ],
          temperature: 0.0,
          maxTokens: 5,
        });
        const kbLabel = kbResponse.text.trim().toUpperCase();
        if (kbLabel.includes("YES")) {
          console.log(`[orchestrator] Preamble P2.5: keyboard detected, dismissing...`);
          const kbBackId = uuidv4();
          const kbBackP = awaitAction(kbBackId, 3_000);
          wsServer.sendJob(deviceId, {
            jobId: kbBackId,
            type: "press_key" as import("../../../../shared/protocol/messages").JobType,
            params: { key: "back" } as Record<string, unknown>,
            timeoutMs: 3_000,
          });
          await kbBackP;
          await sleep(600);
          console.log(`[orchestrator] Preamble P2.5: keyboard dismissed ✓`);
        } else {
          console.log(`[orchestrator] Preamble P2.5: no keyboard detected (${kbLabel}), proceeding`);
        }
      } else {
        console.warn(`[orchestrator] Preamble P2.5: no screenshot — skipping keyboard check`);
      }
    } catch (err) {
      console.warn(`[orchestrator] Preamble P2.5: keyboard check error — ${(err as Error).message} — skipping`);
    }

    // Phase 3: coordinate-based tap on nav.home as safety net
    // A11y may fail if Home node is absent from tree on certain sub-pages.
    // Hard tap at (0.1, 0.912) = bottom-left nav.home position.
    // NOTE: y=0.965 was hitting Android nav bar, y=0.912 is correct for Instagram nav
    console.log(`[orchestrator] Preamble P3: coord tap nav.home (0.1, 0.912)`);
    const dims = await getScreenDims(deviceId);
    const navHomeId = uuidv4();
    const navHomeP = awaitAction(navHomeId, 5_000);
    wsServer.sendJob(deviceId, {
      jobId: navHomeId,
      type: "tap" as import("../../../../shared/protocol/messages").JobType,
      params: {
        x: Math.round(0.1 * dims.w),
        y: Math.round(0.912 * dims.h),
      } as Record<string, unknown>,
      timeoutMs: 5_000,
    });
    const navHomeOk = await navHomeP;
    console.log(`[orchestrator] Preamble P3: coord tap ${navHomeOk ? "OK" : "TIMEOUT"}`);
    await sleep(800);

    console.log(`[orchestrator] Preamble: complete ✓`);
    return true;
  }

  /**
   * Uses VLM to identify whether the current screen is the Instagram Home/Feed screen.
   * Takes a screenshot, asks VLM to classify the current screen type.
   * Returns true if on Home feed, false otherwise (Reels, Profile, DMs, Search, etc.)
   */
  private async ensureHomeFeedVLM(deviceId: string, platform: string): Promise<boolean> {
    try {
      const screenshot = await this.captureScreenshot(deviceId);
      if (!screenshot) {
        console.warn(`[orchestrator] ensureHomeFeedVLM: no screenshot — assuming Home`);
        return true; // fail-open: assume home, let task proceed
      }

      const llm = getLlmClient();
      const response = await llm.complete({
        model: agentConfig.planner.model,
        systemPrompt: "",
        userContent: [
          { type: "image", base64: screenshot },
          {
            type: "text",
            text: `You are a mobile UI classifier for ${platform} automation.

Look at this screenshot and identify the current screen.

Reply with EXACTLY ONE of these labels (no other text):
- HOME_FEED
- REELS
- PROFILE
- DMS
- SEARCH
- STORIES
- POST_DETAIL
- OTHER

Rules:
- HOME_FEED: vertical scrollable feed of posts from followed accounts, nav bar visible at bottom with Home tab highlighted
- REELS: fullscreen vertical video player (nav bar hidden or partially visible)
- PROFILE: profile page showing bio, stats, grid of posts
- DMS: direct messages inbox or conversation
- SEARCH: search/explore page
- STORIES: fullscreen story viewer
- POST_DETAIL: single post expanded view
- OTHER: anything else

Respond with ONLY the label, nothing else.`,
          },
        ],
        temperature: 0.0,
        maxTokens: 20,
      });

      const label = response.text.trim().toUpperCase();
      console.log(`[orchestrator] ensureHomeFeedVLM: VLM classified screen as "${label}"`);
      return label === "HOME_FEED";
    } catch (err) {
      console.warn(`[orchestrator] ensureHomeFeedVLM: VLM error — ${(err as Error).message} — assuming Home`);
      return true; // fail-open
    }
  }

  // ─── Cache invalidation ──────────────────────────────────────────────────────

  /**
   * Invalidate coords for an element across BOTH cache layers:
   *   L1: skill file on disk (confidence → 0.1)
   *   L1.5: coordinate_cache DB (confidence → 0.1)
   *
   * Next cascade call skips L1 + L1.5 (conf < 0.7), falls through to L2 (a11y) → L3 (VLM).
   * On L2/L3 success: auto-learn writes correct coords back with conf=0.95.
   */
  private async invalidateElementCoords(platform: string, elementName: string): Promise<void> {
    console.log(`[orchestrator] Invalidating coords for ${platform}:${elementName} (L1 + L1.5)`);

    // L1: Update skill file on disk
    try {
      const skill = await skillService.loadSkillFile(platform);
      if (skill) {
        const element = skillService.getElement(skill, elementName);
        if (element && element.type !== "variable") {
          (element as { confidence?: number }).confidence = 0.1;
          skill.updated_at = new Date();
          await skillService.saveSkillFile(platform, skill);
          console.log(`[orchestrator] L1 skill file: ${elementName} confidence → 0.1`);
        }
      }
    } catch (err) {
      console.warn(`[orchestrator] L1 invalidation failed: ${(err as Error).message}`);
    }

    // L1.5: Update DB cache
    try {
      const db = getDb();
      const result = await db.query(
        `UPDATE coordinate_cache
         SET confidence = 0.1, fail_count = fail_count + 1
         WHERE element_name = $1
         RETURNING id, resolution`,
        [elementName],
      );
      console.log(`[orchestrator] L1.5 DB cache: ${result.rowCount} rows invalidated for ${elementName}`);
    } catch (err) {
      console.warn(`[orchestrator] L1.5 invalidation failed: ${(err as Error).message}`);
    }
  }

  // ─── Device helpers ─────────────────────────────────────────────────────────

  private async captureScreenshot(deviceId: string): Promise<string | null> {
    if (!wsServer.isDeviceConnected(deviceId)) {
      console.warn(`[orchestrator] captureScreenshot: device ${deviceId.slice(0, 8)} not connected`);
      return null;
    }

    const jobId = uuidv4();
    const timeoutMs = agentConfig.orchestrator.screenshotTimeoutMs;

    const promise = awaitScreenshot(jobId, timeoutMs);

    const sent = wsServer.sendJob(deviceId, {
      jobId,
      type: "screenshot" as import("../../../../shared/protocol/messages").JobType,
      params: { quality: 70, maxWidth: 1080 } as Record<string, unknown>,
      timeoutMs,
    });

    if (!sent) {
      console.warn(`[orchestrator] captureScreenshot: sendJob failed for ${deviceId.slice(0, 8)}`);
      // Clean up pending
      pendingScreenshots.delete(jobId);
      return null;
    }

    console.log(`[orchestrator] captureScreenshot: sent jobId=${jobId.slice(0, 8)}, awaiting ${timeoutMs}ms...`);
    const result = await promise;
    if (!result) {
      console.warn(`[orchestrator] captureScreenshot: timeout or null result for jobId=${jobId.slice(0, 8)}`);
    } else {
      console.log(`[orchestrator] captureScreenshot: got ${(result.length / 1024).toFixed(0)}KB image`);
    }
    return result;
  }

  private async performAction(deviceId: string, execOutput: ExecutorOutput): Promise<void> {
    const { action } = execOutput;
    const jobId = uuidv4();

    let jobType: string;
    let params: Record<string, unknown> = {};

    switch (action.type) {
      case "tap": {
        // A2: convert normalized coords (0-1) to pixels
        const dims = await getScreenDims(deviceId);
        jobType = "tap";
        params = {
          x: Math.round((action.x ?? 0.5) * dims.w),
          y: Math.round((action.y ?? 0.5) * dims.h),
        };
        break;
      }
      case "swipe": {
        const dims = await getScreenDims(deviceId);
        jobType = "swipe";
        params = {
          startX: Math.round((action.startX ?? 0.5) * dims.w),
          startY: Math.round((action.startY ?? 0.7) * dims.h),
          endX: Math.round((action.endX ?? 0.5) * dims.w),
          endY: Math.round((action.endY ?? 0.3) * dims.h),
          durationMs: 300,
        };
        break;
      }
      case "scroll": {
        const dims = await getScreenDims(deviceId);
        jobType = "swipe";
        const dir = action.direction || "down";
        // US-001: scroll coordinates kept away from text input regions.
        // "down" endY 0.25 (was 0.3) — stops before search bar area.
        // "up" startY 0.25 (was 0.3) — starts below search bar area.
        // Both directions stay within y: 0.25–0.75, clear of search bar (y≈0.07) and nav bar (y≈0.912).
        const scrollMap: Record<string, Record<string, number>> = {
          down:  { startX: 0.5, startY: 0.7, endX: 0.5, endY: 0.25 },
          up:    { startX: 0.5, startY: 0.25, endX: 0.5, endY: 0.7 },
          left:  { startX: 0.7, startY: 0.5, endX: 0.3, endY: 0.5 },
          right: { startX: 0.3, startY: 0.5, endX: 0.7, endY: 0.5 },
        };
        const sm = scrollMap[dir];
        params = {
          startX: Math.round(sm.startX * dims.w),
          startY: Math.round(sm.startY * dims.h),
          endX: Math.round(sm.endX * dims.w),
          endY: Math.round(sm.endY * dims.h),
          durationMs: 300,
        };
        break;
      }
      case "type":
        jobType = "type_text";
        params = { text: action.text ?? "" };
        break;
      case "back":
        jobType = "press_key";
        params = { key: "back" };
        break;
      case "wait":
        await sleep(action.ms ?? 1000);
        return;
      case "skip":
        return;
      default:
        console.warn(`[orchestrator] Unknown action type: ${(action as { type: string }).type}`);
        return;
    }

    const promise = awaitAction(jobId, agentConfig.orchestrator.stepTimeoutMs);

    const sent = wsServer.sendJob(deviceId, {
      jobId,
      type: jobType as import("../../../../shared/protocol/messages").JobType,
      params: params as Record<string, unknown>,
      timeoutMs: agentConfig.orchestrator.stepTimeoutMs,
    });

    if (!sent) return;
    await promise;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const agentOrchestrator = new AgentOrchestrator();
