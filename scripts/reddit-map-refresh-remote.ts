#!/usr/bin/env tsx
/**
 * Remote Reddit app-map refresh gate.
 *
 * Uses the deployed Phone Network API only. It never prints the API token.
 *
 * Required:
 *   PHONE_NETWORK_BASE_URL=https://<remote-phone-network>
 *
 * Optional:
 *   PHONE_NETWORK_API_TOKEN=<token>
 *   PHONE_NETWORK_TOKEN_FILE=/data/.openclaw/credentials/phone-network-api-token.json
 *   DEVICE_ID=d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd
 *   --start   start /api/mapping/start and poll /api/mapping/status
 */

import fs from "fs/promises";

const APP_ID = "com.reddit.frontpage";
const DEFAULT_TOKEN_FILE = "/data/.openclaw/credentials/phone-network-api-token.json";

async function loadToken(): Promise<string> {
  if (process.env.PHONE_NETWORK_API_TOKEN) return process.env.PHONE_NETWORK_API_TOKEN;

  const tokenFile = process.env.PHONE_NETWORK_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  const raw = await fs.readFile(tokenFile, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const token = parsed.token ?? parsed.apiToken ?? parsed.apiKey ?? parsed.key;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(`No token/apiToken/apiKey/key string found in ${tokenFile}`);
  }
  return token;
}

async function api<T>(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "X-API-Key": token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function pollStatus(baseUrl: string, token: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < 120; i += 1) {
    const status = await api<Record<string, unknown>>(baseUrl, token, "/api/mapping/status");
    last = status;
    if (status.status !== "running" && status.status !== "stopping") return status;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return last;
}

async function main(): Promise<void> {
  const baseUrl = process.env.PHONE_NETWORK_BASE_URL?.replace(/\/+$/, "");
  const deviceId = process.env.DEVICE_ID ?? "d35b34cb-b2ee-4f6e-a8c6-a72cca14a0dd";
  const shouldStart = process.argv.includes("--start");

  if (!baseUrl) {
    throw new Error("PHONE_NETWORK_BASE_URL is required");
  }

  const token = await loadToken();
  const health = await api<{ appVersion?: string | null; buildCommit?: string | null }>(baseUrl, token, "/api/health");
  const before = await api<Record<string, unknown>>(baseUrl, token, `/api/mapping/${APP_ID}/quality`).catch((err) => ({
    ok: false,
    error: (err as Error).message,
  }));

  let refresh: Record<string, unknown> | null = null;
  let after = before;
  if (shouldStart) {
    refresh = await api<Record<string, unknown>>(baseUrl, token, "/api/mapping/start", {
      method: "POST",
      body: JSON.stringify({ deviceId, appId: APP_ID, appName: "Reddit" }),
    });
    await pollStatus(baseUrl, token);
    after = await api<Record<string, unknown>>(baseUrl, token, `/api/mapping/${APP_ID}/quality`);
  }

  console.log(JSON.stringify({
    ok: true,
    appId: APP_ID,
    deviceId: `${deviceId.slice(0, 8)}...`,
    live: {
      appVersion: health.appVersion ?? null,
      buildCommit: health.buildCommit ?? null,
    },
    refreshStarted: shouldStart,
    startResponse: refresh,
    before,
    after,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
  process.exit(1);
});
