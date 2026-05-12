/**
 * discovery/discovery.service.ts
 * Discovery Engine for Marketer v2.
 * 
 * Synchronous research: dispatches jobs to devices, waits for results.
 * Marketer calls executeAndWait() during strategy generation.
 * Falls back to cached data or empty on timeout.
 */

import { getDb } from '../../db/client';
import { dispatcherService } from '../dispatcher/dispatcher.service';
import { researchService } from '../research/research.service';
import type { DiscoveryRequest, ResearchData, HashtagData, AccountForStrategy } from '../marketing-agents/marketer/types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface DiscoveryOptions {
  timeout: number;  // ms
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class DiscoveryService {
  private readonly POLL_INTERVAL_MS = 3_000;

  /**
   * Execute multiple discovery requests and wait for results.
   * Returns partial data on timeout — never blocks indefinitely.
   */
  async executeAndWait(
    requests: DiscoveryRequest[],
    account: AccountForStrategy,
    options: DiscoveryOptions
  ): Promise<ResearchData> {
    const result: ResearchData = {
      top_hashtags: [],
      competitor_activity: '',
      trending_in_location: '',
      audience_online_hours: '',
    };

    if (requests.length === 0) return result;

    const deadline = Date.now() + options.timeout;
    const deviceId = await this.findDeviceForAccount(account);

    if (!deviceId) {
      console.warn(`[discovery] No device available for account ${account.username}, using cached data only`);
      return this.fallbackToCached(requests, account);
    }

    // Dispatch all requests in parallel
    const dispatched = await Promise.allSettled(
      requests.map(req => this.dispatchRequest(req, deviceId, account))
    );

    // Collect job IDs for fulfilled dispatches
    const pendingJobs: Array<{ jobId: string; request: DiscoveryRequest }> = [];
    for (let i = 0; i < dispatched.length; i++) {
      const d = dispatched[i];
      if (d.status === 'fulfilled' && d.value) {
        pendingJobs.push({ jobId: d.value, request: requests[i] });
      } else if (d.status === 'rejected') {
        console.warn(`[discovery] Failed to dispatch ${requests[i].type}:`, d.reason?.message || d.reason);
      }
    }

    // Wait for results with polling
    const completed = new Set<string>();
    while (pendingJobs.length > completed.size && Date.now() < deadline) {
      await this.sleep(Math.min(this.POLL_INTERVAL_MS, deadline - Date.now()));

      for (const { jobId, request } of pendingJobs) {
        if (completed.has(jobId)) continue;

        const job = await this.getJobResult(jobId);
        if (job) {
          completed.add(jobId);
          this.mergeResult(result, request, job.output);
          console.log(`[discovery] ${request.type} completed for ${account.username}`);
        }
      }
    }

    // Log timeout for incomplete jobs
    const incomplete = pendingJobs.filter(j => !completed.has(j.jobId));
    if (incomplete.length > 0) {
      console.warn(
        `[discovery] ${incomplete.length} jobs timed out for ${account.username}: ` +
        incomplete.map(j => j.request.type).join(', ')
      );
    }

    return result;
  }

  // ─── Dispatch Handlers ────────────────────────────────────────────────────

  private async dispatchRequest(
    request: DiscoveryRequest,
    deviceId: string,
    account: AccountForStrategy
  ): Promise<string | null> {
    try {
      switch (request.type) {
        case 'hashtag_search':
          return await this.dispatchHashtagSearch(request, deviceId);
        case 'profile_scan':
          return await this.dispatchProfileScan(request, deviceId);
        case 'location_posts':
          return await this.dispatchLocationPosts(request, deviceId);
        case 'follower_scan':
          return await this.dispatchFollowerScan(request, deviceId);
        default:
          console.warn(`[discovery] Unknown request type: ${request.type}`);
          return null;
      }
    } catch (err) {
      console.error(`[discovery] Dispatch error for ${request.type}:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Dispatch hashtag search job. Uses the skill system to search IG hashtags.
   */
  private async dispatchHashtagSearch(request: DiscoveryRequest, deviceId: string): Promise<string> {
    // Use research service to create a trackable job, then dispatch device job
    const jobId = await researchService.requestResearch(
      'research_hashtag',
      { hashtag: request.query, limit: request.params.limit ?? 50 },
      10  // high priority for real-time discovery
    );

    // Also dispatch a device job for live scraping
    const { jobId: deviceJobId } = await dispatcherService.dispatch({
      deviceId,
      type: 'a11y_find_tap',  // Will be used as part of a navigation flow
      params: {
        // Encode the research intent — Hydra/workflow will interpret
        _discovery: true,
        _discoveryType: 'hashtag_search',
        _query: request.query,
        _researchJobId: jobId,
      },
      timeoutMs: 120_000,  // 2 min for hashtag search
    });

    return deviceJobId;
  }

  /**
   * Dispatch profile scan job.
   */
  private async dispatchProfileScan(request: DiscoveryRequest, deviceId: string): Promise<string> {
    const jobId = await researchService.requestResearch(
      'research_profile',
      { username: request.query },
      10
    );

    const { jobId: deviceJobId } = await dispatcherService.dispatch({
      deviceId,
      type: 'a11y_find_tap',
      params: {
        _discovery: true,
        _discoveryType: 'profile_scan',
        _query: request.query,
        _researchJobId: jobId,
      },
      timeoutMs: 120_000,
    });

    return deviceJobId;
  }

  /**
   * Dispatch location posts search job.
   */
  private async dispatchLocationPosts(request: DiscoveryRequest, deviceId: string): Promise<string> {
    const { jobId } = await dispatcherService.dispatch({
      deviceId,
      type: 'a11y_find_tap',
      params: {
        _discovery: true,
        _discoveryType: 'location_posts',
        _query: request.query,
        _location: request.params.location,
      },
      timeoutMs: 120_000,
    });

    return jobId;
  }

  /**
   * Dispatch follower scan job.
   */
  private async dispatchFollowerScan(request: DiscoveryRequest, deviceId: string): Promise<string> {
    const jobId = await researchService.requestResearch(
      'research_followers',
      { username: request.query, limit: request.params.limit ?? 100 },
      10
    );

    const { jobId: deviceJobId } = await dispatcherService.dispatch({
      deviceId,
      type: 'a11y_find_tap',
      params: {
        _discovery: true,
        _discoveryType: 'follower_scan',
        _query: request.query,
        _researchJobId: jobId,
        _limit: request.params.limit ?? 100,
      },
      timeoutMs: 180_000,  // 3 min for follower scan
    });

    return deviceJobId;
  }

  // ─── Result Handling ──────────────────────────────────────────────────────

  private async getJobResult(jobId: string): Promise<{ output: Record<string, unknown> } | null> {
    const job = await dispatcherService.getJob(jobId);
    if (!job) return null;

    if (job.status === 'completed' && job.output) {
      return { output: job.output as Record<string, unknown> };
    }

    if (job.status === 'failed' || job.status === 'timeout') {
      // Job finished but failed — don't keep polling
      return { output: { _error: job.error || 'Job failed' } };
    }

    return null;  // Still pending/running
  }

  private mergeResult(
    result: ResearchData,
    request: DiscoveryRequest,
    output: Record<string, unknown>
  ): void {
    if (output._error) {
      console.warn(`[discovery] ${request.type} returned error:`, output._error);
      return;
    }

    switch (request.type) {
      case 'hashtag_search': {
        const topPosts = (output.top_posts as Array<{ username: string; likes: number; comments: number }>) || [];
        const relatedHashtags = (output.related_hashtags as string[]) || [];
        
        result.top_hashtags.push({
          name: request.query,
          posts_count: (output.posts_count as number) ?? null,
          relevance: 'searched',
        });
        
        // Add related hashtags as additional data
        for (const tag of relatedHashtags) {
          if (!result.top_hashtags.find(h => h.name === tag)) {
            result.top_hashtags.push({ name: tag, posts_count: null, relevance: 'related' });
          }
        }
        break;
      }
      
      case 'profile_scan': {
        const bio = output.bio as string || '';
        const followers = output.followers_count as number || 0;
        const posts = output.posts_count as number || 0;
        
        const info = `@${request.query}: ${followers} followers, ${posts} posts. Bio: ${bio}`;
        result.competitor_activity = result.competitor_activity
          ? `${result.competitor_activity}\n${info}`
          : info;
        break;
      }
      
      case 'location_posts': {
        const locationInfo = output.summary as string || JSON.stringify(output);
        result.trending_in_location = result.trending_in_location
          ? `${result.trending_in_location}\n${locationInfo}`
          : locationInfo;
        break;
      }
      
      case 'follower_scan': {
        // Follower data is stored in research_jobs, just note it
        const count = (output.usernames as string[])?.length || 0;
        result.competitor_activity = result.competitor_activity
          ? `${result.competitor_activity}\nScanned ${count} followers of @${request.query}`
          : `Scanned ${count} followers of @${request.query}`;
        break;
      }
    }
  }

  // ─── Device & Fallback ────────────────────────────────────────────────────

  /**
   * Find an available online device for the account's platform.
   * Prefers the device already assigned to this account.
   */
  private async findDeviceForAccount(account: AccountForStrategy): Promise<string | null> {
    const db = getDb();

    // First try: device already assigned to this account
    if (account.device_id) {
      const res = await db.query(
        `SELECT id FROM devices WHERE id = $1 AND status = 'online'`,
        [account.device_id]
      );
      if (res.rows.length > 0) return res.rows[0].id;
    }

    // Second try: any online device (for discovery we don't need account-specific login)
    const res = await db.query(
      `SELECT id FROM devices WHERE status = 'online' ORDER BY last_seen_at DESC LIMIT 1`
    );
    if (res.rows.length > 0) return res.rows[0].id;

    return null;
  }

  /**
   * Fallback: return cached research data when no device is available.
   */
  private async fallbackToCached(
    requests: DiscoveryRequest[],
    account: AccountForStrategy
  ): Promise<ResearchData> {
    const result: ResearchData = {
      top_hashtags: [],
      competitor_activity: '',
      trending_in_location: '',
      audience_online_hours: '',
    };

    for (const req of requests) {
      try {
        switch (req.type) {
          case 'hashtag_search': {
            const cached = await researchService.getCachedResult('research_hashtag', { hashtag: req.query });
            if (cached?.output) {
              const output = cached.output as { posts_count?: number; related_hashtags?: string[] };
              result.top_hashtags.push({
                name: req.query,
                posts_count: output.posts_count ?? null,
                relevance: 'cached',
              });
              for (const tag of output.related_hashtags || []) {
                result.top_hashtags.push({ name: tag, posts_count: null, relevance: 'cached_related' });
              }
            }
            break;
          }
          case 'profile_scan': {
            const cached = await researchService.getCachedResult('research_profile', { username: req.query });
            if (cached?.output) {
              const output = cached.output as { followers_count?: number; posts_count?: number; bio?: string };
              const info = `@${req.query}: ${output.followers_count || '?'} followers, ${output.posts_count || '?'} posts. Bio: ${output.bio || 'N/A'} (cached)`;
              result.competitor_activity = result.competitor_activity
                ? `${result.competitor_activity}\n${info}`
                : info;
            }
            break;
          }
        }
      } catch {
        // Ignore cache errors
      }
    }

    return result;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }
}

export const discoveryService = new DiscoveryService();
