/**
 * siren/types.ts
 * Type definitions for Siren (P8)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface SirenConfig {
  timeout_minutes: number;
  max_posts_per_run: number;
  material_reuse_days: number;     // Don't reuse material within X days
  
  caption: {
    max_length: number;
    max_hashtags: number;
    max_emojis: number;
  };
  
  auto_approve: {
    farming: boolean;              // true
    business: boolean;             // false - needs Dan's approval
  };
}

export const DEFAULT_CONFIG: SirenConfig = {
  timeout_minutes: 60,
  max_posts_per_run: 50,
  material_reuse_days: 7,
  
  caption: {
    max_length: 2200,
    max_hashtags: 5,
    max_emojis: 5,
  },
  
  auto_approve: {
    farming: true,
    business: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════

export interface MaterialData {
  id: string;
  client_id: string;
  type: 'image' | 'video' | 'carousel';
  url: string;
  thumbnail_url?: string;
  metadata: MaterialMetadata;
  tags: string[];
  used_at: Date | null;
  created_at: Date;
}

export interface MaterialMetadata {
  width?: number;
  height?: number;
  duration_seconds?: number;
  file_size?: number;
  description?: string;
  alt_text?: string;
}

export interface AccountForContent {
  id: string;
  username: string;
  platform: string;
  client_id: string;
  type: 'farming' | 'business';
  strategy: {
    daily_actions: { posts: number };
    timing: { post_at: string[] };
    content_rotation: Record<string, string>;
  };
}

export interface ClientBranding {
  id: string;
  name: string;
  strategy: {
    tone: 'professional' | 'casual' | 'playful' | 'authoritative';
    hashtag_strategy: string;
  };
  brand_voice?: string;
  cta_templates?: string[];
  banned_words?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT — Post
// ═══════════════════════════════════════════════════════════════════════════════

export interface PostDraft {
  account_id: string;
  material_id: string;
  type: 'photo' | 'video' | 'reel' | 'story' | 'carousel';
  caption: string;
  hashtags: string[];
  scheduled_for: Date;
  status: 'draft' | 'approved' | 'pending_review';
  metadata: PostMetadata;
}

export interface PostMetadata {
  content_theme: string;         // From content_rotation
  generated_at: string;
  generation_context: {
    day_of_week: string;
    client_tone: string;
    account_type: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPTION GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface CaptionRequest {
  material: MaterialData;
  account: AccountForContent;
  client: ClientBranding;
  content_theme: string;
  post_type: string;
}

export interface CaptionResult {
  text: string;
  hashtags: string[];
  emojis_used: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface SirenResult {
  success: boolean;
  summary: string;
  posts_created: number;
  auto_approved: number;
  pending_review: number;
  materials_used: number;
  duration_ms: number;
  error?: string;
}

export interface ContentPlan {
  account_id: string;
  username: string;
  posts_needed: number;
  slots: ContentSlot[];
}

export interface ContentSlot {
  scheduled_for: Date;
  content_theme: string;
  material_id?: string;
  post_id?: string;
}
