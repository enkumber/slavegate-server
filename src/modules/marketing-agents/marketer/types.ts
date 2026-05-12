/**
 * marketer/types.ts
 * Type definitions for Marketer v2 (P7)
 * 
 * v2: LLM-based agent with gather→assess→discover→think→plan flow.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketerConfig {
  timeout_minutes: number;
  
  platform_limits: {
    instagram: PlatformLimits;
    tiktok: PlatformLimits;
    default: PlatformLimits;
  };
}

export interface PlatformLimits {
  max_actions_per_hour: number;
  max_posts_per_day: number;
  max_follows_per_day: number;
  max_likes_per_day: number;
  max_comments_per_day: number;
  cooldown_after_warning_hours: number;
}

export const DEFAULT_CONFIG: MarketerConfig = {
  timeout_minutes: 45,
  
  platform_limits: {
    instagram: {
      max_actions_per_hour: 30,
      max_posts_per_day: 3,
      max_follows_per_day: 50,
      max_likes_per_day: 200,
      max_comments_per_day: 50,
      cooldown_after_warning_hours: 4,
    },
    tiktok: {
      max_actions_per_hour: 50,
      max_posts_per_day: 5,
      max_follows_per_day: 100,
      max_likes_per_day: 500,
      max_comments_per_day: 100,
      cooldown_after_warning_hours: 2,
    },
    default: {
      max_actions_per_hour: 20,
      max_posts_per_day: 2,
      max_follows_per_day: 30,
      max_likes_per_day: 100,
      max_comments_per_day: 30,
      cooldown_after_warning_hours: 4,
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT — Client & Account from DB
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClientData {
  id: string;
  name: string;
  status: string;
  strategy: ClientStrategy;
  created_at: Date;
  updated_at: Date;
}

export interface ClientStrategy {
  goal?: string;  // v2: free text, not enum
  tone?: string;
  post_frequency?: 'daily' | 'twice_daily' | 'every_other_day' | 'weekly';
  engagement_target?: 'likes' | 'comments' | 'shares' | 'saves';
  content_types?: ('photos' | 'reels' | 'stories' | 'carousels')[];
  hashtag_strategy?: 'niche' | 'trending' | 'branded' | 'mixed';
  peak_hours?: string[];
  target_audience?: {
    age_range?: string;
    interests?: string[];
    locations?: string[];
    description?: string;  // v2: free text description
  };
  
  session_defaults?: {
    duration_min?: { min: number; max: number };
    pause_between_min?: number;
  };
  
  engagement_limits?: {
    likes_per_day?: number;
    comments_per_day?: number;
    follows_per_day?: number;
  };
  
  competitor_accounts?: string[];
  target_hashtags?: string[];
  
  // v2 additions
  locations?: string[];      // geo-targeting locations
  notes?: string;            // extra info from Dan
}

export interface AccountForStrategy {
  id: string;
  username: string;
  platform: string;
  client_id: string;
  type: 'farming' | 'business';
  status: string;
  metrics: any;
  flags: any;
  strategy: AccountStrategy | null;
  device_id?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT CONTEXT — Full context for LLM (v2)
// ═══════════════════════════════════════════════════════════════════════════════

export interface AccountContext {
  client: {
    name: string;
    goal: string;
    tone: string;
    target_audience: string;
    locations: string[];
    competitors: string[];
    notes: string;
  };
  
  account: {
    id: string;
    username: string;
    platform: string;
    type: 'farming' | 'business';
    followers: number;
    following: number;
    posts: number;
    engagement_rate: number;
    recent_growth: string;
    flags: string[];
    age_days: number;
  };
  
  yesterday: {
    actions_performed: string;
    results: string;
    issues: string;
  };
  
  research: ResearchData;
  
  limits: {
    max_actions_per_hour: number;
    max_posts_per_day: number;
    max_follows_per_day: number;
    max_likes_per_day: number;
    max_comments_per_day: number;
    cooldown_active: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY — Research requests & data (v2)
// ═══════════════════════════════════════════════════════════════════════════════

export interface DiscoveryRequest {
  type: 'hashtag_search' | 'profile_scan' | 'location_posts' | 'follower_scan';
  query: string;
  params: Record<string, unknown>;
}

export interface ResearchData {
  top_hashtags: HashtagData[];
  competitor_activity: string;
  trending_in_location: string;
  audience_online_hours: string;
  [key: string]: unknown;  // extensible for new research types
}

export interface HashtagData {
  name: string;
  posts_count: number | null;
  relevance: string;
}

export interface AssessmentResult {
  needs_research: DiscoveryRequest[];
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY PLAN — LLM output (v2)
// ═══════════════════════════════════════════════════════════════════════════════

export interface DailyPlan {
  analysis: string;
  strategy_today: string;
  sessions: SessionPlan[];
  daily_totals: {
    posts: number;
    stories: number;
    likes: number;
    comments: number;
    follows: number;
    unfollows: number;
  };
  hashtag_sets: string[][];  // groups of hashtags to rotate
  content_suggestions: string[];
}

export interface SessionPlan {
  time: string;           // "10:00"
  duration_min: number;   // 45
  actions: SessionAction[];
}

export interface SessionAction {
  type: 'post' | 'story' | 'engage' | 'follow' | 'unfollow' | 'comment' | 'dm';
  method?: string;        // "like_hashtag", "comment_competitor_followers", etc.
  target?: string;        // hashtag, username, location
  count?: number;
  content_hint?: string;
  hashtags?: string[];
  comment_style?: string;
  priority: number;       // 1-5, higher = more important
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT — Account Strategy (v2 compatible with v1 for Tactician)
// ═══════════════════════════════════════════════════════════════════════════════

export interface AccountStrategy {
  version: string;
  generated_at: string;
  
  // v2: full daily plan from LLM
  daily_plan?: DailyPlan;
  
  daily_actions: {
    posts: number;
    stories: number;
    likes: number;
    comments: number;
    follows: number;
    unfollows: number;
  };
  
  timing: {
    post_at: string[];
    engage_windows: string[];
    timezone: string;
  };
  
  session: {
    duration_min: { min: number; max: number };
    pause_between_min: number;
    carryover: boolean;
  };
  
  content_rotation: {
    monday?: string;
    tuesday?: string;
    wednesday?: string;
    thursday?: string;
    friday?: string;
    saturday?: string;
    sunday?: string;
  };
  
  engagement: {
    target_hashtags: string[];
    target_accounts: string[];
    comment_templates: string[];
    like_ratio: number;
  };
  
  safety: {
    max_actions_per_hour: number;
    cooldown_after_warning: number;
    skip_if_flagged: boolean;
    human_hours_only: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketerResult {
  success: boolean;
  summary: string;
  clients_processed: number;
  accounts_updated: number;
  farming_accounts: number;
  business_accounts: number;
  duration_ms: number;
  error?: string;
  
  // v2 additions
  accounts_with_discovery?: number;  // accounts that triggered discovery
  discovery_requests?: number;       // total discovery requests made
  
  // Legacy escalation support
  escalations?: EscalationQuestion[];
  accounts_pending?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCALATION (kept for backward compat)
// ═══════════════════════════════════════════════════════════════════════════════

export interface EscalationQuestion {
  id: string;
  account_id: string;
  account_username: string;
  client_name: string;
  category: 'session_config' | 'daily_limits' | 'timing' | 'engagement' | 'safety';
  question: string;
  context: Record<string, unknown>;
  options?: string[];
  created_at: string;
}

export interface StrategyUpdate {
  account_id: string;
  username: string;
  platform: string;
  type: 'farming' | 'business';
  old_strategy: AccountStrategy | null;
  new_strategy: AccountStrategy;
  changes: string[];
}
