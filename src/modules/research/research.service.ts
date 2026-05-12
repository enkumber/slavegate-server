/**
 * research/research.service.ts
 * Research job management for Marketer automation.
 * 
 * Flow:
 * 1. Marketer requests research → job created in DB (pending)
 * 2. Kraken polls pending jobs during night window (01:00-05:00)
 * 3. Hydra executes research on device → completes/fails job
 * 4. Marketer uses cached results on next run
 * 
 * Cache: 7 days default, configurable via expires_at
 * Rate limit: 100 requests/hour/device (enforced by Kraken)
 */

import { getDb } from "../../db/client";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ResearchJobType = 'research_profile' | 'research_hashtag' | 'research_followers';
export type ResearchJobStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed';

export interface ResearchJob {
  id: string;
  jobType: ResearchJobType;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: ResearchJobStatus;
  priority: number;
  deviceId: string | null;
  error: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ResearchResult {
  jobId: string;
  jobType: ResearchJobType;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  completedAt: Date;
  expiresAt: Date;
}

export interface ProfileResearchInput {
  username: string;
}

export interface ProfileResearchOutput {
  followers_count: number | null;
  following_count: number | null;
  posts_count: number | null;
  bio: string | null;
  is_verified: boolean;
  is_private: boolean;
}

export interface HashtagResearchInput {
  hashtag: string;
  limit?: number;  // default 50
}

export interface HashtagResearchOutput {
  posts_count: number | null;
  top_posts: Array<{ username: string; likes: number; comments: number }>;
  related_hashtags: string[];
}

export interface FollowersResearchInput {
  username: string;
  limit?: number;  // default 100
}

export interface FollowersResearchOutput {
  usernames: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class ResearchService {
  private readonly DEFAULT_CACHE_DAYS = 7;
  private readonly MAX_PENDING_PER_TYPE = 100;  // Prevent queue bloat

  /**
   * Request a research job. Returns existing job ID if same request is pending/running.
   * Marketer calls this when data is needed.
   */
  async requestResearch(
    type: ResearchJobType,
    input: Record<string, unknown>,
    priority: number = 0
  ): Promise<string> {
    const db = getDb();
    
    // Normalize input for consistent matching
    const normalizedInput = JSON.stringify(this.normalizeInput(type, input));
    
    // Check for existing pending/scheduled/running job with same type + input
    const existing = await db.query(`
      SELECT id FROM research_jobs
      WHERE job_type = $1 
        AND input = $2::jsonb
        AND status IN ('pending', 'scheduled', 'running')
      LIMIT 1
    `, [type, normalizedInput]);
    
    if (existing.rows.length > 0) {
      console.log(`[research] Existing ${type} job found: ${existing.rows[0].id}`);
      return existing.rows[0].id;
    }
    
    // Check queue size to prevent bloat
    const queueSize = await db.query(`
      SELECT COUNT(*) FROM research_jobs
      WHERE job_type = $1 AND status = 'pending'
    `, [type]);
    
    if (parseInt(queueSize.rows[0].count) >= this.MAX_PENDING_PER_TYPE) {
      throw new Error(`Research queue full for ${type} (max ${this.MAX_PENDING_PER_TYPE})`);
    }
    
    // Create new job
    const result = await db.query(`
      INSERT INTO research_jobs (job_type, input, priority)
      VALUES ($1, $2::jsonb, $3)
      RETURNING id
    `, [type, normalizedInput, priority]);
    
    const jobId = result.rows[0].id;
    console.log(`[research] Created ${type} job: ${jobId} (priority: ${priority})`);
    
    return jobId;
  }

  /**
   * Get cached research result if available and not expired.
   * Returns null if no valid cache exists.
   */
  async getCachedResult(
    type: ResearchJobType,
    input: Record<string, unknown>
  ): Promise<ResearchResult | null> {
    const db = getDb();
    const normalizedInput = JSON.stringify(this.normalizeInput(type, input));
    
    const result = await db.query(`
      SELECT id, job_type, input, output, completed_at, expires_at
      FROM research_jobs
      WHERE job_type = $1
        AND input = $2::jsonb
        AND status = 'completed'
        AND expires_at > NOW()
      ORDER BY completed_at DESC
      LIMIT 1
    `, [type, normalizedInput]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      jobId: row.id,
      jobType: row.job_type,
      input: row.input,
      output: row.output,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Get pending jobs for Kraken to schedule.
   * Returns jobs ordered by priority (high first) then creation time.
   */
  async getPendingJobs(limit: number = 50): Promise<ResearchJob[]> {
    const db = getDb();
    
    const result = await db.query(`
      SELECT * FROM research_jobs
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(this.rowToJob);
  }

  /**
   * Schedule a job for execution on a device.
   * Called by Kraken when assigning work.
   */
  async scheduleJob(jobId: string, deviceId: string): Promise<void> {
    const db = getDb();
    
    await db.query(`
      UPDATE research_jobs
      SET status = 'scheduled',
          device_id = $2,
          scheduled_at = NOW()
      WHERE id = $1 AND status = 'pending'
    `, [jobId, deviceId]);
    
    console.log(`[research] Scheduled job ${jobId} on device ${deviceId.slice(0, 8)}`);
  }

  /**
   * Mark job as running.
   * Called by Hydra when execution starts.
   */
  async startJob(jobId: string): Promise<void> {
    const db = getDb();
    
    await db.query(`
      UPDATE research_jobs
      SET status = 'running',
          started_at = NOW()
      WHERE id = $1 AND status = 'scheduled'
    `, [jobId]);
    
    console.log(`[research] Started job ${jobId}`);
  }

  /**
   * Complete a job with results.
   * Called by Hydra when research succeeds.
   *
   * For research_profile jobs: automatically syncs followers_count, posts_count, etc.
   * into accounts.metrics so Marketer always sees fresh data without a separate scan.
   */
  async completeJob(jobId: string, output: Record<string, unknown>): Promise<void> {
    const db = getDb();

    // Fetch job to know type + input (for account sync)
    const jobRow = await db.query(`
      SELECT job_type, input FROM research_jobs WHERE id = $1
    `, [jobId]);

    await db.query(`
      UPDATE research_jobs
      SET status = 'completed',
          output = $2::jsonb,
          completed_at = NOW(),
          expires_at = NOW() + INTERVAL '7 days',
          error = NULL
      WHERE id = $1 AND status IN ('pending', 'scheduled', 'running')
    `, [jobId, JSON.stringify(output)]);

    console.log(`[research] Completed job ${jobId}`);

    // ── Sync profile data → accounts.metrics ─────────────────────────────────
    // When a research_profile job completes, push the fresh data into the
    // accounts table so Marketer doesn't see stale 0/0 metrics.
    if (jobRow.rows.length > 0 && jobRow.rows[0].job_type === 'research_profile') {
      const input = jobRow.rows[0].input as Record<string, unknown>;
      const username = String(input.username || '').toLowerCase().replace(/^@/, '');

      if (username) {
        try {
          const metricsUpdate = {
            followers_count: output.followers_count ?? null,
            followers:       output.followers_count ?? null,
            following_count: output.following_count ?? null,
            following:       output.following_count ?? null,
            posts_count:     output.posts_count ?? null,
            posts:           output.posts_count ?? null,
            bio:             output.bio ?? null,
            is_verified:     output.is_verified ?? false,
            is_private:      output.is_private ?? false,
            _last_scan_at:   new Date().toISOString(),
            _source:         'research_profile',
          };

          // Merge with existing metrics (don't overwrite keys not present in research output)
          await db.query(`
            UPDATE accounts
            SET metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
                updated_at = NOW()
            WHERE LOWER(username) = $2
          `, [JSON.stringify(metricsUpdate), username]);

          console.log(`[research] Synced profile metrics → accounts for @${username}: ` +
            `${output.followers_count ?? '?'} followers, ${output.posts_count ?? '?'} posts`);
        } catch (err) {
          // Non-fatal: research is saved, account sync failed — Marketer will self-scan next run
          console.warn(`[research] Failed to sync metrics for @${username}:`, (err as Error).message);
        }
      }
    }
  }

  /**
   * Fail a job with error.
   * Called by Hydra when research fails.
   */
  async failJob(jobId: string, error: string): Promise<void> {
    const db = getDb();
    
    await db.query(`
      UPDATE research_jobs
      SET status = 'failed',
          error = $2,
          completed_at = NOW()
      WHERE id = $1 AND status IN ('scheduled', 'running')
    `, [jobId, error]);
    
    console.log(`[research] Failed job ${jobId}: ${error}`);
  }

  /**
   * Get job by ID.
   */
  async getJob(jobId: string): Promise<ResearchJob | null> {
    const db = getDb();
    
    const result = await db.query(`
      SELECT * FROM research_jobs WHERE id = $1
    `, [jobId]);
    
    if (result.rows.length === 0) return null;
    return this.rowToJob(result.rows[0]);
  }

  /**
   * Cleanup expired completed jobs.
   * Called periodically (cron or startup).
   */
  async cleanupExpired(): Promise<number> {
    const db = getDb();
    
    const result = await db.query(`
      DELETE FROM research_jobs
      WHERE status = 'completed'
        AND expires_at < NOW()
      RETURNING id
    `);
    
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[research] Cleaned up ${count} expired jobs`);
    }
    return count;
  }

  /**
   * Reset stuck jobs (running for > 1 hour).
   * Called periodically to recover from crashes.
   */
  async resetStuckJobs(): Promise<number> {
    const db = getDb();
    
    const result = await db.query(`
      UPDATE research_jobs
      SET status = 'pending',
          device_id = NULL,
          scheduled_at = NULL,
          started_at = NULL
      WHERE status IN ('scheduled', 'running')
        AND (
          (scheduled_at IS NOT NULL AND scheduled_at < NOW() - INTERVAL '1 hour')
          OR (started_at IS NOT NULL AND started_at < NOW() - INTERVAL '1 hour')
        )
      RETURNING id
    `);
    
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[research] Reset ${count} stuck jobs`);
    }
    return count;
  }

  /**
   * Get queue stats for monitoring.
   */
  async getStats(): Promise<Record<string, number>> {
    const db = getDb();
    
    const result = await db.query(`
      SELECT status, COUNT(*) as count
      FROM research_jobs
      GROUP BY status
    `);
    
    const stats: Record<string, number> = {
      pending: 0,
      scheduled: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    
    for (const row of result.rows) {
      stats[row.status] = parseInt(row.count);
    }
    
    return stats;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private normalizeInput(type: ResearchJobType, input: Record<string, unknown>): Record<string, unknown> {
    switch (type) {
      case 'research_profile':
        return {
          username: String(input.username || '').toLowerCase().replace(/^@/, ''),
        };
      case 'research_hashtag':
        return {
          hashtag: String(input.hashtag || '').toLowerCase().replace(/^#/, ''),
          limit: input.limit ?? 50,
        };
      case 'research_followers':
        return {
          username: String(input.username || '').toLowerCase().replace(/^@/, ''),
          limit: input.limit ?? 100,
        };
      default:
        return input;
    }
  }

  private rowToJob(row: Record<string, unknown>): ResearchJob {
    return {
      id: row.id as string,
      jobType: row.job_type as ResearchJobType,
      input: row.input as Record<string, unknown>,
      output: row.output as Record<string, unknown> | null,
      status: row.status as ResearchJobStatus,
      priority: row.priority as number,
      deviceId: row.device_id as string | null,
      error: row.error as string | null,
      expiresAt: row.expires_at as Date | null,
      createdAt: row.created_at as Date,
      scheduledAt: row.scheduled_at as Date | null,
      startedAt: row.started_at as Date | null,
      completedAt: row.completed_at as Date | null,
    };
  }
}

export const researchService = new ResearchService();
