/**
 * task-runner/task-runner.service.ts
 * Task Runner — Polls tasks from DB, executes via orchestrator
 * 
 * Lifecycle:
 *   queued → running → completed/failed
 * 
 * Features:
 *   - Poll interval configurabil (default 30s)
 *   - Device lock (1 task per device simultan)
 *   - Rate limit respectat (min gap între tasks pe device)
 *   - Auto-retry cu backoff
 */

import { getDb } from "../../db/client";
import { agentOrchestrator } from "../agents/orchestrator";
import { isDeviceOnline } from "../../transport/transport";
import type { TaskResult } from "../agents/types";
import {
  generatedWorkflowCacheLookups,
  generatedWorkflowExecutions,
  generatedWorkflowLlmAvoided,
  generatedWorkflowTaskRunnerDispatches,
} from "../observability/metrics";
import { dispatchGeneratedWorkflowTemplate } from "../workflows/generated-workflow-execution.service";
import type { GeneratedWorkflowControlPlaneContext } from "../workflows/generated-workflow-execution.service";
import {
  workflowService,
  type GeneratedWorkflowPlanCacheRecord,
} from "../workflows/workflow.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  account_id: string;
  device_id: string;
  routine: string;
  params: Record<string, unknown>;
  scheduled_time: Date;
  status: string;
  started_at?: Date;
  completed_at?: Date;
  retry_count?: number;
  updated_at?: Date;
}

export interface TaskRunnerConfig {
  pollIntervalMs: number;
  minGapBetweenTasksMs: number;
  batchSize: number;
  maxRetries: number;
  retryBackoffMs: number;
}

interface TaskRunnerResult extends TaskResult {
  generatedWorkflow?: {
    workflowId?: string;
    status?: "queued" | "running";
    mode?: "edge" | "server";
    templateId?: string;
    cacheKey?: string;
    requestKey?: string | null;
    canonicalWorkflowId?: string;
    canonicalWorkflowVersion?: string;
    compiledPlanHash?: string;
    llmBudget?: GeneratedWorkflowPlanCacheRecord["compiledPlan"]["llmBudget"];
    controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
    failureCode?: string;
  };
}

