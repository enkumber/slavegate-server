/**
 * tactician/types.ts
 * Type definitions for Tactician (P9)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface TacticianConfig {
  timeout_minutes: number;
  lookahead_hours: number;           // Schedule tasks for next X hours
  
  scheduling: {
    min_gap_minutes: number;         // Min gap between tasks on same device
    max_concurrent_per_device: number;
    skip_night_hours: boolean;       // Skip 02:00-06:00
    night_start: number;             // 2 (02:00)
    night_end: number;               // 6 (06:00)
  };
  
  priorities: {
    post_content: number;            // 1 (highest)
    engage_feed: number;             // 2
    story_view: number;              // 3
    follow_unfollow: number;         // 4 (lowest)
  };
  
  redis: {
    publish_channel: string;         // 'kraken.commands'
    enabled: boolean;
  };
}

export const DEFAULT_CONFIG: TacticianConfig = {
  timeout_minutes: 30,
  lookahead_hours: 24,
  
  scheduling: {
    min_gap_minutes: 5,
    max_concurrent_per_device: 2,
    skip_night_hours: true,
    night_start: 2,
    night_end: 6,
  },
  
  priorities: {
    post_content: 1,
    engage_feed: 2,
    story_view: 3,
    follow_unfollow: 4,
  },
  
  redis: {
    publish_channel: 'kraken.commands',
    enabled: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════

export interface ApprovedPost {
  id: string;
  account_id: string;
  material_id: string;
  type: string;
  caption: string;
  hashtags: string[];
  scheduled_for: Date;
  status: string;
  metadata: any;
}

export interface AccountForTasks {
  id: string;
  username: string;
  platform: string;
  device_id: string | null;
  type: 'farming' | 'business';
  status: string;
  flags: AccountFlags;
  strategy: AccountStrategy;
}

export interface AccountFlags {
  rate_limited_until?: string;
  soft_blocked_until?: string;
  needs_attention?: boolean;
}

export interface AccountStrategy {
  // Old format (deprecated)
  daily_actions?: {
    posts?: number;
    stories?: number;
    likes?: number;
    comments?: number;
    follows?: number;
    unfollows?: number;
  };
  
  // New format (from DB)
  engagement?: {
    limits?: {
      likes_per_day?: number;
      comments_per_day?: number;
      follows_per_day?: number;
      unfollows_per_day?: number;
    };
    target_hashtags?: string[];
    unfollow_after_days?: number;
  };
  
  timing?: {
    post_at?: string[];
    engage_windows?: string[];
  };
  
  // Session-based scheduling
  session?: {
    duration_min?: { min: number; max: number };  // Random duration per session
    pause_between_min?: number;                    // Min pause between sessions
    carryover?: boolean;                           // Carry unfinished work
  };
  
  safety?: {
    max_actions_per_hour?: number;
    skip_if_flagged?: boolean;
    human_hours_only?: boolean;
  };
}

export interface DeviceStatus {
  id: string;
  friendly_name: string;
  status: 'online' | 'offline' | 'busy';
  last_seen_at: Date;
  current_tasks: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT — Task
// ═══════════════════════════════════════════════════════════════════════════════

export type TaskType = 
  | 'post_photo' 
  | 'post_reel' 
  | 'post_story' 
  | 'engage_feed'      // Legacy: single engagement task
  | 'engage_session'   // New: session-based engagement
  | 'follow_session'   // New: session-based following
  | 'view_stories'
  | 'follow_users'     // Legacy
  | 'unfollow_users';

export interface TaskDraft {
  account_id: string;
  device_id: string;
  type: TaskType;
  payload: TaskPayload;
  scheduled_for: Date;
  status: 'queued';
  priority: number;
}

export type TaskPayload = 
  | PostTaskPayload 
  | EngageTaskPayload 
  | FollowTaskPayload
  | SessionTaskPayload;

export interface PostTaskPayload {
  post_id: string;
  material_url: string;
  caption: string;
  hashtags: string[];
}

export interface EngageTaskPayload {
  actions: {
    likes: number;
    comments: number;
  };
  target: string;              // e.g., "hashtag:#photography"
  duration_minutes: number;
  comment_templates?: string[];
}

export interface FollowTaskPayload {
  count: number;
  target: string;              // e.g., "followers_of:@influencer"
  unfollow_after_days?: number;
}

export interface SessionTaskPayload {
  session_index: number;       // Which session of the day (1, 2, 3...)
  total_sessions: number;      // Total sessions planned for day
  duration_minutes: number;    // Random duration for this session
  
  // Actions for this session
  actions: {
    likes: number;
    comments: number;
    follows?: number;
  };
  
  target: string;              // e.g., "hashtag:#photography"
  comment_templates?: string[];
  
  // Carryover from previous session (if any)
  carryover?: {
    likes: number;
    comments: number;
    follows?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface TacticianResult {
  success: boolean;
  summary: string;
  tasks_created: number;
  posts_scheduled: number;
  engagement_tasks: number;
  follow_tasks: number;
  skipped_no_device: number;
  skipped_flagged: number;
  redis_published: boolean;
  duration_ms: number;
  error?: string;
}

export interface ScheduleSlot {
  device_id: string;
  time: Date;
  available: boolean;
}
