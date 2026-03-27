/**
 * modules/accounts/lifecycle.ts
 * Account lifecycle state machine.
 *
 * States:
 *   created → warming_up (first session)
 *   warming_up → active (after 14 days)
 *   active ↔ paused (manual or automated)
 *   active → rate_limited (rate limit detected) → active (after cooldown)
 *   any → challenged (CAPTCHA/verify detected)
 *   any → banned (terminal)
 *
 * Cooldown schedules:
 *   rate_limited: 1-4h random (per platform defaults, configurable)
 *   paused: until manually resumed
 *
 * Usage: called by accountsService + ban-detector
 */

import { accountsService, type AccountStatus } from "./accounts.service";
import { getDb } from "../../db/client";

// ─── Transition map ───────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  created:      ["warming_up", "banned"],
  warming_up:   ["active", "paused", "challenged", "banned"],
  active:       ["paused", "rate_limited", "challenged", "banned"],
  paused:       ["active", "banned"],
  rate_limited: ["active", "paused", "banned"],
  challenged:   ["active", "paused", "banned"],
  banned:       [],  // terminal
};

export class AccountLifecycleManager {

  /**
   * Transition account to a new status.
   * Validates transition is allowed before applying.
   *
   * @throws if transition is not allowed or account doesn't exist
   */
  async transition(
    accountId: string,
    to:        AccountStatus,
    reason?:   string
  ): Promise<void> {
    const account = await accountsService.get(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    const allowed = ALLOWED_TRANSITIONS[account.status] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid transition ${account.status} → ${to} for account ${accountId}`
      );
    }

    await accountsService.updateStatus(accountId, to, reason);
  }

  /**
   * Start a cooldown period after rate limiting.
   * Stores `rate_limit_until` in DB — survives server restart.
   * Recovery: `resumeExpiredRateLimits()` called by BullMQ repeatable job (every 5min).
   *
   * @param accountId
   * @param cooldownMs  Default: 2 hours (platforms vary)
   */
  async startRateLimitCooldown(accountId: string, cooldownMs = 2 * 3600_000): Promise<void> {
    await this.transition(accountId, "rate_limited", `Rate limited — cooldown ${Math.round(cooldownMs / 60_000)}min`);
    // Persist expiry in DB — recoverable after server restart (no more setTimeout)
    const rateLimitUntil = new Date(Date.now() + cooldownMs);
    const db = getDb();
    await db.query(
      "UPDATE accounts SET rate_limit_until = $1 WHERE id = $2",
      [rateLimitUntil, accountId]
    );
  }

  /**
   * Resume accounts whose rate limit cooldown has expired.
   * Called by BullMQ repeatable job every 5 minutes — survives restarts.
   */
  async resumeExpiredRateLimits(): Promise<number> {
    const db = getDb();
    const result = await db.query(
      `UPDATE accounts
       SET status = 'active', rate_limit_until = NULL, notes = 'Rate limit cooldown expired'
       WHERE status = 'rate_limited'
         AND rate_limit_until IS NOT NULL
         AND rate_limit_until < NOW()
       RETURNING id`
    );
    const resumed = result.rowCount ?? 0;
    if (resumed > 0) {
      console.log(`[lifecycle] Resumed ${resumed} rate-limited accounts`);
    }
    return resumed;
  }

  /**
   * Promote all warming_up accounts older than 14 days to active.
   * Called by daily cron job.
   */
  async runWarmupPromotion(): Promise<number> {
    return accountsService.promoteWarmupAccounts();
  }

  /**
   * Get accounts due for session (active + warming_up, ordered by last_active ASC).
   * Oldest-last-active first — fair rotation.
   */
  async getAccountsReadyForSession(platform?: string) {
    return accountsService.getWorkableAccounts(platform);
  }

  /**
   * Validate if transition is allowed without applying it.
   */
  canTransition(from: AccountStatus, to: AccountStatus): boolean {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
  }
}

export const lifecycleManager = new AccountLifecycleManager();