const DEFAULT_CONFIG: TaskRunnerConfig = {
  pollIntervalMs: 30_000,           // 30 seconds
  minGapBetweenTasksMs: 60_000,     // 1 minute gap between tasks on same device
  batchSize: 10,
  maxRetries: 3,                    // 3 retries: 5s, 15s, 45s (exponential backoff)
  retryBackoffMs: 5_000,            // Base backoff: 5 * 3^retry_count seconds
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_WORKFLOW_ROUTINE = "generated_workflow";

function zeroTokenUsage(): TaskResult["tokenUsage"] {
  return {
    planner: { input: 0, output: 0 },
    executor: { input: 0, output: 0, calls: 0 },
    verifier: { input: 0, output: 0, calls: 0 },
    total: 0,
  };
}

function generatedWorkflowTaskSource(cacheKey?: string, requestKey?: string): "cache_key" | "request_key" {
  return cacheKey ? "cache_key" : requestKey ? "request_key" : "request_key";
}

function generatedWorkflowTaskCacheResult(cacheKey?: string, requestKey?: string): "cache_hit" | "canonical_hit" {
  return requestKey && !cacheKey ? "canonical_hit" : "cache_hit";
}

function generatedWorkflowTaskFailure(
  code: string,
  reason: string,
  startedAt: number,
  cached?: GeneratedWorkflowPlanCacheRecord | null,
): TaskRunnerResult {
  return {
    success: false,
    stepsCompleted: 0,
    totalSteps: cached?.workflow.steps.length ?? 0,
    failReason: `${code}: ${reason}`,
    tokenUsage: zeroTokenUsage(),
    durationMs: Date.now() - startedAt,
    generatedWorkflow: {
      failureCode: code,
      cacheKey: cached?.cacheKey,
      requestKey: cached?.requestKey,
      canonicalWorkflowId: cached?.canonicalWorkflowId,
      canonicalWorkflowVersion: cached?.canonicalWorkflowVersion,
      compiledPlanHash: cached?.compiledPlanHash,
      llmBudget: cached?.compiledPlan.llmBudget,
    },
  };
}

// ─── Task Runner State ────────────────────────────────────────────────────────

// Device locks: deviceId → true if busy
const deviceLocks = new Map<string, boolean>();

// Last task completion time per device (for rate limiting)
const deviceLastTaskTime = new Map<string, number>();

// Runner state
let isRunning = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let config: TaskRunnerConfig = { ...DEFAULT_CONFIG };

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * Start the task runner with optional config overrides.
 */
export function startTaskRunner(overrides: Partial<TaskRunnerConfig> = {}): void {
  if (isRunning) {
    console.log("[task-runner] Already running");
    return;
  }
  
  config = { ...DEFAULT_CONFIG, ...overrides };
  isRunning = true;
  
  console.log(`[task-runner] Starting (poll=${config.pollIntervalMs}ms, gap=${config.minGapBetweenTasksMs}ms)`);
  
  // Run immediately, then on interval
  runPollCycle().catch(err => console.error("[task-runner] Initial poll error:", err));
  
  pollInterval = setInterval(() => {
    runPollCycle().catch(err => console.error("[task-runner] Poll error:", err));
  }, config.pollIntervalMs);
}

/**
 * Stop the task runner.
 */
export function stopTaskRunner(): void {
  if (!isRunning) {
    console.log("[task-runner] Not running");
    return;
  }
  
  isRunning = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  
  console.log("[task-runner] Stopped");
}

/**
 * Get runner status.
 */
export function getTaskRunnerStatus(): {
  running: boolean;
  config: TaskRunnerConfig;
  lockedDevices: string[];
  deviceGaps: Record<string, number>;
} {
  const now = Date.now();
  const deviceGaps: Record<string, number> = {};
  
  for (const [deviceId, lastTime] of deviceLastTaskTime) {
    const elapsed = now - lastTime;
    const remaining = Math.max(0, config.minGapBetweenTasksMs - elapsed);
    if (remaining > 0) {
      deviceGaps[deviceId] = remaining;
    }
  }
  
  return {
    running: isRunning,
    config,
    lockedDevices: Array.from(deviceLocks.entries())
      .filter(([_, locked]) => locked)
      .map(([id]) => id),
    deviceGaps,
  };
}

// ─── Poll Cycle ───────────────────────────────────────────────────────────────

async function runPollCycle(): Promise<void> {
  if (!isRunning) return;
  
  const db = getDb();
  
  // Fetch queued tasks + failed tasks eligible for retry
  // Exponential backoff: 5 * 3^retry_count seconds (5s, 15s, 45s)
  const result = await db.query<TaskRow>(`
    SELECT id, account_id, device_id, routine, params, scheduled_time, status, retry_count, updated_at
    FROM tasks
    WHERE 
      (status = 'queued' AND scheduled_time <= NOW())
      OR (
        status = 'failed' 
        AND COALESCE(retry_count, 0) < $2
        AND updated_at < NOW() - (INTERVAL '1 second' * (5 * POWER(3, COALESCE(retry_count, 0))))
      )
    ORDER BY 
      CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
      scheduled_time ASC
    LIMIT $1
  `, [config.batchSize, config.maxRetries]);
  
  if (result.rows.length === 0) {
    return; // Nothing to do
  }
  
  const queuedCount = result.rows.filter(t => t.status === 'queued').length;
  const retryCount = result.rows.filter(t => t.status === 'failed').length;
  console.log(`[task-runner] Found ${queuedCount} queued + ${retryCount} retry-eligible tasks`);
  
  // Process each task (respecting device locks)
  for (const task of result.rows) {
    if (!isRunning) break;
    
    // Skip if device is locked (another task running)
    if (deviceLocks.get(task.device_id)) {
      console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device ${task.device_id.slice(0, 8)} busy`);
      continue;
    }
    
    // Skip if device rate limited (min gap not elapsed)
    const lastTaskTime = deviceLastTaskTime.get(task.device_id);
    if (lastTaskTime) {
      const elapsed = Date.now() - lastTaskTime;
      if (elapsed < config.minGapBetweenTasksMs) {
        console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device rate limited (${Math.ceil((config.minGapBetweenTasksMs - elapsed) / 1000)}s remaining)`);
        continue;
      }
    }
    
    // Skip if device is offline
    if (!isDeviceOnline(task.device_id)) {
      console.log(`[task-runner] Skipping task ${task.id.slice(0, 8)} — device ${task.device_id.slice(0, 8)} offline`);
      continue;
    }
    
    // Execute task (don't await — parallel execution per device)
    executeTask(task).catch(err => {
      console.error(`[task-runner] Task ${task.id.slice(0, 8)} error:`, err);
    });
  }
}

