/**
 * nostr/adapter.ts
 * Bridge layer — replaces wsServer calls with NostrPhoneClient.
 *
 * Usage: import { nostrAdapter } from "../nostr/adapter";
 *        await nostrAdapter.sendJob(deviceId, job);
 */

import { NostrPhoneClient } from "./client";
import { DeviceRegistry } from "./device-registry";
import { MessageRouter } from "./message-router";
import { loadOrGenerateServerKeys } from "./keys";
import { getDb } from "../db/client";
import { createHandlers } from "./handlers";

// Singleton instances
let _client: NostrPhoneClient | null = null;
let _registry: DeviceRegistry | null = null;
let _adapter: NostrAdapterImpl | null = null;

export interface NostrAdapter {
  // Lifecycle
  connect(): Promise<void>;
  close(): Promise<void>;

  // Device status (replaces wsServer.isDeviceConnected)
  isDeviceOnline(deviceId: string): boolean;
  getOnlineDeviceIds(): string[];

  // Job dispatch (replaces wsServer.sendJob)
  sendJob(deviceId: string, job: JobPayload): Promise<void>;

  // Job dispatch with timeout (awaits result)
  sendJobWithTimeout(deviceId: string, job: JobPayload, timeoutMs?: number): Promise<unknown>;

  // Kill switch (replaces wsServer.sendKillSwitch)
  sendKillSwitch(deviceId: string, reason: string): Promise<void>;
  sendKillSwitchAll(reason: string): Promise<void>;

  // OTA (replaces wsServer.broadcastOta)
  broadcastOta(payload: OtaPayload, deviceIds?: string[]): Promise<number>;

  // Config push (new)
  sendConfigPush(deviceId: string, config: Record<string, unknown>): Promise<void>;

  // Revoked (replaces wsServer.sendRevoked — maps to DEVICE_REJECT)
  sendRevoked(deviceId: string): Promise<void>;

  // Device ACK (for DEVICE_HELLO responses)
  sendDeviceAck(deviceId: string, status: "approved" | "pending"): Promise<void>;

  // Get pubkey for a deviceId
  getDevicePubkey(deviceId: string): string | null;

  // Get server pubkey (for dashboard display)
  getServerPubkey(): string;

  // Resolve a pending job (called from handlers when JOB_RESULT arrives)
  resolveJob(jobId: string, result: unknown, success: boolean): void;
}

export interface JobPayload {
  type: string;
  [key: string]: unknown;
}

export interface OtaPayload {
  version: string;
  versionCode: number;
  apkUrl: string;
  apkSha256: string;
  apkSignature: string;
  mandatory?: boolean;
}

// ─── Pending Jobs (T3: Job Timeout Handler) ─────────────────────────────────

interface PendingJob {
  deviceId: string;
  jobId: string;
  createdAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// ─── Implementation ─────────────────────────────────────────────────────────

class NostrAdapterImpl implements NostrAdapter {
  private pendingJobs = new Map<string, PendingJob>();
  private readonly DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private client: NostrPhoneClient,
    private registry: DeviceRegistry
  ) {}

  async connect(): Promise<void> {
    await this.registry.loadFromDb();
    await this.client.connect();
  }

