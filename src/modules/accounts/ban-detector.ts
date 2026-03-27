/**
 * modules/accounts/ban-detector.ts
 * Pattern matching on JOB_RESULT to detect account bans, challenges, rate limits.
 *
 * Strategy:
 * - Inspect job result payload for error codes, redirects, blocked action signals
 * - VLM "detect_challenge" prompt result → immediate flag
 * - Pattern matching on command output (JSON) — platform-specific signatures
 * - Escalation: challenge → needs manual review; banned → terminal
 *
 * Called from ws.server.ts handleJobResult() after every job completes.
 *
 * Reference: ARCHITECTURE_AUDIT_v3.md §7 (Account Management)
 */

import { accountsService } from "./accounts.service";
import { lifecycleManager } from "./lifecycle";

// ─── Detection patterns ───────────────────────────────────────────────────────

interface DetectionSignal {
  type: "banned" | "challenged" | "rate_limited";
  reason: string;
  confidence: number;
}

// Platform-specific error signatures
const PLATFORM_SIGNALS: Record<string, Array<{ pattern: RegExp; signal: DetectionSignal }>> = {
  instagram: [
    { pattern: /action_blocked|blocked_actions|your account has been disabled/i,
      signal: { type: "banned",       reason: "Action blocked — account disabled",          confidence: 0.95 } },
    { pattern: /verify your account|confirm your identity|suspicious activity/i,
      signal: { type: "challenged",   reason: "Identity verification required",              confidence: 0.9  } },
    { pattern: /try again later|please wait a few minutes|too many requests/i,
      signal: { type: "rate_limited", reason: "Instagram rate limit detected",               confidence: 0.8  } },
    { pattern: /login required|you've been logged out|session expired/i,
      signal: { type: "challenged",   reason: "Session expired — re-login required",         confidence: 0.85 } },
  ],
  tiktok: [
    { pattern: /account has been banned|community guidelines violation/i,
      signal: { type: "banned",       reason: "TikTok ban — community guidelines violation", confidence: 0.95 } },
    { pattern: /unusual activity|captcha|verify|phone number/i,
      signal: { type: "challenged",   reason: "TikTok verification challenge",                confidence: 0.85 } },
    { pattern: /too frequent|slow down|limit reached/i,
      signal: { type: "rate_limited", reason: "TikTok rate limit",                           confidence: 0.75 } },
  ],
  reddit: [
    { pattern: /permanently suspended|account suspended|banned from/i,
      signal: { type: "banned",       reason: "Reddit account suspended",                    confidence: 0.95 } },
    { pattern: /you've been shadowbanned|posts not visible/i,
      signal: { type: "banned",       reason: "Reddit shadowban detected",                   confidence: 0.8  } },
    { pattern: /verify email|verify your account|captcha required/i,
      signal: { type: "challenged",   reason: "Reddit verification required",                confidence: 0.85 } },
    { pattern: /you are doing that too much|ratelimit|try again in/i,
      signal: { type: "rate_limited", reason: "Reddit rate limit",                           confidence: 0.75 } },
  ],
};

// Generic cross-platform patterns (lower confidence)
const GENERIC_SIGNALS: Array<{ pattern: RegExp; signal: DetectionSignal }> = [
  { pattern: /login required|please log in|session expired/i,
    signal: { type: "challenged",   reason: "Session expired",                               confidence: 0.7  } },
  { pattern: /account disabled|account banned|permanently banned/i,
    signal: { type: "banned",       reason: "Account ban detected",                          confidence: 0.8  } },
  { pattern: /captcha|verify you're human|prove you're not a robot/i,
    signal: { type: "challenged",   reason: "CAPTCHA challenge",                             confidence: 0.85 } },
];

// ─── BanDetector ─────────────────────────────────────────────────────────────

export class BanDetector {
  /**
   * Analyze a completed job result for ban/challenge/rate-limit signals.
   * Called after every JOB_RESULT in ws.server.ts.
   *
   * @param accountId   Account that executed the job (null → skip detection)
   * @param platform    "instagram" | "tiktok" | "reddit" | ...
   * @param jobResult   Raw job result payload (JSON)
   */
  async analyze(
    accountId:  string | null,
    platform:   string,
    jobResult:  Record<string, unknown>
  ): Promise<DetectionSignal | null> {
    if (!accountId) return null;

    const signal = this.detectSignal(platform, jobResult);
    if (!signal) return null;

    // Only act if confidence is high enough
    if (signal.confidence < 0.7) {
      console.warn(`[ban-detector] Low-confidence signal (${signal.confidence}) for ${accountId}: ${signal.reason}`);
      return signal;
    }

    await this.applySignal(accountId, signal);
    return signal;
  }

  private detectSignal(
    platform:  string,
    jobResult: Record<string, unknown>
  ): DetectionSignal | null {
    // Scan only semantic error fields — NOT full JSON (URLs in output trigger false positives)
    const output = jobResult.output as Record<string, unknown> | undefined;
    const verification = jobResult.verification as Record<string, unknown> | undefined;
    const candidates = [
      jobResult.error,
      jobResult.errorCode,
      output?.errorMessage,
      output?.toastMessage,
      output?.errorCode,
      output?.redirectUrl,   // intentional: redirect to /verify is a real signal
      verification?.note,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ");
    const textToScan = candidates.toLowerCase();

    // Platform-specific patterns first (higher specificity)
    const platformPatterns = PLATFORM_SIGNALS[platform.toLowerCase()] ?? [];
    for (const { pattern, signal } of platformPatterns) {
      if (pattern.test(textToScan)) {
        return signal;
      }
    }

    // Generic patterns as fallback
    for (const { pattern, signal } of GENERIC_SIGNALS) {
      if (pattern.test(textToScan)) {
        return signal;
      }
    }

    return null;
  }

  private async applySignal(accountId: string, signal: DetectionSignal): Promise<void> {
    const account = await accountsService.get(accountId);
    if (!account) return;

    // Skip if already in a terminal/challenged state
    if (account.status === "banned") return;

    switch (signal.type) {
      case "banned":
        await accountsService.markBanned(accountId, signal.reason);
        console.warn(`[ban-detector] 🚨 Account ${accountId} BANNED: ${signal.reason}`);
        break;

      case "challenged":
        if (account.status !== "challenged") {
          await accountsService.flagChallenged(accountId, signal.reason);
          console.warn(`[ban-detector] ⚠️ Account ${accountId} CHALLENGED: ${signal.reason}`);
        }
        break;

      case "rate_limited":
        if (account.status === "active" || account.status === "warming_up") {
          // Cooldown: 1-4h (random within range to avoid synchronized behavior)
          const cooldownMs = (60 + Math.random() * 180) * 60_000;
          await lifecycleManager.startRateLimitCooldown(accountId, cooldownMs);
          console.warn(`[ban-detector] ⏱️ Account ${accountId} rate limited — cooldown ${Math.round(cooldownMs / 60_000)}min`);
        }
        break;
    }
  }
}

export const banDetector = new BanDetector();