// ─── Task Execution ───────────────────────────────────────────────────────────

async function executeTask(task: TaskRow): Promise<void> {
  const db = getDb();
  const taskId = task.id;
  const deviceId = task.device_id;
  
  // Lock device
  deviceLocks.set(deviceId, true);
  
  try {
    // Update status to running
    await db.query(`
      UPDATE tasks SET status = 'running', started_at = NOW()
      WHERE id = $1
    `, [taskId]);
    
    console.log(`[task-runner] Executing task ${taskId.slice(0, 8)} (${task.routine}) on device ${deviceId.slice(0, 8)}`);
    
    // Get account platform
    const accountResult = await db.query<{ platform: string; client_id: string | null }>(
      "SELECT platform, client_id FROM accounts WHERE id = $1",
      [task.account_id]
    );
    const platform = accountResult.rows[0]?.platform || "instagram";
    const accountClientId = accountResult.rows[0]?.client_id ?? null;
    
    // Route by task type
    let result: TaskRunnerResult;
    
    switch (task.routine) {
      case "generated_workflow":
        result = await executeGeneratedWorkflowTask(task, platform, accountClientId);
        break;
      case "engage_session":
        result = await executeEngageSession(task, platform);
        break;
      case "engage_feed":
        result = await executeEngageFeed(task, platform);
        break;
      case "follow_users":
        result = await executeFollowUsers(task, platform);
        break;
      case "post_photo":
      case "post_reel":
      case "post_story":
        result = await executePost(task, platform);
        break;
      default:
        // Generic orchestrator execution
        result = await executeGenericTask(task, platform);
    }
    
    // Prepare result JSON
    const resultJson = {
      stepsCompleted: result.stepsCompleted,
      totalSteps: result.totalSteps,
      tokenUsage: result.tokenUsage,
      durationMs: result.durationMs,
      failedStep: result.failedStep,
      generatedWorkflow: result.generatedWorkflow,
    };
    
    // Update task status
    if (result.success) {
      await db.query(`
        UPDATE tasks 
        SET status = 'completed', completed_at = NOW(), result = $2
        WHERE id = $1
      `, [taskId, JSON.stringify(resultJson)]);
      
      console.log(`[task-runner] Task ${taskId.slice(0, 8)} completed ✓ (${result.stepsCompleted}/${result.totalSteps} steps)`);
    } else {
      const currentRetryCount = task.retry_count ?? 0;
      const newRetryCount = currentRetryCount + 1;
      
      await db.query(`
        UPDATE tasks 
        SET status = 'failed', 
            completed_at = NOW(), 
            updated_at = NOW(),
            result = $2, 
            error = $3,
            retry_count = $4
        WHERE id = $1
      `, [taskId, JSON.stringify(resultJson), result.failReason || "Unknown error", newRetryCount]);
      
      // Also log to execution_logs for detailed debugging
      await db.query(`
        INSERT INTO execution_logs (task_id, device_id, log_data)
        VALUES ($1, $2, $3)
      `, [taskId, deviceId, JSON.stringify({
        error: result.failReason,
        failedStep: result.failedStep,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
        tokenUsage: result.tokenUsage,
        durationMs: result.durationMs,
        retryCount: newRetryCount,
      })]);
      
      if (newRetryCount < config.maxRetries) {
        const nextRetryDelay = 5 * Math.pow(3, newRetryCount);
        console.error(`[task-runner] Task ${taskId.slice(0, 8)} failed (retry ${newRetryCount}/${config.maxRetries}, next in ${nextRetryDelay}s): ${result.failReason}`);
      } else {
        console.error(`[task-runner] Task ${taskId.slice(0, 8)} failed permanently (${newRetryCount} retries exhausted): ${result.failReason}`);
      }
    }
    
  } catch (err) {
    // Mark as failed on exception, increment retry_count
    const currentRetryCount = task.retry_count ?? 0;
    const newRetryCount = currentRetryCount + 1;
    
    await db.query(`
      UPDATE tasks 
      SET status = 'failed', 
          completed_at = NOW(), 
          updated_at = NOW(),
          error = $2,
          retry_count = $3
      WHERE id = $1
    `, [taskId, (err as Error).message, newRetryCount]);
    
    await db.query(`
      INSERT INTO execution_logs (task_id, device_id, log_data)
      VALUES ($1, $2, $3)
    `, [taskId, deviceId, JSON.stringify({
      error: (err as Error).message,
      stack: (err as Error).stack,
      retryCount: newRetryCount,
    })]);
    
    if (newRetryCount < config.maxRetries) {
      const nextRetryDelay = 5 * Math.pow(3, newRetryCount);
      console.error(`[task-runner] Task ${taskId.slice(0, 8)} exception (retry ${newRetryCount}/${config.maxRetries}, next in ${nextRetryDelay}s):`, err);
    } else {
      console.error(`[task-runner] Task ${taskId.slice(0, 8)} exception (${newRetryCount} retries exhausted):`, err);
    }
    
  } finally {
    // Unlock device & update last task time
    deviceLocks.set(deviceId, false);
    deviceLastTaskTime.set(deviceId, Date.now());
  }
}

