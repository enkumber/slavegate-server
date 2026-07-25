import { getDb } from "../../db/client";
import { accountsService } from "./accounts.service";
import { lifecycleManager } from "./lifecycle";
import { resourceLifecycleStateMatches } from "../lifecycle/lifecycle.service";

interface DetectionSignal {
  type: "banned" | "challenged" | "rate_limited";
  reason: string;
  confidence: number;
}

interface DetectionRule {
  pattern: string;
  flags: string;
  signal: DetectionSignal;
}

function isDetectionSignal(value: unknown): value is DetectionSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.type === "banned" || candidate.type === "challenged" || candidate.type === "rate_limited")
    && typeof candidate.reason === "string"
    && typeof candidate.confidence === "number"
    && candidate.confidence >= 0
    && candidate.confidence <= 1
  );
}

function parseRule(row: Record<string, unknown>): DetectionRule | null {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.pattern !== "string" || !isDetectionSignal(record.signal)) return null;
  return {
    pattern: record.pattern,
    flags: typeof record.flags === "string" ? record.flags : "i",
    signal: record.signal,
  };
}

function semanticErrorText(jobResult: Record<string, unknown>): string {
  const output = jobResult.output as Record<string, unknown> | undefined;
  const verification = jobResult.verification as Record<string, unknown> | undefined;
  return [
    jobResult.error,
    jobResult.errorCode,
    output?.errorMessage,
    output?.toastMessage,
    output?.errorCode,
    output?.redirectUrl,
    verification?.note,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export class BanDetector {
  async analyze(
    accountId: string | null,
    platform: string,
    jobResult: Record<string, unknown>,
  ): Promise<DetectionSignal | null> {
    if (!accountId) return null;
    const signal = await this.detectSignal(platform, jobResult);
    if (!signal) return null;
    if (signal.confidence < 0.7) {
      console.warn(`[account-signal] Low-confidence signal (${signal.confidence}) for ${accountId}: ${signal.reason}`);
      return signal;
    }
    await this.applySignal(accountId, signal);
    return signal;
  }

  private async detectSignal(
    platform: string,
    jobResult: Record<string, unknown>,
  ): Promise<DetectionSignal | null> {
    const result = await getDb().query<Record<string, unknown>>(
      `SELECT payload
       FROM runtime_semantic_entries
       WHERE namespace = 'account_detection_rule'
         AND lifecycle_state_matches(
               'runtime_semantic_entries'::regclass,
               status,
               '{"dispatchable":true}'::jsonb
             )
         AND (platform = $1 OR platform = '*')
       ORDER BY CASE WHEN platform = $1 THEN 0 ELSE 1 END, priority DESC, entry_key`,
      [platform.trim().toLowerCase()],
    );
    const text = semanticErrorText(jobResult);
    for (const row of result.rows) {
      const rule = parseRule(row);
      if (!rule) continue;
      try {
        if (new RegExp(rule.pattern, rule.flags).test(text)) return rule.signal;
      } catch (error) {
        console.warn(`[account-signal] Ignoring invalid PostgreSQL rule: ${(error as Error).message}`);
      }
    }
    return null;
  }

  private async applySignal(accountId: string, signal: DetectionSignal): Promise<void> {
    const account = await accountsService.get(accountId);
    if (!account || await resourceLifecycleStateMatches("accounts", account.status, { terminal: true })) return;
    if (signal.type === "banned") {
      await accountsService.markBanned(accountId, signal.reason);
      return;
    }
    if (signal.type === "challenged") {
      if (!await resourceLifecycleStateMatches("accounts", account.status, { manual: true, terminal: false })) {
        await accountsService.flagChallenged(accountId, signal.reason);
      }
      return;
    }
    if (await resourceLifecycleStateMatches("accounts", account.status, { dispatchable: true })) {
      const cooldownMs = (60 + Math.random() * 180) * 60_000;
      await lifecycleManager.startRateLimitCooldown(accountId, cooldownMs);
    }
  }
}

export const banDetector = new BanDetector();