  async close(): Promise<void> {
    // Clear all pending jobs
    for (const [jobId, pending] of this.pendingJobs) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Adapter closed, job ${jobId} cancelled`));
    }
    this.pendingJobs.clear();
    await this.client.close();
  }

  isDeviceOnline(deviceId: string): boolean {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) return false;
    return this.registry.isOnline(pubkey);
  }

  getOnlineDeviceIds(): string[] {
    return this.registry.getOnlineDeviceIds();
  }

  async sendJob(deviceId: string, job: JobPayload): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      throw new Error(`Device ${deviceId} not registered (no pubkey)`);
    }
    if (!this.registry.isOnline(pubkey)) {
      throw new Error(`Device ${deviceId} is offline`);
    }
    // Use job.jobId if provided (from dispatcher), otherwise generate new
    const jobId = (job as any).jobId ?? crypto.randomUUID();
    await this.client.publishJob(pubkey, jobId, job);
  }

  async sendJobWithTimeout(
    deviceId: string,
    job: JobPayload,
    timeoutMs?: number
  ): Promise<unknown> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      throw new Error(`Device ${deviceId} not registered`);
    }
    if (!this.registry.isOnline(pubkey)) {
      throw new Error(`Device ${deviceId} offline`);
    }

    const jobId = crypto.randomUUID();
    const timeout = timeoutMs ?? this.DEFAULT_JOB_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        reject(new Error(`Job ${jobId} timed out after ${timeout / 1000}s`));
      }, timeout);

      this.pendingJobs.set(jobId, {
        deviceId,
        jobId,
        createdAt: Date.now(),
        timer,
        resolve,
        reject,
      });

      this.client.publishJob(pubkey, jobId, job).catch((err) => {
        clearTimeout(timer);
        this.pendingJobs.delete(jobId);
        reject(err);
      });
    });
  }

  async sendKillSwitch(deviceId: string, reason: string): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      console.warn(
        `[nostr:adapter] Kill switch: device ${deviceId} not registered`
      );
      return;
    }
    await this.client.publishKillSwitch(pubkey, reason);
  }

  async sendKillSwitchAll(reason: string): Promise<void> {
    const onlinePubkeys = this.registry.getOnlineDevices();
    await Promise.all(
      onlinePubkeys.map((pk) => this.client.publishKillSwitch(pk, reason))
    );
  }

  async broadcastOta(
    payload: OtaPayload,
    deviceIds?: string[]
  ): Promise<number> {
    let pubkeys: string[];
    if (deviceIds && deviceIds.length > 0) {
      pubkeys = deviceIds
        .map((id) => this.registry.lookupPubkey(id))
        .filter((pk): pk is string => pk !== null);
    } else {
      pubkeys = this.registry.getOnlineDevices();
    }

    await Promise.all(pubkeys.map((pk) => this.client.publishOta(pk, payload)));
    return pubkeys.length;
  }

  async sendConfigPush(
    deviceId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      throw new Error(`Device ${deviceId} not registered`);
    }
    await this.client.publishConfigPush(pubkey, config);
  }

  async sendRevoked(deviceId: string): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) return;
    await this.client.publishDeviceReject(pubkey, "Device access revoked");
  }

  async sendDeviceAck(
    deviceId: string,
    status: "approved" | "pending"
  ): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      throw new Error(`Device ${deviceId} not registered`);
    }
    await this.client.publishDeviceAck(pubkey, status, deviceId);
  }

  getDevicePubkey(deviceId: string): string | null {
    return this.registry.lookupPubkey(deviceId);
  }

  getServerPubkey(): string {
    return this.client.publicKey;
  }

  // ─── T3: Job Timeout Handler — resolve pending job ────────────────────────

  resolveJob(jobId: string, result: unknown, success: boolean): void {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) {
      console.warn(`[nostr:adapter] JOB_RESULT for unknown job ${jobId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingJobs.delete(jobId);

    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(String(result)));
    }
  }

  /**
   * Register a waiter for a job result. Used by waitForJobResult() in hydra-routes.
   * Returns a promise that resolves when resolveJob() is called for this jobId.
   */
  registerWaiter(jobId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        reject(new Error(`Job ${jobId} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingJobs.set(jobId, {
        deviceId: "waiter",
        jobId,
        createdAt: Date.now(),
        timer,
        resolve,
        reject,
      });
    });
  }

  // ─── Internals (expose for handlers) ──────────────────────────────────────

  getClient(): NostrPhoneClient {
    return this.client;
  }

  getRegistry(): DeviceRegistry {
    return this.registry;
  }
}

// ─── Factory function ───────────────────────────────────────────────────────

export async function createNostrAdapter(): Promise<NostrAdapter> {
  const relayUrls = getRelayUrls();
  const { sk } = await loadOrGenerateServerKeys();
  const db = getDb();

  const registry = new DeviceRegistry(db);
  const router = new MessageRouter(sk);

  // Wire handlers (T2)
  const handlers = createHandlers(registry, sk);
  router.setHandlers(handlers);

  const client = new NostrPhoneClient(sk, relayUrls, registry, router);

  _client = client;
  _registry = registry;
  _adapter = new NostrAdapterImpl(client, registry);

  return _adapter;
}

function getRelayUrls(): string[] {
  const primary = process.env.NOSTR_RELAY_PRIMARY;
  const secondary = process.env.NOSTR_RELAY_SECONDARY;

  if (!primary) {
    throw new Error("NOSTR_RELAY_PRIMARY env var is required");
  }

  const urls = [primary];
  if (secondary) urls.push(secondary);
  const publicRelay = process.env.NOSTR_RELAY_PUBLIC;
  if (publicRelay) urls.push(publicRelay);
  return urls;
}

// ─── Singleton getters ──────────────────────────────────────────────────────

/**
 * Get the singleton NostrAdapter instance (after createNostrAdapter called).
 * Returns null if not yet initialized.
 */
export function getNostrAdapter(): NostrAdapter | null {
  return _adapter;
}

/**
 * Get the internal adapter implementation (for handlers that need resolveJob).
 * Returns null if not yet initialized.
 */
export function getNostrAdapterImpl(): NostrAdapterImpl | null {
  return _adapter;
}