// ─── Task Type Handlers ───────────────────────────────────────────────────────

/**
 * engage_session: Combined session with likes, comments, follows
 * Uses params.actions and params.duration_minutes
 */
async function executeEngageSession(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    session_index: number;
    total_sessions: number;
    duration_minutes: number;
    actions: { likes: number; comments: number; follows?: number };
    target: string;
  };
  
  const { actions, duration_minutes, target } = params;
  
  // Build task description for orchestrator
  const parts: string[] = [];
  
  if (actions.likes > 0) {
    parts.push(`like ${actions.likes} posts`);
  }
  if (actions.comments > 0) {
    parts.push(`comment on ${actions.comments} posts`);
  }
  if (actions.follows && actions.follows > 0) {
    parts.push(`follow ${actions.follows} users`);
  }
  
  const targetDesc = target.startsWith("hashtag:")
    ? `from ${target.replace("hashtag:", "#")}`
    : `from ${target}`;
  
  const taskDescription = `Open Instagram, browse ${targetDesc}, and ${parts.join(", ")}. Take about ${duration_minutes} minutes with natural pauses.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * engage_feed: Legacy engagement task
 */
async function executeEngageFeed(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    actions: { likes: number; comments: number };
    target: string;
    duration_minutes: number;
  };
  
  const taskDescription = `Open Instagram, go to ${params.target}, and like ${params.actions.likes} posts and comment on ${params.actions.comments} posts over ${params.duration_minutes} minutes.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * follow_users: Follow task
 */
async function executeFollowUsers(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    count: number;
    target: string;
    unfollow_after_days?: number;
  };
  
  const taskDescription = `Open Instagram, explore ${params.target}, and follow ${params.count} interesting users who might follow back.`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * post_photo/post_reel/post_story: Posting tasks
 */
