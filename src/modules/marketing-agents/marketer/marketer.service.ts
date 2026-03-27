/**
 * marketer/marketer.service.ts
 * Marketer v2 — LLM-based agent (P7)
 * 
 * Replaces hardcoded strategy generation with:
 *   GATHER → ASSESS → DISCOVER → THINK + PLAN → SAVE
 * 
 * Spawned by Nautilus at 03:00 (nightly).
 */

import { getDb } from '../../../db/client';
import { llmJson } from '../../../utils/llm';
import { discoveryService } from '../../discovery/discovery.service';
import {
  MarketerConfig,
  DEFAULT_CONFIG,
  ClientData,
  ClientStrategy,
  AccountForStrategy,
  AccountStrategy,
  AccountContext,
  MarketerResult,
  DailyPlan,
  SessionPlan,
  SessionAction,
  PlatformLimits,
  DiscoveryRequest,
  AssessmentResult,
  ResearchData,
  HashtagData,
} from './types';
import { researchService } from '../../research/research.service';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const ASSESS_MODEL = 'claude-3-5-haiku-20241022';
const STRATEGY_MODEL = 'claude-sonnet-4-20250514';
const DISCOVERY_TIMEOUT_MS = 5 * 60_000;  // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

export async function runMarketer(config: Partial<MarketerConfig> = {}): Promise<MarketerResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const db = getDb();

  console.log('[Marketer v2] Starting LLM-based strategy generation');

  try {
    // ─── 1. Get Active Clients ──────────────────────────────────────────────
    const clients = await getActiveClients(db);

    if (clients.length === 0) {
      return {
        success: true,
        summary: 'No active clients',
        clients_processed: 0,
        accounts_updated: 0,
        farming_accounts: 0,
        business_accounts: 0,
        duration_ms: Date.now() - startTime,
      };
    }

    // ─── 2. Process Each Client ─────────────────────────────────────────────
    let totalAccounts = 0;
    let farmingCount = 0;
    let businessCount = 0;
    let discoveryAccountCount = 0;
    let totalDiscoveryRequests = 0;

    for (const client of clients) {
      const accounts = await getClientAccounts(db, client.id);

      for (const account of accounts) {
        try {
          const platform = account.platform.toLowerCase();
          const limits = cfg.platform_limits[platform as keyof typeof cfg.platform_limits]
            || cfg.platform_limits.default;

          // ─── STEP 1: GATHER ───────────────────────────────────────────────
          const context = await gatherContext(account, client, limits);
          console.log(`[Marketer v2] Gathered context for @${account.username}`);

          // ─── STEP 2: ASSESS ───────────────────────────────────────────────
          const assessment = await assessContext(context);
          console.log(`[Marketer v2] Assessment for @${account.username}: ${assessment.needs_research.length} research requests`);

          // ─── STEP 3: DISCOVER ─────────────────────────────────────────────
          if (assessment.needs_research.length > 0) {
            discoveryAccountCount++;
            totalDiscoveryRequests += assessment.needs_research.length;

            const freshData = await discoveryService.executeAndWait(
              assessment.needs_research,
              account,
              { timeout: DISCOVERY_TIMEOUT_MS }
            );
            // Merge fresh data into context
            context.research = mergeResearchData(context.research, freshData);
            console.log(`[Marketer v2] Discovery complete for @${account.username}`);
          }

          // ─── STEP 4: THINK + PLAN ────────────────────────────────────────
          const plan = await thinkAndPlan(context);
          console.log(`[Marketer v2] Plan generated for @${account.username}: ${plan.sessions.length} sessions`);

          // ─── STEP 5: SAVE ────────────────────────────────────────────────
          const strategy = planToStrategy(plan, context, limits);
          await saveAccountPlan(db, account.id, strategy);

          totalAccounts++;
          if (account.type === 'farming') farmingCount++;
          else businessCount++;

          console.log(`[Marketer v2] Strategy saved for @${account.username}`);
        } catch (err) {
          console.error(`[Marketer v2] Error processing @${account.username}:`, (err as Error).message);
          // Continue with next account
        }
      }
    }

    const summary = `Updated strategy for ${totalAccounts} accounts (${farmingCount} farming, ${businessCount} business). Discovery: ${discoveryAccountCount} accounts, ${totalDiscoveryRequests} requests.`;
    console.log(`[Marketer v2] Complete: ${summary}`);

    return {
      success: true,
      summary,
      clients_processed: clients.length,
      accounts_updated: totalAccounts,
      farming_accounts: farmingCount,
      business_accounts: businessCount,
      duration_ms: Date.now() - startTime,
      accounts_with_discovery: discoveryAccountCount,
      discovery_requests: totalDiscoveryRequests,
    };

  } catch (err) {
    console.error('[Marketer v2] Error:', err);
    return {
      success: false,
      summary: 'Strategy generation failed',
      clients_processed: 0,
      accounts_updated: 0,
      farming_accounts: 0,
      business_accounts: 0,
      duration_ms: Date.now() - startTime,
      error: (err as Error).message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: GATHER — Collect all context for an account
// ═══════════════════════════════════════════════════════════════════════════════

async function gatherContext(
  account: AccountForStrategy,
  client: ClientData,
  limits: PlatformLimits
): Promise<AccountContext> {
  const db = getDb();
  const clientStrategy = client.strategy || {} as ClientStrategy;

  // Parallel queries for performance
  const [yesterdayData, researchData, accountAge] = await Promise.all([
    getYesterdayData(db, account.id),
    getExistingResearch(account, clientStrategy),
    getAccountAgeDays(account),
  ]);

  // ── Self-scan: fetch REAL profile data from platform if metrics are stale ──
  const metrics = account.metrics || {};
  const hasRealMetrics = (metrics.followers_count || metrics.followers) > 0;
  const lastScanAge = metrics._last_scan_at
    ? Date.now() - new Date(metrics._last_scan_at as string).getTime()
    : Infinity;
  const SCAN_STALE_MS = 12 * 60 * 60 * 1000; // 12 hours

  if (!hasRealMetrics || lastScanAge > SCAN_STALE_MS) {
    console.log(`[Marketer v2] @${account.username}: metrics stale/empty — launching self-scan`);
    try {
      const { discoveryService } = await import('../../discovery/discovery.service');
      const freshData = await discoveryService.executeAndWait(
        [{ type: 'profile_scan', query: account.username, params: { username: account.username } }],
        account,
        { timeout: 3 * 60_000 } // 3 min max
      );
      // Merge fresh metrics into account
      if (freshData.competitor_activity) {
        try {
          const parsed = JSON.parse(freshData.competitor_activity);
          if (parsed.followers_count) {
            const updatedMetrics = {
              ...metrics,
              followers_count: parsed.followers_count,
              followers: parsed.followers_count,
              following_count: parsed.following_count,
              following: parsed.following_count,
              posts_count: parsed.posts_count,
              posts: parsed.posts_count,
              engagement_rate: parsed.engagement_rate || metrics.engagement_rate,
              bio: parsed.bio,
              _last_scan_at: new Date().toISOString(),
            };
            // Save to DB for next time
            await db.query('UPDATE accounts SET metrics = $1 WHERE id = $2', [
              JSON.stringify(updatedMetrics), account.id
            ]);
            account.metrics = updatedMetrics;
            console.log(`[Marketer v2] @${account.username}: self-scan OK — ${parsed.followers_count} followers`);
          }
        } catch { /* parse error, continue with what we have */ }
      }
    } catch (err) {
      console.warn(`[Marketer v2] @${account.username}: self-scan failed — ${(err as Error).message}`);
    }
  }

  // Extract flags as string array
  const flags: string[] = [];
  const accountFlags = account.flags || {};
  if (accountFlags.soft_blocked_recently) flags.push('soft_blocked_recently');
  if (accountFlags.rate_limited_recently) flags.push('rate_limited_recently');
  if (accountFlags.anomaly_detected) flags.push('anomaly_detected');
  if (accountFlags.warning_received) flags.push('warning_received');
  if (account.status === 'rate_limited') flags.push('rate_limited');
  if (account.status === 'warming_up') flags.push('warming_up');

  // Use potentially updated metrics (from self-scan above)
  const currentMetrics = account.metrics || {};

  return {
    client: {
      name: client.name,
      goal: clientStrategy.goal || 'growth',
      tone: clientStrategy.tone || 'professional',
      target_audience: clientStrategy.target_audience?.description
        || formatTargetAudience(clientStrategy.target_audience),
      locations: clientStrategy.locations
        || clientStrategy.target_audience?.locations
        || [],
      competitors: clientStrategy.competitor_accounts || [],
      notes: clientStrategy.notes || '',
    },
    account: {
      id: account.id,
      username: account.username,
      platform: account.platform,
      type: account.type,
      followers: currentMetrics.followers_count || currentMetrics.followers || 0,
      following: currentMetrics.following_count || currentMetrics.following || 0,
      posts: currentMetrics.posts_count || currentMetrics.posts || 0,
      engagement_rate: currentMetrics.engagement_rate || 0,
      recent_growth: currentMetrics.recent_growth || 'unknown',
      flags,
      age_days: accountAge,
    },
    yesterday: yesterdayData,
    research: researchData,
    limits: {
      max_actions_per_hour: limits.max_actions_per_hour,
      max_posts_per_day: limits.max_posts_per_day,
      max_follows_per_day: limits.max_follows_per_day,
      max_likes_per_day: limits.max_likes_per_day,
      max_comments_per_day: limits.max_comments_per_day,
      cooldown_active: account.status === 'rate_limited'
        || !!accountFlags.soft_blocked_recently,
    },
  };
}

/**
 * Get yesterday's execution data for an account.
 */
async function getYesterdayData(
  db: any,
  accountId: string
): Promise<AccountContext['yesterday']> {
  try {
    // Get tasks from yesterday
    const tasksResult = await db.query(`
      SELECT routine, status, params, started_at, completed_at
      FROM tasks
      WHERE account_id = $1
        AND scheduled_time >= NOW() - INTERVAL '1 day'
        AND scheduled_time < NOW()
      ORDER BY scheduled_time
    `, [accountId]);

    if (tasksResult.rows.length === 0) {
      return {
        actions_performed: 'No actions yesterday (first day or paused)',
        results: 'No results available',
        issues: 'None',
      };
    }

    // Summarize actions
    const actions: string[] = [];
    const issues: string[] = [];
    let completedCount = 0;
    let failedCount = 0;

    for (const task of tasksResult.rows) {
      const routine = task.routine as string;
      const status = task.status as string;
      
      if (status === 'completed') {
        completedCount++;
        actions.push(routine);
      } else if (status === 'failed') {
        failedCount++;
        issues.push(`${routine} failed`);
      }
    }

    // Count actions by type
    const actionCounts = actions.reduce((acc, a) => {
      acc[a] = (acc[a] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const actionsStr = Object.entries(actionCounts)
      .map(([action, count]) => `${count}x ${action}`)
      .join(', ');

    // Get execution log summaries
    const logsResult = await db.query(`
      SELECT log_data
      FROM execution_logs el
      JOIN tasks t ON t.id = el.task_id
      WHERE t.account_id = $1
        AND el.timestamp >= NOW() - INTERVAL '1 day'
      ORDER BY el.timestamp DESC
      LIMIT 20
    `, [accountId]);

    // Extract results from logs
    let resultsStr = `${completedCount} tasks completed, ${failedCount} failed`;
    const logSummaries: string[] = [];
    for (const log of logsResult.rows) {
      const data = log.log_data as Record<string, unknown>;
      if (data.followers_gained) logSummaries.push(`+${data.followers_gained} followers`);
      if (data.likes_given) logSummaries.push(`${data.likes_given} likes given`);
      if (data.comments_made) logSummaries.push(`${data.comments_made} comments made`);
      if (data.follows_made) logSummaries.push(`${data.follows_made} follows made`);
      if (data.error) issues.push(String(data.error));
    }
    if (logSummaries.length > 0) {
      resultsStr += '. ' + logSummaries.join(', ');
    }

    return {
      actions_performed: actionsStr || 'No actions recorded',
      results: resultsStr,
      issues: issues.length > 0 ? issues.join('; ') : 'None',
    };
  } catch (err) {
    console.warn('[Marketer v2] Failed to get yesterday data:', (err as Error).message);
    return {
      actions_performed: 'Data unavailable',
      results: 'Data unavailable',
      issues: 'Could not retrieve yesterday data',
    };
  }
}

/**
 * Get existing cached research data from research_jobs.
 */
async function getExistingResearch(
  account: AccountForStrategy,
  clientStrategy: ClientStrategy
): Promise<ResearchData> {
  const result: ResearchData = {
    top_hashtags: [],
    competitor_activity: '',
    trending_in_location: '',
    audience_online_hours: '',
  };

  // Get cached hashtag data
  const targetHashtags = clientStrategy.target_hashtags || [];
  const existingHashtags = account.strategy?.engagement?.target_hashtags || [];
  const allHashtags = [...new Set([...targetHashtags, ...existingHashtags])];

  for (const hashtag of allHashtags.slice(0, 20)) {  // Limit to avoid too many queries
    try {
      const cached = await researchService.getCachedResult('research_hashtag', { hashtag });
      if (cached?.output) {
        const output = cached.output as { posts_count?: number; related_hashtags?: string[] };
        result.top_hashtags.push({
          name: hashtag,
          posts_count: output.posts_count ?? null,
          relevance: 'cached',
        });
      }
    } catch { /* ignore */ }
  }

  // Get cached competitor data
  for (const competitor of (clientStrategy.competitor_accounts || []).slice(0, 10)) {
    try {
      const cached = await researchService.getCachedResult('research_profile', { username: competitor });
      if (cached?.output) {
        const output = cached.output as { followers_count?: number; posts_count?: number; bio?: string };
        const info = `@${competitor}: ${output.followers_count || '?'} followers, ${output.posts_count || '?'} posts. Bio: ${output.bio || 'N/A'}`;
        result.competitor_activity = result.competitor_activity
          ? `${result.competitor_activity}\n${info}`
          : info;
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Get account age in days.
 */
async function getAccountAgeDays(account: AccountForStrategy): Promise<number> {
  const metrics = account.metrics || {};
  const createdAt = metrics.created_at || metrics.account_created_at;
  if (!createdAt) return 180;  // Default: assume 6 months

  const created = new Date(createdAt);
  const now = new Date();
  return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
}

function formatTargetAudience(target?: ClientStrategy['target_audience']): string {
  if (!target) return 'general audience';
  const parts: string[] = [];
  if (target.age_range) parts.push(target.age_range);
  if (target.interests?.length) parts.push(target.interests.join(', '));
  if (target.locations?.length) parts.push(target.locations.join(', '));
  return parts.join(' — ') || 'general audience';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: ASSESS — LLM evaluates if more data is needed
// ═══════════════════════════════════════════════════════════════════════════════

async function assessContext(context: AccountContext): Promise<AssessmentResult> {
  const prompt = `You are a social media data analyst. Your job is to evaluate whether we have enough research data to create a good daily strategy for this account.

## Account: @${context.account.username} (${context.account.platform})
Client: ${context.client.name}
Goal: ${context.client.goal}
Target audience: ${context.client.target_audience}
Locations: ${context.client.locations.join(', ') || 'not specified'}
Competitors: ${context.client.competitors.join(', ') || 'none specified'}

## Current Research Data
Hashtags available: ${context.research.top_hashtags.length > 0
    ? context.research.top_hashtags.map(h => `${h.name} (${h.posts_count ?? '?'} posts)`).join(', ')
    : 'NONE'}
Competitor data: ${context.research.competitor_activity || 'NONE'}
Location trends: ${context.research.trending_in_location || 'NONE'}

## Instructions
Evaluate what data is MISSING for a good strategy. Only request what's truly necessary — don't request data we already have.

Available research types:
- hashtag_search: search for hashtags on IG. query = hashtag name, params = { limit: number }
- profile_scan: scrape a competitor profile. query = username
- location_posts: get trending posts from a location. query = location name, params = { location: string }
- follower_scan: scan followers of a competitor. query = username, params = { limit: number }

Respond in JSON:
{
  "reasoning": "brief explanation of what's missing and why",
  "needs_research": [
    { "type": "hashtag_search", "query": "example", "params": {} }
  ]
}

If we have enough data, return empty needs_research array.
IMPORTANT: Maximum 3 research requests to avoid overloading devices.`;

  try {
    const result = await llmJson<AssessmentResult>(prompt, ASSESS_MODEL, { max_tokens: 1024 });
    
    // Validate and cap at 3 requests
    return {
      reasoning: result.reasoning || '',
      needs_research: (result.needs_research || []).slice(0, 3).map(req => ({
        type: req.type,
        query: req.query || '',
        params: req.params || {},
      })),
    };
  } catch (err) {
    console.warn('[Marketer v2] Assessment LLM failed, proceeding without discovery:', (err as Error).message);
    return { reasoning: 'Assessment failed', needs_research: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: THINK + PLAN — Main LLM strategy generation
// ═══════════════════════════════════════════════════════════════════════════════

async function thinkAndPlan(context: AccountContext): Promise<DailyPlan> {
  const prompt = buildMarketerPrompt(context);
  
  const plan = await llmJson<DailyPlan>(prompt, STRATEGY_MODEL, { max_tokens: 4096 });
  
  return validatePlan(plan, context);
}

function buildMarketerPrompt(ctx: AccountContext): string {
  const hashtagList = ctx.research.top_hashtags.length > 0
    ? ctx.research.top_hashtags.map(h => `- ${h.name} (${h.posts_count ?? '?'} posts, ${h.relevance})`).join('\n')
    : 'No hashtag research available — suggest what to research for tomorrow';

  return `Ești un social media strategist experimentat. Analizezi contul și decizi ce acțiuni să facă AZI pentru a atinge obiectivul clientului.

## Context Client
${ctx.client.name} — ${ctx.client.goal}
Target: ${ctx.client.target_audience}
Locații: ${ctx.client.locations.join(', ') || 'not specified'}
Ton: ${ctx.client.tone}
${ctx.client.notes ? `Note: ${ctx.client.notes}` : ''}

## Contul @${ctx.account.username} (${ctx.account.platform}, ${ctx.account.type})
Followers: ${ctx.account.followers} | Following: ${ctx.account.following} | Posts: ${ctx.account.posts}
Engagement rate: ${ctx.account.engagement_rate}%
Growth recent: ${ctx.account.recent_growth}
Flags: ${ctx.account.flags.length > 0 ? ctx.account.flags.join(', ') : 'none'}
Account age: ${ctx.account.age_days} days

## Ce s-a făcut ieri
${ctx.yesterday.actions_performed}
Rezultate: ${ctx.yesterday.results}
Probleme: ${ctx.yesterday.issues}

## Research actual
Top hashtaguri relevante (din research real, NU inventate):
${hashtagList}

Activitatea competitorilor:
${ctx.research.competitor_activity || 'No competitor data available'}

Trending în ${ctx.client.locations.join(', ') || 'target locations'}:
${ctx.research.trending_in_location || 'No location trend data available'}

Ore active ale audienței: ${ctx.research.audience_online_hours || 'Not known — use default peak hours for Romania'}

## Constrângeri
- Max ${ctx.limits.max_actions_per_hour} acțiuni/oră
- Max ${ctx.limits.max_posts_per_day} posts/zi
- Max ${ctx.limits.max_follows_per_day} follows/zi
- Max ${ctx.limits.max_likes_per_day} likes/zi
- Max ${ctx.limits.max_comments_per_day} comments/zi
- Cooldown activ: ${ctx.limits.cooldown_active ? 'DA — reduce cu 50% toate acțiunile!' : 'nu'}

## Instrucțiuni
1. Analizează situația actuală a contului
2. Identifică ce a funcționat și ce nu ieri
3. Decide ce acțiuni au cel mai mare impact AZI
4. Creează un plan concret cu timing, acțiuni, și hashtaguri
5. Hashtagurile trebuie să fie din lista de research de mai sus (nu inventa altele noi!)
6. Include mix de hashtaguri locale (${ctx.client.locations.join(', ')}) și niche
7. Adaptează față de ce s-a întâmplat ieri
8. ${ctx.account.type === 'farming' ? 'Account farming: focus pe growth agresiv (follow, like, engage)' : 'Business account: focus pe content quality și engagement organic'}
9. ${ctx.account.flags.includes('warming_up') ? 'CONT NOU — acțiuni foarte conservative, maxim 50% din limite!' : ''}
10. ${ctx.account.flags.includes('rate_limited') || ctx.account.flags.includes('soft_blocked_recently') ? 'ATENȚIE: cont cu warning/rate limit — reduce dramatic acțiunile!' : ''}

Răspunde STRICT în format JSON:
{
  "analysis": "scurtă analiză a situației (2-3 propoziții)",
  "strategy_today": "ce abordare alegi azi și de ce (1-2 propoziții)",
  "sessions": [
    {
      "time": "10:00",
      "duration_min": 45,
      "actions": [
        { "type": "engage", "method": "like_hashtag", "target": "#hashtag", "count": 20, "priority": 3 },
        { "type": "engage", "method": "comment_competitor_followers", "target": "@competitor", "count": 5, "comment_style": "compliment about their work", "priority": 2 },
        { "type": "follow", "method": "follow_hashtag_users", "target": "#hashtag", "count": 10, "priority": 2 },
        { "type": "post", "content_hint": "behind the scenes photo", "hashtags": ["#h1", "#h2"], "priority": 5 }
      ]
    }
  ],
  "daily_totals": {
    "posts": 1,
    "stories": 2,
    "likes": 80,
    "comments": 15,
    "follows": 20,
    "unfollows": 10
  },
  "hashtag_sets": [
    ["#set1_tag1", "#set1_tag2", "#set1_tag3"],
    ["#set2_tag1", "#set2_tag2", "#set2_tag3"]
  ],
  "content_suggestions": [
    "Behind the scenes setup shot",
    "Client transformation before/after"
  ]
}`;
}

/**
 * Validate plan against platform limits and fix obvious issues.
 */
function validatePlan(plan: DailyPlan, context: AccountContext): DailyPlan {
  const limits = context.limits;

  // Ensure required fields
  if (!plan.analysis) plan.analysis = 'Analysis not provided';
  if (!plan.strategy_today) plan.strategy_today = 'Strategy not provided';
  if (!plan.sessions) plan.sessions = [];
  if (!plan.daily_totals) {
    plan.daily_totals = { posts: 0, stories: 0, likes: 0, comments: 0, follows: 0, unfollows: 0 };
  }
  if (!plan.hashtag_sets) plan.hashtag_sets = [];
  if (!plan.content_suggestions) plan.content_suggestions = [];

  // Cap daily totals at platform limits
  plan.daily_totals.posts = Math.min(plan.daily_totals.posts || 0, limits.max_posts_per_day);
  plan.daily_totals.likes = Math.min(plan.daily_totals.likes || 0, limits.max_likes_per_day);
  plan.daily_totals.comments = Math.min(plan.daily_totals.comments || 0, limits.max_comments_per_day);
  plan.daily_totals.follows = Math.min(plan.daily_totals.follows || 0, limits.max_follows_per_day);

  // If cooldown active, reduce by 50%
  if (context.limits.cooldown_active) {
    plan.daily_totals.likes = Math.floor(plan.daily_totals.likes * 0.5);
    plan.daily_totals.comments = Math.floor(plan.daily_totals.comments * 0.5);
    plan.daily_totals.follows = Math.floor(plan.daily_totals.follows * 0.5);
  }

  // Validate sessions have proper structure
  plan.sessions = plan.sessions.map(session => ({
    time: session.time || '10:00',
    duration_min: Math.max(15, Math.min(session.duration_min || 45, 120)),
    actions: (session.actions || []).map(action => ({
      type: action.type || 'engage',
      method: action.method,
      target: action.target,
      count: action.count,
      content_hint: action.content_hint,
      hashtags: action.hashtags,
      comment_style: action.comment_style,
      priority: Math.max(1, Math.min(action.priority || 3, 5)),
    })),
  }));

  return plan;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: SAVE — Convert plan to strategy and persist
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert LLM DailyPlan to AccountStrategy format (backward-compatible with Tactician).
 */
function planToStrategy(
  plan: DailyPlan,
  context: AccountContext,
  limits: PlatformLimits
): AccountStrategy {
  // Extract timing from sessions
  const postAt = plan.sessions
    .filter(s => s.actions.some(a => a.type === 'post'))
    .map(s => s.time);
  
  const engageWindows = plan.sessions
    .filter(s => s.actions.some(a => a.type === 'engage' || a.type === 'follow'))
    .map(s => {
      const h = parseInt(s.time.split(':')[0]);
      const start = s.time;
      const end = `${String(h + Math.ceil(s.duration_min / 60)).padStart(2, '0')}:00`;
      return `${start}-${end}`;
    });

  // Extract hashtags from plan
  const allHashtags = new Set<string>();
  for (const set of plan.hashtag_sets) {
    for (const tag of set) allHashtags.add(tag);
  }
  for (const session of plan.sessions) {
    for (const action of session.actions) {
      if (action.hashtags) action.hashtags.forEach(h => allHashtags.add(h));
      if (action.target?.startsWith('#')) allHashtags.add(action.target);
    }
  }

  // Extract target accounts
  const targetAccounts = new Set<string>();
  for (const session of plan.sessions) {
    for (const action of session.actions) {
      if (action.target?.startsWith('@')) targetAccounts.add(action.target.replace('@', ''));
    }
  }

  // Compute session config from plan
  const durations = plan.sessions.map(s => s.duration_min);
  const minDuration = durations.length > 0 ? Math.min(...durations) : 30;
  const maxDuration = durations.length > 0 ? Math.max(...durations) : 60;

  const isFarming = context.account.type === 'farming';

  return {
    version: '2.0',
    generated_at: new Date().toISOString(),

    // v2: include full plan for Tactician to use
    daily_plan: plan,

    daily_actions: {
      posts: plan.daily_totals.posts,
      stories: plan.daily_totals.stories,
      likes: plan.daily_totals.likes,
      comments: plan.daily_totals.comments,
      follows: plan.daily_totals.follows,
      unfollows: plan.daily_totals.unfollows,
    },

    timing: {
      post_at: postAt.length > 0 ? postAt : ['10:00', '18:00'],
      engage_windows: engageWindows.length > 0 ? engageWindows : ['11:00-13:00', '19:00-21:00'],
      timezone: 'Europe/Bucharest',
    },

    session: {
      duration_min: { min: minDuration, max: maxDuration },
      pause_between_min: isFarming ? 60 : 90,
      carryover: true,
    },

    content_rotation: {
      // v2: LLM decides content per day via sessions, not fixed rotation
      // Keep a basic rotation for backward compat
      monday: plan.content_suggestions[0] || 'brand_story',
      tuesday: plan.content_suggestions[1] || 'tips',
      wednesday: plan.content_suggestions[2] || 'behind_scenes',
      thursday: plan.content_suggestions[3] || 'engagement',
      friday: plan.content_suggestions[4] || 'user_content',
      saturday: plan.content_suggestions[5] || 'lifestyle',
      sunday: plan.content_suggestions[6] || 'inspiration',
    },

    engagement: {
      target_hashtags: Array.from(allHashtags).slice(0, 30),
      target_accounts: Array.from(targetAccounts),
      comment_templates: isFarming
        ? ['🔥', '👏', 'Amazing!', 'Love this!', '💯']
        : ['Great content! 👏', 'Love your perspective!', 'Thanks for sharing! 🙌'],
      like_ratio: isFarming ? 0.8 : 0.5,
    },

    safety: {
      max_actions_per_hour: limits.max_actions_per_hour,
      cooldown_after_warning: limits.cooldown_after_warning_hours,
      skip_if_flagged: true,
      human_hours_only: !isFarming,
    },
  };
}

async function saveAccountPlan(db: any, accountId: string, strategy: AccountStrategy): Promise<void> {
  await db.query(`
    UPDATE accounts
    SET strategy = $1, updated_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(strategy), accountId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

async function getActiveClients(db: any): Promise<ClientData[]> {
  const result = await db.query(`
    SELECT id, name, status, strategy, created_at, updated_at
    FROM clients
    WHERE status = 'active'
    ORDER BY name
  `);
  return result.rows;
}

async function getClientAccounts(db: any, clientId: string): Promise<AccountForStrategy[]> {
  const result = await db.query(`
    SELECT id, username, platform, client_id, type, status, metrics, flags, strategy, device_id
    FROM accounts
    WHERE client_id = $1 AND status IN ('active', 'warming_up')
    ORDER BY type, username
  `, [clientId]);
  return result.rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function mergeResearchData(existing: ResearchData, fresh: ResearchData): ResearchData {
  return {
    top_hashtags: [...existing.top_hashtags, ...fresh.top_hashtags],
    competitor_activity: [existing.competitor_activity, fresh.competitor_activity].filter(Boolean).join('\n'),
    trending_in_location: [existing.trending_in_location, fresh.trending_in_location].filter(Boolean).join('\n'),
    audience_online_hours: fresh.audience_online_hours || existing.audience_online_hours,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { MarketerConfig, MarketerResult, AccountStrategy };
