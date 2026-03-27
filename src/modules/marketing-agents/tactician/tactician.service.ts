/**
 * tactician/tactician.service.ts
 * Tactician agent logic (P9)
 * 
 * Spawned by Nautilus at 04:45 (nightly).
 * Creates tasks from approved posts + strategy, sends to Kraken.
 */

import { getDb } from '../../../db/client';
import {
  TacticianConfig,
  DEFAULT_CONFIG,
  ApprovedPost,
  AccountForTasks,
  DeviceStatus,
  TaskDraft,
  TaskType,
  PostTaskPayload,
  EngageTaskPayload,
  FollowTaskPayload,
  SessionTaskPayload,
  TacticianResult,
  ScheduleSlot,
} from './types';

// ─── Session Config Type ──────────────────────────────────────────────────────

interface SessionConfig {
  durationMin: { min: number; max: number };
  pauseBetweenMin: number;
  carryover: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function runTactician(config: Partial<TacticianConfig> = {}): Promise<TacticianResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const db = getDb();
  
  console.log('[Tactician] Starting task scheduling');
  
  try {
    // ─── 1. Get Approved Posts ────────────────────────────────────────────────
    const posts = await getApprovedPosts(db, cfg.lookahead_hours);
    
    // ─── 2. Get Accounts with Strategy ────────────────────────────────────────
    const accounts = await getAccountsForTasks(db);
    
    // ─── 3. Get Device Status ─────────────────────────────────────────────────
    const devices = await getDeviceStatus(db);
    
    // ─── 4. Build Schedule ────────────────────────────────────────────────────
    const schedule = new DeviceSchedule(devices, cfg);
    
    let tasksCreated = 0;
    let postsScheduled = 0;
    let engagementTasks = 0;
    let followTasks = 0;
    let skippedNoDevice = 0;
    let skippedFlagged = 0;
    
    // ─── 5. Schedule Post Tasks ───────────────────────────────────────────────
    for (const post of posts) {
      const account = accounts.find(a => a.id === post.account_id);
      if (!account) continue;
      
      // Check if account is flagged
      if (isAccountFlagged(account)) {
        skippedFlagged++;
        continue;
      }
      
      // Find device
      const deviceId = account.device_id;
      if (!deviceId || !devices.find(d => d.id === deviceId && d.status === 'online')) {
        skippedNoDevice++;
        continue;
      }
      
      // Get slot
      const slot = schedule.getSlot(deviceId, post.scheduled_for, cfg);
      if (!slot) continue;
      
      // Create task
      const task = createPostTask(post, account, deviceId, slot.time, cfg);
      await saveTask(db, task);
      await markPostScheduled(db, post.id);
      
      schedule.markUsed(deviceId, slot.time);
      tasksCreated++;
      postsScheduled++;
    }
    
    // ─── 6. Schedule Engagement Tasks (Session-Based) ──────────────────────────
    for (const account of accounts) {
      if (isAccountFlagged(account)) continue;
      if (!account.device_id) continue;
      
      const device = devices.find(d => d.id === account.device_id);
      if (!device || device.status !== 'online') continue;
      
      const strategy = account.strategy;
      if (!strategy) continue;
      
      // Extract daily limits (supports both old and new format)
      const dailyActions = getDailyActions(strategy);
      
      // Check if we have session config
      const sessionConfig = getSessionConfig(strategy);
      
      // Check if there's any work to do
      const hasEngagement = dailyActions.likes > 0 || dailyActions.comments > 0;
      const hasFollows = dailyActions.follows > 0;
      
      if (!hasEngagement && !hasFollows) continue;
      
      if (sessionConfig) {
        // Session-based scheduling: ONE task per session with ALL actions combined
        const sessions = createCombinedSessionTasks(account, dailyActions, sessionConfig, cfg);
        for (const sessionTask of sessions) {
          const slot = schedule.getSessionSlot(account.device_id!, sessionTask.sessionIndex, sessionConfig, cfg);
          if (slot) {
            sessionTask.task.scheduled_for = slot.time;
            await saveTask(db, sessionTask.task);
            
            // Mark session with its DURATION so next session respects the pause
            const payload = sessionTask.task.payload as SessionTaskPayload;
            schedule.markSessionUsed(account.device_id!, slot.time, payload.duration_minutes);
            tasksCreated++;
            
            // Count what's in the session
            if (payload.actions.likes > 0 || payload.actions.comments > 0) {
              engagementTasks++;
            }
            if (payload.actions.follows && payload.actions.follows > 0) {
              followTasks++;
            }
            
            console.log(`[Tactician] Session ${payload.session_index}/${payload.total_sessions} for ${account.username}: ` +
              `${slot.time.toISOString()} (${payload.duration_minutes} min) - ` +
              `${payload.actions.likes} likes, ${payload.actions.comments} comments, ${payload.actions.follows || 0} follows`);
          }
        }
      } else {
        // Legacy: separate tasks for engagement and follows
        if (hasEngagement) {
          const engageTask = createEngageTask(account, dailyActions, cfg);
          if (engageTask) {
            const slot = schedule.getNextSlot(account.device_id!, cfg);
            if (slot) {
              engageTask.scheduled_for = slot.time;
              await saveTask(db, engageTask);
              schedule.markUsed(account.device_id!, slot.time);
              tasksCreated++;
              engagementTasks++;
            }
          }
        }
        
        if (hasFollows) {
          const followTask = createFollowTask(account, dailyActions, cfg);
          if (followTask) {
            const slot = schedule.getNextSlot(account.device_id!, cfg);
            if (slot) {
              followTask.scheduled_for = slot.time;
              await saveTask(db, followTask);
              schedule.markUsed(account.device_id!, slot.time);
              tasksCreated++;
              followTasks++;
            }
          }
        }
      }
    }
    
    // ─── 7. Publish to Redis ──────────────────────────────────────────────────
    let redisPublished = false;
    if (cfg.redis.enabled && tasksCreated > 0) {
      redisPublished = await publishToRedis(cfg.redis.publish_channel, tasksCreated);
    }
    
    const summary = `Scheduled ${tasksCreated} tasks (${postsScheduled} posts, ${engagementTasks} engage, ${followTasks} follow)`;
    console.log(`[Tactician] Complete: ${summary}`);
    
    return {
      success: true,
      summary,
      tasks_created: tasksCreated,
      posts_scheduled: postsScheduled,
      engagement_tasks: engagementTasks,
      follow_tasks: followTasks,
      skipped_no_device: skippedNoDevice,
      skipped_flagged: skippedFlagged,
      redis_published: redisPublished,
      duration_ms: Date.now() - startTime,
    };
    
  } catch (err) {
    console.error('[Tactician] Error:', err);
    return {
      success: false,
      summary: 'Task scheduling failed',
      tasks_created: 0,
      posts_scheduled: 0,
      engagement_tasks: 0,
      follow_tasks: 0,
      skipped_no_device: 0,
      skipped_flagged: 0,
      redis_published: false,
      duration_ms: Date.now() - startTime,
      error: (err as Error).message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

async function getApprovedPosts(db: any, lookaheadHours: number): Promise<ApprovedPost[]> {
  const result = await db.query(`
    SELECT p.id, p.account_id, p.material_id, p.type, p.caption, p.hashtags, 
           p.scheduled_for, p.status, p.metadata,
           m.url as material_url
    FROM posts p
    LEFT JOIN materials m ON m.id = p.material_id
    WHERE p.status = 'approved'
    AND p.scheduled_for BETWEEN NOW() AND NOW() + INTERVAL '${lookaheadHours} hours'
    ORDER BY p.scheduled_for
  `);
  
  return result.rows;
}

async function getAccountsForTasks(db: any): Promise<AccountForTasks[]> {
  const result = await db.query(`
    SELECT id, username, platform, device_id, type, status, flags, strategy
    FROM accounts
    WHERE status = 'active'
    AND strategy IS NOT NULL
  `);
  
  return result.rows;
}

async function getDeviceStatus(db: any): Promise<DeviceStatus[]> {
  const result = await db.query(`
    SELECT d.id, d.friendly_name, d.status, d.last_seen_at,
           (SELECT COUNT(*) FROM tasks t WHERE t.device_id = d.id AND t.status = 'queued') as current_tasks
    FROM devices d
    WHERE d.status != 'revoked'
  `);
  
  return result.rows.map((row: any) => ({
    ...row,
    current_tasks: parseInt(row.current_tasks) || 0,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULING
// ═══════════════════════════════════════════════════════════════════════════════

class DeviceSchedule {
  private slots: Map<string, Date[]> = new Map();
  private devices: DeviceStatus[];
  
  constructor(devices: DeviceStatus[], cfg: TacticianConfig) {
    this.devices = devices;
    
    // Initialize slots for each device
    for (const device of devices) {
      this.slots.set(device.id, []);
    }
  }
  
  getSlot(deviceId: string, preferredTime: Date, cfg: TacticianConfig): ScheduleSlot | null {
    const usedSlots = this.slots.get(deviceId) || [];
    
    // Check if preferred time is available
    if (this.isSlotAvailable(deviceId, preferredTime, cfg, usedSlots)) {
      return { device_id: deviceId, time: preferredTime, available: true };
    }
    
    // Find nearest available slot
    const nearestTime = this.findNearestSlot(deviceId, preferredTime, cfg, usedSlots);
    if (nearestTime) {
      return { device_id: deviceId, time: nearestTime, available: true };
    }
    
    return null;
  }
  
  getNextSlot(deviceId: string, cfg: TacticianConfig): ScheduleSlot | null {
    const usedSlots = this.slots.get(deviceId) || [];
    const now = new Date();
    
    // Start from now, find first available
    let candidate = new Date(now);
    candidate.setMinutes(candidate.getMinutes() + cfg.scheduling.min_gap_minutes);
    
    for (let i = 0; i < 48; i++) {  // Look up to 24 hours ahead (30 min increments)
      if (this.isSlotAvailable(deviceId, candidate, cfg, usedSlots)) {
        return { device_id: deviceId, time: candidate, available: true };
      }
      candidate = new Date(candidate.getTime() + 30 * 60 * 1000);
    }
    
    return null;
  }
  
  // Track session end times (start + duration) for proper spacing
  private sessionEndTimes: Map<string, Date[]> = new Map();
  
  /**
   * Get slot for a specific session index.
   * Sessions are spaced by pauseBetweenMin AFTER the previous session ENDS.
   * 
   * Example with duration 40min and pause 90min:
   *   Session 1: 15:15 - 15:55 (40 min)
   *   Pause: 15:55 + 90 min = 17:25
   *   Session 2: 17:25 - 18:07 (42 min)
   */
  getSessionSlot(
    deviceId: string, 
    sessionIndex: number, 
    sessionConfig: SessionConfig, 
    cfg: TacticianConfig
  ): ScheduleSlot | null {
    const usedSlots = this.slots.get(deviceId) || [];
    const sessionEnds = this.sessionEndTimes.get(deviceId) || [];
    const now = new Date();
    
    let earliestStart: Date;
    
    if (sessionIndex === 0 || sessionEnds.length === 0) {
      // First session: start ~15 min from now
      earliestStart = new Date(now);
      earliestStart.setMinutes(earliestStart.getMinutes() + 15);
    } else {
      // Subsequent sessions: start after previous session END + pause
      const lastSessionEnd = sessionEnds[sessionEnds.length - 1];
      earliestStart = new Date(lastSessionEnd.getTime() + sessionConfig.pauseBetweenMin * 60 * 1000);
    }
    
    // Find available slot starting from earliestStart
    let candidate = new Date(earliestStart);
    
    for (let offset = 0; offset <= 12; offset++) {
      const tryTime = new Date(candidate.getTime() + offset * 5 * 60 * 1000);  // 5 min increments
      if (this.isSlotAvailable(deviceId, tryTime, cfg, usedSlots)) {
        return { device_id: deviceId, time: tryTime, available: true };
      }
    }
    
    return null;
  }
  
  /**
   * Mark a session as used, including its end time.
   */
  markSessionUsed(deviceId: string, startTime: Date, durationMinutes: number): void {
    // Mark start time as used
    const slots = this.slots.get(deviceId) || [];
    slots.push(startTime);
    this.slots.set(deviceId, slots);
    
    // Track end time for proper spacing
    const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
    const sessionEnds = this.sessionEndTimes.get(deviceId) || [];
    sessionEnds.push(endTime);
    this.sessionEndTimes.set(deviceId, sessionEnds);
  }
  
  markUsed(deviceId: string, time: Date): void {
    const slots = this.slots.get(deviceId) || [];
    slots.push(time);
    this.slots.set(deviceId, slots);
  }
  
  private isSlotAvailable(deviceId: string, time: Date, cfg: TacticianConfig, usedSlots: Date[]): boolean {
    // Check night hours
    if (cfg.scheduling.skip_night_hours) {
      const hour = time.getHours();
      if (hour >= cfg.scheduling.night_start && hour < cfg.scheduling.night_end) {
        return false;
      }
    }
    
    // Check gap from other tasks
    for (const used of usedSlots) {
      const gap = Math.abs(time.getTime() - used.getTime()) / 1000 / 60;
      if (gap < cfg.scheduling.min_gap_minutes) {
        return false;
      }
    }
    
    // Check concurrent limit
    const concurrent = usedSlots.filter(s => 
      Math.abs(time.getTime() - s.getTime()) < 5 * 60 * 1000
    ).length;
    if (concurrent >= cfg.scheduling.max_concurrent_per_device) {
      return false;
    }
    
    return true;
  }
  
  private findNearestSlot(deviceId: string, preferred: Date, cfg: TacticianConfig, usedSlots: Date[]): Date | null {
    // Try slots before and after preferred time
    for (let offset = 1; offset <= 12; offset++) {
      const after = new Date(preferred.getTime() + offset * cfg.scheduling.min_gap_minutes * 60 * 1000);
      if (this.isSlotAvailable(deviceId, after, cfg, usedSlots)) {
        return after;
      }
      
      const before = new Date(preferred.getTime() - offset * cfg.scheduling.min_gap_minutes * 60 * 1000);
      if (before > new Date() && this.isSlotAvailable(deviceId, before, cfg, usedSlots)) {
        return before;
      }
    }
    
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK CREATION
// ═══════════════════════════════════════════════════════════════════════════════

function createPostTask(
  post: ApprovedPost,
  account: AccountForTasks,
  deviceId: string,
  scheduledFor: Date,
  cfg: TacticianConfig
): TaskDraft {
  const taskType: TaskType = post.type === 'reel' ? 'post_reel' 
    : post.type === 'story' ? 'post_story' 
    : 'post_photo';
  
  const payload: PostTaskPayload = {
    post_id: post.id,
    material_url: (post as any).material_url || '',
    caption: post.caption,
    hashtags: post.hashtags || [],
  };
  
  return {
    account_id: account.id,
    device_id: deviceId,
    type: taskType,
    payload,
    scheduled_for: scheduledFor,
    status: 'queued',
    priority: cfg.priorities.post_content,
  };
}

function createEngageTask(
  account: AccountForTasks,
  dailyActions: { likes: number; comments: number; follows: number },
  cfg: TacticianConfig
): TaskDraft | null {
  const { likes, comments } = dailyActions;
  
  if (likes === 0 && comments === 0) return null;
  
  // Get target from strategy if available
  const strategy = account.strategy;
  const target = strategy?.engagement?.target_hashtags?.[0] 
    ? `hashtag:${strategy.engagement.target_hashtags[0]}`
    : 'hashtag:#general';
  
  const payload: EngageTaskPayload = {
    actions: { likes, comments },
    target,
    duration_minutes: 30,
  };
  
  return {
    account_id: account.id,
    device_id: account.device_id!,
    type: 'engage_feed',
    payload,
    scheduled_for: new Date(),  // Will be set by scheduler
    status: 'queued',
    priority: cfg.priorities.engage_feed,
  };
}

function createFollowTask(
  account: AccountForTasks,
  dailyActions: { likes: number; comments: number; follows: number },
  cfg: TacticianConfig
): TaskDraft | null {
  const { follows } = dailyActions;
  
  if (follows === 0) return null;
  
  // Get unfollow config from strategy if available
  const strategy = account.strategy;
  const unfollowAfterDays = strategy?.engagement?.unfollow_after_days || 3;
  
  const payload: FollowTaskPayload = {
    count: follows,
    target: 'explore',
    unfollow_after_days: unfollowAfterDays,
  };
  
  return {
    account_id: account.id,
    device_id: account.device_id!,
    type: 'follow_users',
    payload,
    scheduled_for: new Date(),
    status: 'queued',
    priority: cfg.priorities.follow_unfollow,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract daily action limits from strategy.
 * Supports both formats:
 *   - OLD: strategy.daily_actions.likes
 *   - NEW: strategy.engagement.limits.likes_per_day
 */
function getDailyActions(strategy: any): { likes: number; comments: number; follows: number } {
  // Try new format first (engagement.limits)
  if (strategy?.engagement?.limits) {
    return {
      likes: strategy.engagement.limits.likes_per_day || 0,
      comments: strategy.engagement.limits.comments_per_day || 0,
      follows: strategy.engagement.limits.follows_per_day || 0,
    };
  }
  
  // Fall back to old format (daily_actions)
  if (strategy?.daily_actions) {
    return {
      likes: strategy.daily_actions.likes || 0,
      comments: strategy.daily_actions.comments || 0,
      follows: strategy.daily_actions.follows || 0,
    };
  }
  
  return { likes: 0, comments: 0, follows: 0 };
}

/**
 * Extract session config from strategy.
 * Returns null if no session config (use legacy single-task scheduling).
 * 
 * IMPORTANT: Session parameters are set by Marketer based on account analysis.
 * Tactician only reads them, using conservative defaults as fallback.
 */
function getSessionConfig(strategy: any): SessionConfig | null {
  if (!strategy?.session) return null;
  
  const session = strategy.session;
  if (!session.duration_min) return null;
  
  // Use values from Marketer's strategy, with conservative defaults as fallback
  return {
    durationMin: {
      min: session.duration_min.min ?? 30,   // Conservative default
      max: session.duration_min.max ?? 60,   // Conservative default
    },
    pauseBetweenMin: session.pause_between_min ?? 60,
    carryover: session.carryover !== false,
  };
}

/**
 * Calculate how many sessions fit in a day based on engage_windows and pause time.
 */
function calculateSessionCount(strategy: any, sessionConfig: SessionConfig): number {
  const engageWindows = strategy?.timing?.engage_windows || [];
  if (engageWindows.length === 0) return 2;  // Default: 2 sessions/day
  
  // Calculate total available time
  let totalMinutes = 0;
  for (const window of engageWindows) {
    const [start, end] = window.split('-');
    if (!start || !end) continue;
    const startMin = parseTimeToMinutes(start);
    const endMin = parseTimeToMinutes(end);
    if (endMin > startMin) {
      totalMinutes += endMin - startMin;
    }
  }
  
  // Average session duration + pause
  const avgSessionDuration = (sessionConfig.durationMin.min + sessionConfig.durationMin.max) / 2;
  const sessionWithPause = avgSessionDuration + sessionConfig.pauseBetweenMin;
  
  // How many sessions fit?
  const sessions = Math.floor(totalMinutes / sessionWithPause);
  return Math.max(1, Math.min(sessions, 5));  // 1-5 sessions per day
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Generate random session duration within min-max range.
 */
function randomSessionDuration(config: SessionConfig): number {
  const { min, max } = config.durationMin;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Create combined session tasks with ALL actions (engage + follow) in one session.
 * 
 * ONE session = ONE task that includes:
 * - likes (distributed from daily total)
 * - comments (distributed from daily total)
 * - follows (distributed from daily total)
 * 
 * Duration is set by session config (e.g., 30-45 min).
 * Sessions are spaced by pause_between_min (e.g., 90 min).
 */
function createCombinedSessionTasks(
  account: AccountForTasks,
  dailyActions: { likes: number; comments: number; follows: number },
  sessionConfig: SessionConfig,
  cfg: TacticianConfig
): { task: TaskDraft; sessionIndex: number }[] {
  const strategy = account.strategy;
  const sessionCount = calculateSessionCount(strategy, sessionConfig);
  
  // Distribute ALL actions across sessions
  const likesPerSession = dailyActions.likes > 0 ? Math.ceil(dailyActions.likes / sessionCount) : 0;
  const commentsPerSession = dailyActions.comments > 0 ? Math.ceil(dailyActions.comments / sessionCount) : 0;
  const followsPerSession = dailyActions.follows > 0 ? Math.ceil(dailyActions.follows / sessionCount) : 0;
  
  const target = strategy?.engagement?.target_hashtags?.[0] 
    ? `hashtag:${strategy.engagement.target_hashtags[0]}`
    : 'hashtag:#general';
  
  const tasks: { task: TaskDraft; sessionIndex: number }[] = [];
  
  let remainingLikes = dailyActions.likes;
  let remainingComments = dailyActions.comments;
  let remainingFollows = dailyActions.follows;
  
  for (let i = 0; i < sessionCount; i++) {
    const isLast = i === sessionCount - 1;
    
    // Calculate actions for this session (last session gets remainder)
    const sessionLikes = isLast ? remainingLikes : Math.min(likesPerSession, remainingLikes);
    const sessionComments = isLast ? remainingComments : Math.min(commentsPerSession, remainingComments);
    const sessionFollows = isLast ? remainingFollows : Math.min(followsPerSession, remainingFollows);
    
    remainingLikes -= sessionLikes;
    remainingComments -= sessionComments;
    remainingFollows -= sessionFollows;
    
    // Skip empty sessions
    if (sessionLikes <= 0 && sessionComments <= 0 && sessionFollows <= 0) continue;
    
    const payload: SessionTaskPayload = {
      session_index: i + 1,
      total_sessions: sessionCount,
      duration_minutes: randomSessionDuration(sessionConfig),
      actions: {
        likes: sessionLikes,
        comments: sessionComments,
        follows: sessionFollows,
      },
      target,
    };
    
    tasks.push({
      sessionIndex: i,
      task: {
        account_id: account.id,
        device_id: account.device_id!,
        type: 'engage_session',  // Combined session type
        payload,
        scheduled_for: new Date(),  // Will be set by scheduler
        status: 'queued',
        priority: cfg.priorities.engage_feed,
      },
    });
  }
  
  return tasks;
}

function isAccountFlagged(account: AccountForTasks): boolean {
  const flags = account.flags || {};
  const now = new Date();
  
  if (flags.soft_blocked_until && new Date(flags.soft_blocked_until) > now) {
    return true;
  }
  if (flags.rate_limited_until && new Date(flags.rate_limited_until) > now) {
    return true;
  }
  if (flags.needs_attention) {
    return true;
  }
  
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function saveTask(db: any, task: TaskDraft): Promise<string> {
  const result = await db.query(`
    INSERT INTO tasks (account_id, device_id, routine, params, scheduled_time, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    task.account_id,
    task.device_id,
    task.type,        // type → routine
    JSON.stringify(task.payload),  // payload → params
    task.scheduled_for,  // scheduled_for → scheduled_time
    task.status,
    // priority skipped - column doesn't exist in DB
  ]);
  
  return result.rows[0].id;
}

async function markPostScheduled(db: any, postId: string): Promise<void> {
  await db.query(`
    UPDATE posts SET status = 'scheduled' WHERE id = $1
  `, [postId]);
}

async function publishToRedis(channel: string, taskCount: number): Promise<boolean> {
  try {
    // Redis publish would go here
    // const redis = getRedis();
    // await redis.publish(channel, JSON.stringify({ action: 'new_tasks', count: taskCount }));
    console.log(`[Tactician] Would publish to ${channel}: ${taskCount} new tasks`);
    return true;
  } catch (err) {
    console.error('[Tactician] Redis publish failed:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { TacticianConfig, TacticianResult, TaskDraft };
