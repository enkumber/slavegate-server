/**
 * observability/alerts.ts
 * Telegram webhook alerting for critical events.
 *
 * Alerts sent for:
 *   - Device offline (immediate)
 *   - Account banned
 *   - Parser confidence degraded (< 50% success rate in 1h window)
 *   - OTA deployment failure
 *   - Server resources critical (CPU > 90%, memory > 85%)
 *   - VLM API error rate spike
 *
 * Config: ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID in .env
 * Cooldown: same alert type + entity deduped for 15min (avoid spam).
 *
 * Usage:
 *   await alerting.send(AlertType.DEVICE_OFFLINE, { deviceId, location })
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export enum AlertType {
  DEVICE_OFFLINE     = "DEVICE_OFFLINE",
  DEVICE_RECONNECTED = "DEVICE_RECONNECTED",
  ACCOUNT_BANNED     = "ACCOUNT_BANNED",
  ACCOUNT_CHALLENGED = "ACCOUNT_CHALLENGED",
  PARSER_DEGRADED    = "PARSER_DEGRADED",
  OTA_FAILED         = "OTA_FAILED",
  SERVER_RESOURCES   = "SERVER_RESOURCES",
  VLM_ERROR_SPIKE    = "VLM_ERROR_SPIKE",
  KILL_SWITCH        = "KILL_SWITCH",
}

type AlertPayload = Record<string, string | number | boolean | null | undefined>;

// ─── Alerting service ─────────────────────────────────────────────────────────

class AlertingService {
  private readonly botToken: string | null;
  private readonly chatId:   string | null;
  private readonly enabled:  boolean;
  private readonly COOLDOWN_S = 15 * 60;  // 15 min in seconds (Redis TTL)

  // I3 fix: cooldowns in Redis (survives restarts) — lazy import to avoid circular dep
  private async getCooldownKey(dedupeKey: string): Promise<boolean> {
    try {
      const { getRedis } = await import("../../redis/client");
      const redis = getRedis();
      const exists = await redis.get(`alert_cooldown:${dedupeKey}`);
      return exists !== null;
    } catch {
      return false;  // Redis unavailable — allow alert through
    }
  }

  private async setCooldown(dedupeKey: string): Promise<void> {
    try {
      const { getRedis } = await import("../../redis/client");
      const redis = getRedis();
      await redis.set(`alert_cooldown:${dedupeKey}`, "1", "EX", this.COOLDOWN_S);
    } catch {
      // Non-fatal — worst case: duplicate alert
    }
  }

  constructor() {
    this.botToken = process.env.ALERT_TELEGRAM_BOT_TOKEN ?? null;
    this.chatId   = process.env.ALERT_TELEGRAM_CHAT_ID  ?? null;
    this.enabled  = !!(this.botToken && this.chatId);
    if (!this.enabled) {
      console.warn("[alerts] Telegram alerting disabled — set ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID");
    }
  }

  async send(type: AlertType, payload: AlertPayload): Promise<void> {
    if (!this.enabled) return;

    // I3 fix: cooldowns in Redis — survive restarts, no duplicate storms after deploy
    const dedupeKey = `${type}:${payload.deviceId ?? payload.accountId ?? payload.platform ?? "global"}`;
    if (await this.getCooldownKey(dedupeKey)) return;
    await this.setCooldown(dedupeKey);

    const text = this.format(type, payload);
    await this.sendTelegram(text);
  }

  // ─── Convenience methods ─────────────────────────────────────────────────

  async deviceOffline(deviceId: string, location: string): Promise<void> {
    await this.send(AlertType.DEVICE_OFFLINE, { deviceId, location });
  }

  async deviceReconnected(deviceId: string, offlineMs: number): Promise<void> {
    await this.send(AlertType.DEVICE_RECONNECTED, { deviceId, offlineMs });
  }

  async accountBanned(accountId: string, platform: string, reason: string): Promise<void> {
    await this.send(AlertType.ACCOUNT_BANNED, { accountId, platform, reason });
  }

  async accountChallenged(accountId: string, platform: string, reason: string): Promise<void> {
    await this.send(AlertType.ACCOUNT_CHALLENGED, { accountId, platform, reason });
  }

  async parserDegraded(platform: string, successRate: number): Promise<void> {
    await this.send(AlertType.PARSER_DEGRADED, { platform, successRate: Math.round(successRate * 100) });
  }

  async otaFailed(deploymentId: string, deviceId: string, error: string): Promise<void> {
    await this.send(AlertType.OTA_FAILED, { deploymentId, deviceId, error });
  }

  async killSwitch(initiatedBy: string): Promise<void> {
    await this.send(AlertType.KILL_SWITCH, { initiatedBy });
  }

  // ─── Format messages ─────────────────────────────────────────────────────

  private format(type: AlertType, p: AlertPayload): string {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    switch (type) {
      case AlertType.DEVICE_OFFLINE:
        return `🔴 *Device Offline*\nDevice: \`${p.deviceId}\`\nLocation: ${p.location}\n_${ts}_`;
      case AlertType.DEVICE_RECONNECTED:
        return `🟢 *Device Reconnected*\nDevice: \`${p.deviceId}\`\nWas offline: ${Math.round(Number(p.offlineMs) / 60_000)}min\n_${ts}_`;
      case AlertType.ACCOUNT_BANNED:
        return `🚫 *Account Banned*\nPlatform: ${p.platform}\nAccount: \`${p.accountId}\`\nReason: ${p.reason}\n_${ts}_`;
      case AlertType.ACCOUNT_CHALLENGED:
        return `⚠️ *Account Challenged*\nPlatform: ${p.platform}\nAccount: \`${p.accountId}\`\nReason: ${p.reason}\n_${ts}_`;
      case AlertType.PARSER_DEGRADED:
        return `📉 *Parser Degraded*\nPlatform: ${p.platform}\nSuccess rate: ${p.successRate}%\n_${ts}_`;
      case AlertType.OTA_FAILED:
        return `💥 *OTA Failed*\nDeployment: \`${p.deploymentId}\`\nDevice: \`${p.deviceId}\`\nError: ${p.error}\n_${ts}_`;
      case AlertType.SERVER_RESOURCES:
        return `⚡ *Server Resources Critical*\nCPU: ${p.cpu}%\nMemory: ${p.memory}%\n_${ts}_`;
      case AlertType.VLM_ERROR_SPIKE:
        return `🤖 *VLM Error Spike*\nProvider: ${p.provider}\nError rate: ${p.errorRate}%\n_${ts}_`;
      case AlertType.KILL_SWITCH:
        return `🛑 *KILL SWITCH ACTIVATED*\nInitiated by: ${p.initiatedBy}\nAll workflows suspended.\n_${ts}_`;
      default:
        return `ℹ️ *Alert: ${type}*\n\`${JSON.stringify(p)}\`\n_${ts}_`;
    }
  }

  private async sendTelegram(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    try {
      const url  = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const body = JSON.stringify({ chat_id: this.chatId, text, parse_mode: "Markdown" });
      const resp = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal:  AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        console.error("[alerts] Telegram API error:", resp.status, await resp.text());
      }
    } catch (err) {
      // Non-fatal — alerting failure must not break main flow
      console.error("[alerts] Failed to send Telegram alert:", (err as Error).message);
    }
  }
}

export const alerting = new AlertingService();
