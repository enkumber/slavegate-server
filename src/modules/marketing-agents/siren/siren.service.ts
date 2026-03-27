/**
 * siren/siren.service.ts
 * Siren agent logic (P8)
 * 
 * Spawned by Nautilus at 03:45 (nightly).
 * Creates content (posts) from materials + strategy.
 */

import { getDb } from '../../../db/client';
import {
  SirenConfig,
  DEFAULT_CONFIG,
  MaterialData,
  AccountForContent,
  ClientBranding,
  PostDraft,
  CaptionRequest,
  CaptionResult,
  SirenResult,
  ContentPlan,
  ContentSlot,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function runSiren(config: Partial<SirenConfig> = {}): Promise<SirenResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const db = getDb();
  
  console.log('[Siren] Starting content creation');
  
  try {
    // ─── 1. Get Accounts Needing Content ──────────────────────────────────────
    const accounts = await getAccountsNeedingContent(db);
    
    if (accounts.length === 0) {
      return {
        success: true,
        summary: 'No accounts need content',
        posts_created: 0,
        auto_approved: 0,
        pending_review: 0,
        materials_used: 0,
        duration_ms: Date.now() - startTime,
      };
    }
    
    // ─── 2. Build Content Plans ───────────────────────────────────────────────
    const plans: ContentPlan[] = [];
    for (const account of accounts) {
      const plan = buildContentPlan(account);
      plans.push(plan);
    }
    
    // ─── 3. Match Materials & Create Posts ────────────────────────────────────
    let postsCreated = 0;
    let autoApproved = 0;
    let pendingReview = 0;
    const materialsUsed = new Set<string>();
    
    for (const plan of plans) {
      const account = accounts.find(a => a.id === plan.account_id)!;
      const client = await getClientBranding(db, account.client_id);
      const materials = await getAvailableMaterials(db, account.client_id, cfg.material_reuse_days);
      
      for (const slot of plan.slots) {
        if (postsCreated >= cfg.max_posts_per_run) break;
        
        // Find matching material
        const material = matchMaterial(materials, slot.content_theme, materialsUsed);
        if (!material) {
          console.log(`[Siren] No material for ${account.username} slot ${slot.content_theme}`);
          continue;
        }
        
        // Generate caption
        const caption = generateCaption({
          material,
          account,
          client,
          content_theme: slot.content_theme,
          post_type: material.type,
        }, cfg);
        
        // Determine approval status
        const status = cfg.auto_approve[account.type] ? 'approved' : 'pending_review';
        
        // Create post draft
        const post: PostDraft = {
          account_id: account.id,
          material_id: material.id,
          type: mapMaterialToPostType(material.type),
          caption: caption.text,
          hashtags: caption.hashtags,
          scheduled_for: slot.scheduled_for,
          status,
          metadata: {
            content_theme: slot.content_theme,
            generated_at: new Date().toISOString(),
            generation_context: {
              day_of_week: getDayName(slot.scheduled_for),
              client_tone: client.strategy?.tone || 'casual',
              account_type: account.type,
            },
          },
        };
        
        // Save to DB
        await savePost(db, post);
        await markMaterialUsed(db, material.id);
        
        materialsUsed.add(material.id);
        postsCreated++;
        if (status === 'approved') autoApproved++;
        else pendingReview++;
        
        console.log(`[Siren] Created post for ${account.username}: ${slot.content_theme} (${status})`);
      }
    }
    
    const summary = `Created ${postsCreated} posts (${autoApproved} auto-approved, ${pendingReview} pending review)`;
    console.log(`[Siren] Complete: ${summary}`);
    
    return {
      success: true,
      summary,
      posts_created: postsCreated,
      auto_approved: autoApproved,
      pending_review: pendingReview,
      materials_used: materialsUsed.size,
      duration_ms: Date.now() - startTime,
    };
    
  } catch (err) {
    console.error('[Siren] Error:', err);
    return {
      success: false,
      summary: 'Content creation failed',
      posts_created: 0,
      auto_approved: 0,
      pending_review: 0,
      materials_used: 0,
      duration_ms: Date.now() - startTime,
      error: (err as Error).message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

async function getAccountsNeedingContent(db: any): Promise<AccountForContent[]> {
  // Get accounts with strategy that have posts scheduled
  const result = await db.query(`
    SELECT a.id, a.username, a.platform, a.client_id, a.type, a.strategy
    FROM accounts a
    WHERE a.status = 'active'
    AND a.strategy IS NOT NULL
    AND a.strategy->'daily_actions'->>'posts' IS NOT NULL
    AND (a.strategy->'daily_actions'->>'posts')::float > 0
    ORDER BY a.type, a.username
  `);
  
  return result.rows;
}

async function getClientBranding(db: any, clientId: string): Promise<ClientBranding> {
  const result = await db.query(`
    SELECT id, name, strategy
    FROM clients
    WHERE id = $1
  `, [clientId]);
  
  return result.rows[0] || { id: clientId, name: 'Unknown', strategy: {} };
}

async function getAvailableMaterials(db: any, clientId: string, reuseDays: number): Promise<MaterialData[]> {
  const result = await db.query(`
    SELECT id, client_id, type, url, thumbnail_url, metadata, tags, used_at, created_at
    FROM materials
    WHERE client_id = $1
    AND (used_at IS NULL OR used_at < NOW() - INTERVAL '${reuseDays} days')
    ORDER BY created_at DESC
  `, [clientId]);
  
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT PLANNING
// ═══════════════════════════════════════════════════════════════════════════════

function buildContentPlan(account: AccountForContent): ContentPlan {
  const strategy = account.strategy;
  const postsPerDay = strategy.daily_actions?.posts || 1;
  const postTimes = strategy.timing?.post_at || ['09:00', '18:00'];
  const rotation = strategy.content_rotation || {};
  
  const slots: ContentSlot[] = [];
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  // Create slots for tomorrow
  const dayName = getDayName(tomorrow).toLowerCase();
  const theme = rotation[dayName] || 'general';
  
  for (let i = 0; i < Math.min(postsPerDay, postTimes.length); i++) {
    const [hours, minutes] = postTimes[i].split(':').map(Number);
    const scheduledFor = new Date(tomorrow);
    scheduledFor.setHours(hours, minutes, 0, 0);
    
    slots.push({
      scheduled_for: scheduledFor,
      content_theme: theme,
    });
  }
  
  return {
    account_id: account.id,
    username: account.username,
    posts_needed: slots.length,
    slots,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATERIAL MATCHING
// ═══════════════════════════════════════════════════════════════════════════════

function matchMaterial(
  materials: MaterialData[],
  theme: string,
  usedMaterials: Set<string>
): MaterialData | null {
  // Filter out already used materials
  const available = materials.filter(m => !usedMaterials.has(m.id));
  
  if (available.length === 0) return null;
  
  // Try to match by tags
  const themeKeywords = theme.toLowerCase().split('_');
  const matched = available.find(m => 
    m.tags?.some(tag => themeKeywords.includes(tag.toLowerCase()))
  );
  
  if (matched) return matched;
  
  // Fall back to first available
  return available[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPTION GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

function generateCaption(request: CaptionRequest, cfg: SirenConfig): CaptionResult {
  const { material, account, client, content_theme } = request;
  const tone = client.strategy?.tone || 'casual';
  
  // Get base caption from material or generate
  let text = material.metadata?.description || '';
  
  // Generate based on theme and tone
  if (!text) {
    text = generateThemeCaption(content_theme, tone, account.type === 'business');
  }
  
  // Add CTA for business accounts
  if (account.type === 'business' && client.cta_templates?.length) {
    const cta = client.cta_templates[Math.floor(Math.random() * client.cta_templates.length)];
    text += `\n\n${cta}`;
  }
  
  // Generate hashtags
  const hashtags = generateHashtags(content_theme, material.tags || [], cfg.caption.max_hashtags);
  
  // Ensure within limits
  if (text.length > cfg.caption.max_length) {
    text = text.substring(0, cfg.caption.max_length - 3) + '...';
  }
  
  return {
    text,
    hashtags,
    emojis_used: countEmojis(text),
  };
}

function generateThemeCaption(theme: string, tone: string, isBusiness: boolean): string {
  const templates: Record<string, Record<string, string>> = {
    motivation: {
      professional: 'Start your week with intention. What are you working towards?',
      casual: 'New week, new goals! 💪 What\'s on your list?',
      playful: 'Monday mood: unstoppable! 🚀 Who\'s with me?',
      authoritative: 'Success is built one intentional day at a time.',
    },
    behind_scenes: {
      professional: 'A glimpse into our process.',
      casual: 'Behind the scenes today! 📸',
      playful: 'Sneak peek alert! 👀✨',
      authoritative: 'Excellence requires attention to detail at every step.',
    },
    tips: {
      professional: 'Here\'s what we\'ve learned:',
      casual: 'Quick tip that changed everything for us:',
      playful: 'Hot tip incoming! 🔥',
      authoritative: 'A crucial insight from our experience:',
    },
    product_highlight: {
      professional: 'Introducing excellence.',
      casual: 'Check this out! ✨',
      playful: 'Obsessed with this one! 😍',
      authoritative: 'Setting the standard.',
    },
    general: {
      professional: '',
      casual: '✨',
      playful: '💫',
      authoritative: '',
    },
  };
  
  const themeTemplates = templates[theme] || templates.general;
  return themeTemplates[tone] || themeTemplates.casual || '';
}

function generateHashtags(theme: string, materialTags: string[], maxCount: number): string[] {
  const hashtags: string[] = [];
  
  // Add theme-based hashtags
  const themeHashtags: Record<string, string[]> = {
    motivation: ['motivation', 'mondaymotivation', 'goals'],
    behind_scenes: ['behindthescenes', 'bts', 'process'],
    tips: ['tips', 'protip', 'howto'],
    product_highlight: ['newproduct', 'musthave', 'featured'],
    lifestyle: ['lifestyle', 'daily', 'life'],
  };
  
  if (themeHashtags[theme]) {
    hashtags.push(...themeHashtags[theme].slice(0, 2));
  }
  
  // Add material tags as hashtags
  for (const tag of materialTags) {
    if (hashtags.length >= maxCount) break;
    const cleaned = tag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (cleaned && !hashtags.includes(cleaned)) {
      hashtags.push(cleaned);
    }
  }
  
  return hashtags.slice(0, maxCount);
}

function countEmojis(text: string): number {
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const matches = text.match(emojiRegex);
  return matches ? matches.length : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function savePost(db: any, post: PostDraft): Promise<string> {
  const result = await db.query(`
    INSERT INTO posts (account_id, material_id, type, caption, hashtags, scheduled_for, status, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [
    post.account_id,
    post.material_id,
    post.type,
    post.caption,
    JSON.stringify(post.hashtags),
    post.scheduled_for,
    post.status,
    JSON.stringify(post.metadata),
  ]);
  
  return result.rows[0].id;
}

async function markMaterialUsed(db: any, materialId: string): Promise<void> {
  await db.query(`
    UPDATE materials SET used_at = NOW() WHERE id = $1
  `, [materialId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function mapMaterialToPostType(materialType: string): 'photo' | 'video' | 'reel' | 'story' | 'carousel' {
  switch (materialType) {
    case 'image': return 'photo';
    case 'video': return 'reel';
    case 'carousel': return 'carousel';
    default: return 'photo';
  }
}

function getDayName(date: Date): string {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { SirenConfig, SirenResult, PostDraft };
