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
import { wsServer } from "../../ws/ws.server";
import type { TaskResult } from "../agents/types";

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
}

export interface TaskRunnerConfig {
  pollIntervalMs: number;
  minGapBetweenTasksMs: number;
  batchSize: number;
  maxRetries: number;
  retryBackoffMs: number;
}

const DEFAULT_CONFIG: TaskRunnerConfig = {
  pollIntervalMs: 30_000,           // 30 seconds
  minGapBetweenTasksMs: 60_000,     // 1 minute gap between tasks on same device
  batchSize: 10,
  maxRetries: 2,
  retryBackoffMs: 5_000,
};

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
  
  // Fetch queued tasks ready to run
  const result = await db.query<TaskRow>(`
    SELECT id, account_id, device_id, routine, params, scheduled_time, status
    FROM tasks
    WHERE status = 'queued'
    AND scheduled_time <= NOW()
    ORDER BY scheduled_time ASC
    LIMIT $1
  `, [config.batchSize]);
  
  if (result.rows.length === 0) {
    return; // Nothing to do
  }
  
  console.log(`[task-runner] Found ${result.rows.length} queued tasks`);
  
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
    if (!wsServer.isDeviceConnected(task.device_id)) {
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
    const accountResult = await db.query<{ platform: string }>(
      "SELECT platform FROM accounts WHERE id = $1",
      [task.account_id]
    );
    const platform = accountResult.rows[0]?.platform || "instagram";
    
    // Route by task type
    let result: TaskResult;
    
    switch (task.routine) {
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
      await db.query(`
        UPDATE tasks 
        SET status = 'failed', completed_at = NOW(), result = $2, error = $3
        WHERE id = $1
      `, [taskId, JSON.stringify(resultJson), result.failReason || "Unknown error"]);
      
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
      })]);
      
      console.error(`[task-runner] Task ${taskId.slice(0, 8)} failed: ${result.failReason}`);
    }
    
  } catch (err) {
    // Mark as failed on exception
    await db.query(`
      UPDATE tasks SET status = 'failed', completed_at = NOW()
      WHERE id = $1
    `, [taskId]);
    
    await db.query(`
      INSERT INTO execution_logs (task_id, device_id, log_data)
      VALUES ($1, $2, $3)
    `, [taskId, deviceId, JSON.stringify({
      error: (err as Error).message,
      stack: (err as Error).stack,
    })]);
    
    console.error(`[task-runner] Task ${taskId.slice(0, 8)} exception:`, err);
    
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
  
  if (!wsServer.isDeviceConnected(task.device_id)) {
    return { success: false, error: "Device is offline" };
  }
  
  // Execute synchronously
  const accountResult = await db.query<{ platform: string }>(
    "SELECT platform FROM accounts WHERE id = $1",
    [task.account_id]
  );
  const platform = accountResult.rows[0]?.platform || "instagram";
  
  deviceLocks.set(task.device_id, true);
  
  try {
    await db.query(`UPDATE tasks SET status = 'running', started_at = NOW() WHERE id = $1`, [taskId]);
    
    let taskResult: TaskResult;
    switch (task.routine) {
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
    await db.query(`UPDATE tasks SET status = $1, completed_at = NOW() WHERE id = $2`, [status, taskId]);
    
    return taskResult;
    
  } finally {
    deviceLocks.set(task.device_id, false);
    deviceLastTaskTime.set(task.device_id, Date.now());
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const taskRunnerService = {
  start: startTaskRunner,
  stop: stopTaskRunner,
  status: getTaskRunnerStatus,
  executeNow: executeTaskNow,
};