async function executePost(task: TaskRow, platform: string): Promise<TaskResult> {
  const params = task.params as {
    post_id: string;
    material_url: string;
    caption: string;
    hashtags: string[];
  };
  
  const postType = task.routine.replace("post_", "");
  const fullCaption = params.caption + (params.hashtags.length > 0 ? "\n\n" + params.hashtags.join(" ") : "");
  
  const taskDescription = `Open Instagram, create a new ${postType} using the image/video at ${params.material_url}, and post it with caption: "${fullCaption}"`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

/**
 * generated_workflow: Dispatch a cached generated workflow by canonical requestKey or cacheKey.
 * The task payload is a pointer only; workflow bodies are rejected to keep execution deterministic.
 */
async function executeGeneratedWorkflowTask(
  task: TaskRow,
  platform: string,
  accountClientId?: string | null,
): Promise<TaskRunnerResult> {
  const startedAt = Date.now();
  const routine = GENERATED_WORKFLOW_ROUTINE;
  const params = (task.params ?? {}) as {
    cacheKey?: unknown;
    requestKey?: unknown;
    deviceId?: unknown;
    clientId?: unknown;
    campaignId?: unknown;
    workflow?: unknown;
    variables?: unknown;
  };

  if (Object.prototype.hasOwnProperty.call(params, "workflow")) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "WORKFLOW_PAYLOAD_NOT_ALLOWED",
      "generated_workflow tasks must use cacheKey or requestKey only",
      startedAt,
    );
  }

  const cacheKey = typeof params.cacheKey === "string" ? params.cacheKey : undefined;
  const requestKey = typeof params.requestKey === "string" ? params.requestKey : undefined;
  const taskParamDeviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
  const clientId = accountClientId ?? (typeof params.clientId === "string" ? params.clientId : undefined);
  const campaignId = typeof params.campaignId === "string" ? params.campaignId : undefined;
  const source = generatedWorkflowTaskSource(cacheKey, requestKey);

  if (!cacheKey && !requestKey) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_KEY_REQUIRED",
      "cacheKey or requestKey is required",
      startedAt,
    );
  }

  if (cacheKey && requestKey) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, "unknown", "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_EXACTLY_ONE_KEY_REQUIRED",
      "generated_workflow tasks must use exactly one of cacheKey or requestKey",
      startedAt,
    );
  }

  if (cacheKey && !/^[a-f0-9]{24}$/.test(cacheKey)) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure("INVALID_CACHE_KEY", "cacheKey must be a 24-character lowercase hex string", startedAt);
  }

  if (requestKey && !/^[a-f0-9]{24}$/.test(requestKey)) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure("INVALID_REQUEST_KEY", "requestKey must be a 24-character lowercase hex string", startedAt);
  }

  if (!UUID_RE.test(task.device_id) || (taskParamDeviceId && !UUID_RE.test(taskParamDeviceId))) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "DEVICE_ID_INVALID_OR_AMBIGUOUS",
      "generated_workflow tasks require a full task device UUID",
      startedAt,
    );
  }

  if (taskParamDeviceId && taskParamDeviceId !== task.device_id) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "DEVICE_ID_MISMATCH",
      "params.deviceId must match the task device_id",
      startedAt,
    );
  }

  const cached = cacheKey
    ? await workflowService.getGeneratedPlanCache(cacheKey)
    : await workflowService.getGeneratedPlanCacheByRequestKey(requestKey!);

  if (!cached) {
    generatedWorkflowCacheLookups?.labels("task_runner", "miss").inc();
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "miss").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_CACHE_MISS",
      "canonical generated workflow artifact not found",
      startedAt,
    );
  }

  generatedWorkflowCacheLookups?.labels("task_runner", generatedWorkflowTaskCacheResult(cacheKey, requestKey)).inc();

  if (cached.compiledPlan.llmBudget.happyPathRequests !== 0) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      "GENERATED_WORKFLOW_LLM_BUDGET_NOT_CACHE_SAFE",
      "compiled plan happy path must not require LLM calls",
      startedAt,
      cached,
    );
  }

  try {
    const suppliedVariables = params.variables && typeof params.variables === "object" && !Array.isArray(params.variables)
      ? params.variables as Record<string, unknown>
      : undefined;
    const variables: Record<string, unknown> = {
      ...(suppliedVariables ?? {}),
      taskId: task.id,
      generatedWorkflow: true,
      generatedWorkflowId: cached.workflow.id,
      generatedWorkflowCacheKey: cached.cacheKey,
      generatedWorkflowRequestKey: cached.requestKey,
      canonicalWorkflowId: cached.canonicalWorkflowId,
      canonicalWorkflowVersion: cached.canonicalWorkflowVersion,
      compiledPlanHash: cached.compiledPlanHash,
    };
    const controlPlaneContext: GeneratedWorkflowControlPlaneContext = {
      source: "task_runner",
      routine,
      taskId: task.id,
      accountId: task.account_id,
      deviceId: task.device_id,
      platform,
      ...(clientId ? { clientId } : {}),
      ...(campaignId ? { campaignId } : {}),
    };
    const dispatch = await dispatchGeneratedWorkflowTemplate({
      templateId: cached.workflow.id,
      template: cached.workflow,
      deviceId: task.device_id,
      accountId: task.account_id,
      variables,
      controlPlaneContext,
      logPrefix: "task-runner",
    });
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "accepted").inc();
    generatedWorkflowExecutions?.labels(cached.platform, "true", `task_runner_${source}`).inc();
    generatedWorkflowLlmAvoided?.labels(cached.platform, "task_runner_cache_hit").inc();

    return {
      success: true,
      stepsCompleted: cached.workflow.steps.length,
      totalSteps: cached.workflow.steps.length,
      tokenUsage: zeroTokenUsage(),
      durationMs: Date.now() - startedAt,
      generatedWorkflow: {
        workflowId: dispatch.workflowId,
        status: dispatch.status,
        mode: dispatch.mode,
        templateId: dispatch.templateId,
        cacheKey: cached.cacheKey,
        requestKey: cached.requestKey,
        canonicalWorkflowId: cached.canonicalWorkflowId,
        canonicalWorkflowVersion: cached.canonicalWorkflowVersion,
        compiledPlanHash: cached.compiledPlanHash,
        llmBudget: cached.compiledPlan.llmBudget,
        controlPlaneContext,
      },
    };
  } catch (err) {
    generatedWorkflowTaskRunnerDispatches?.labels(routine, source, "dispatch_failed").inc();
    return generatedWorkflowTaskFailure(
      (err as Error & { code?: string }).code ?? "GENERATED_WORKFLOW_DISPATCH_FAILED",
      (err as Error).message,
      startedAt,
      cached,
    );
  }
}

/**
 * Generic task: Pass routine as task description
 */
async function executeGenericTask(task: TaskRow, platform: string): Promise<TaskResult> {
  const taskDescription = `${task.routine}: ${JSON.stringify(task.params)}`;
  
  return agentOrchestrator.executeTask(taskDescription, task.device_id, platform);
}

// ─── Manual Task Execution ────────────────────────────────────────────────────

/**
 * Execute a specific task immediately (bypass queue).
 * Useful for testing or priority execution.
 */
export async function executeTaskNow(taskId: string): Promise<TaskResult | { success: false; error: string }> {
  const db = getDb();
  
  const result = await db.query<TaskRow>(`
    SELECT id, account_id, device_id, routine, params, scheduled_time, status
    FROM tasks
    WHERE id = $1
  `, [taskId]);
  
  if (result.rows.length === 0) {
    return { success: false, error: "Task not found" };
  }
  
  const task = result.rows[0];
  
  if (deviceLocks.get(task.device_id)) {
    return { success: false, error: "Device is busy with another task" };
  }
  
  if (!isDeviceOnline(task.device_id)) {
    return { success: false, error: "Device is offline" };
  }
  
  // Execute synchronously
  const accountResult = await db.query<{ platform: string; client_id: string | null }>(
    "SELECT platform, client_id FROM accounts WHERE id = $1",
    [task.account_id]
  );
  const platform = accountResult.rows[0]?.platform || "instagram";
  const accountClientId = accountResult.rows[0]?.client_id ?? null;
  
  deviceLocks.set(task.device_id, true);
  
  try {
    await db.query(`UPDATE tasks SET status = 'running', started_at = NOW() WHERE id = $1`, [taskId]);
    
    let taskResult: TaskRunnerResult;
    switch (task.routine) {
      case "generated_workflow":
        taskResult = await executeGeneratedWorkflowTask(task, platform, accountClientId);
        break;
      case "engage_session":
        taskResult = await executeEngageSession(task, platform);
        break;
      case "engage_feed":
        taskResult = await executeEngageFeed(task, platform);
        break;
      case "follow_users":
        taskResult = await executeFollowUsers(task, platform);
        break;
      case "post_photo":
      case "post_reel":
      case "post_story":
        taskResult = await executePost(task, platform);
        break;
      default:
        taskResult = await executeGenericTask(task, platform);
    }
    
    const status = taskResult.success ? "completed" : "failed";
    await db.query(
      `UPDATE tasks SET status = $1, completed_at = NOW(), result = $2, error = $3 WHERE id = $4`,
      [
        status,
        JSON.stringify({
          stepsCompleted: taskResult.stepsCompleted,
          totalSteps: taskResult.totalSteps,
          tokenUsage: taskResult.tokenUsage,
          durationMs: taskResult.durationMs,
          failedStep: taskResult.failedStep,
          generatedWorkflow: taskResult.generatedWorkflow,
        }),
        taskResult.success ? null : taskResult.failReason ?? "Unknown error",
        taskId,
      ]
    );
    
    return taskResult;
    
  } finally {
    deviceLocks.set(task.device_id, false);
    deviceLastTaskTime.set(task.device_id, Date.now());
  }
}

// ─── Retry Failed Tasks ───────────────────────────────────────────────────────

/**
 * Reset all failed tasks to queued state for immediate retry.
 * Returns the number of tasks reset.
 */
export async function retryFailedTasks(): Promise<{ resetCount: number }> {
  const db = getDb();
  
  const result = await db.query(`
    UPDATE tasks 
    SET status = 'queued', 
        retry_count = 0,
        error = NULL,
        updated_at = NOW()
    WHERE status = 'failed'
    RETURNING id
  `);
  
  const resetCount = result.rowCount ?? 0;
  
  if (resetCount > 0) {
    console.log(`[task-runner] Reset ${resetCount} failed tasks to queued`);
  }
  
  return { resetCount };
}

/**
 * Get failed tasks count and details.
 */
export async function getFailedTasksStats(): Promise<{
  totalFailed: number;
  retryableCount: number;
  exhaustedCount: number;
}> {
  const db = getDb();
  
  const result = await db.query<{ retry_count: number; count: string }>(`
    SELECT COALESCE(retry_count, 0) as retry_count, COUNT(*) as count
    FROM tasks
    WHERE status = 'failed'
    GROUP BY COALESCE(retry_count, 0)
  `);
  
  let totalFailed = 0;
  let retryableCount = 0;
  let exhaustedCount = 0;
  
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    totalFailed += count;
    
    if (row.retry_count < config.maxRetries) {
      retryableCount += count;
    } else {
      exhaustedCount += count;
    }
  }
  
  return { totalFailed, retryableCount, exhaustedCount };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const taskRunnerService = {
  start: startTaskRunner,
  stop: stopTaskRunner,
  status: getTaskRunnerStatus,
  executeNow: executeTaskNow,
  retryFailed: retryFailedTasks,
  getFailedStats: getFailedTasksStats,
};
