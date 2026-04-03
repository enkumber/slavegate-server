/**
 * nostr/__tests__/adapter.test.ts
 * Unit tests for NostrAdapter (Sprint 2: T1, T2, T3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Pool } from "pg";

import { DeviceRegistry } from "../device-registry";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, pk };
}

function makeMockDb(rows: object[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

// ─── Mock NostrPhoneClient ────────────────────────────────────────────────────

class MockNostrPhoneClient {
  public readonly publicKey: string;
  public connected = false;

  public publishedJobs: { pubkey: string; jobId: string; payload: object }[] = [];
  public publishedKillSwitches: { pubkey: string; reason: string }[] = [];
  public publishedOtas: { pubkey: string; payload: object }[] = [];
  public publishedConfigPushes: { pubkey: string; config: object }[] = [];
  public publishedDeviceAcks: { pubkey: string; status: string; deviceId?: string }[] = [];
  public publishedDeviceRejects: { pubkey: string; reason: string }[] = [];

  constructor(sk: Uint8Array) {
    this.publicKey = getPublicKey(sk);
  }

  async connect() {
    this.connected = true;
  }

  async close() {
    this.connected = false;
  }

  async publishJob(pubkey: string, jobId: string, payload: object): Promise<void> {
    this.publishedJobs.push({ pubkey, jobId, payload });
  }

  async publishKillSwitch(pubkey: string, reason: string): Promise<void> {
    this.publishedKillSwitches.push({ pubkey, reason });
  }

  async publishOta(pubkey: string, payload: object): Promise<void> {
    this.publishedOtas.push({ pubkey, payload });
  }

  async publishConfigPush(pubkey: string, config: object): Promise<void> {
    this.publishedConfigPushes.push({ pubkey, config });
  }

  async publishDeviceAck(pubkey: string, status: "approved" | "pending", deviceId?: string): Promise<void> {
    this.publishedDeviceAcks.push({ pubkey, status, deviceId });
  }

  async publishDeviceReject(pubkey: string, reason: string): Promise<void> {
    this.publishedDeviceRejects.push({ pubkey, reason });
  }
}

// ─── NostrAdapterImpl (inline for testing without full createNostrAdapter) ───

interface PendingJob {
  deviceId: string;
  jobId: string;
  createdAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

class TestNostrAdapter {
  private pendingJobs = new Map<string, PendingJob>();
  private readonly DEFAULT_JOB_TIMEOUT_MS = 5000; // 5 seconds for tests

  constructor(
    private client: MockNostrPhoneClient,
    private registry: DeviceRegistry
  ) {}

  async connect(): Promise<void> {
    await this.registry.loadFromDb();
    await this.client.connect();
  }

  async close(): Promise<void> {
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

  async sendJob(deviceId: string, job: { type: string; [key: string]: unknown }): Promise<void> {
    const pubkey = this.registry.lookupPubkey(deviceId);
    if (!pubkey) {
      throw new Error(`Device ${deviceId} not registered (no pubkey)`);
    }
    if (!this.registry.isOnline(pubkey)) {
      throw new Error(`Device ${deviceId} is offline`);
    }
    const jobId = crypto.randomUUID();
    await this.client.publishJob(pubkey, jobId, job);
  }

  async sendJobWithTimeout(
    deviceId: string,
    job: { type: string; [key: string]: unknown },
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
      console.warn(`[nostr:adapter] Kill switch: device ${deviceId} not registered`);
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
    payload: { version: string; versionCode: number; apkUrl: string; apkSha256: string; apkSignature: string },
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

  async sendConfigPush(deviceId: string, config: Record<string, unknown>): Promise<void> {
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

  async sendDeviceAck(deviceId: string, status: "approved" | "pending"): Promise<void> {
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

  resolveJob(jobId: string, result: unknown, success: boolean): void {
    const pending = this.pendingJobs.get(jobId);
    if (!pending) {
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

  // For tests: get pending job by jobId
  getPendingJobIds(): string[] {
    return [...this.pendingJobs.keys()];
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NostrAdapter", () => {
  let serverKeypair: { sk: Uint8Array; pk: string };
  let deviceKeypair: { sk: Uint8Array; pk: string };
  let mockClient: MockNostrPhoneClient;
  let registry: DeviceRegistry;
  let adapter: TestNostrAdapter;

  beforeEach(async () => {
    serverKeypair = makeKeypair();
    deviceKeypair = makeKeypair();
    
    mockClient = new MockNostrPhoneClient(serverKeypair.sk);
    registry = new DeviceRegistry(makeMockDb());
    adapter = new TestNostrAdapter(mockClient, registry);
    
    // Register a test device
    await registry.register(deviceKeypair.pk, "device-001");
    registry.markSeen(deviceKeypair.pk); // Mark online
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── T1: Basic adapter methods ─────────────────────────────────────────────

  describe("device status", () => {
    it("isDeviceOnline returns true for registered and seen device", () => {
      expect(adapter.isDeviceOnline("device-001")).toBe(true);
    });

    it("isDeviceOnline returns false for unknown device", () => {
      expect(adapter.isDeviceOnline("unknown")).toBe(false);
    });

    it("isDeviceOnline returns false for registered but never seen device", async () => {
      await registry.register("pk-never-seen", "device-002");
      expect(adapter.isDeviceOnline("device-002")).toBe(false);
    });

    it("getOnlineDeviceIds returns only online devices", async () => {
      await registry.register("pk-offline", "device-003");
      // device-003 not marked as seen
      
      const online = adapter.getOnlineDeviceIds();
      expect(online).toContain("device-001");
      expect(online).not.toContain("device-003");
    });
  });

  describe("sendJob", () => {
    it("publishes job to registered and online device", async () => {
      await adapter.sendJob("device-001", { type: "screenshot" });
      
      expect(mockClient.publishedJobs).toHaveLength(1);
      expect(mockClient.publishedJobs[0]!.pubkey).toBe(deviceKeypair.pk);
      expect(mockClient.publishedJobs[0]!.payload).toMatchObject({ type: "screenshot" });
    });

    it("throws error for unregistered device", async () => {
      await expect(
        adapter.sendJob("unknown", { type: "tap" })
      ).rejects.toThrow("not registered");
    });

    it("throws error for offline device", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(100_000); // past offline threshold
      
      await expect(
        adapter.sendJob("device-001", { type: "tap" })
      ).rejects.toThrow("offline");
    });
  });

  describe("sendKillSwitch", () => {
    it("publishes kill switch to device", async () => {
      await adapter.sendKillSwitch("device-001", "Emergency stop");
      
      expect(mockClient.publishedKillSwitches).toHaveLength(1);
      expect(mockClient.publishedKillSwitches[0]!.reason).toBe("Emergency stop");
    });

    it("does not throw for unregistered device", async () => {
      await expect(
        adapter.sendKillSwitch("unknown", "test")
      ).resolves.not.toThrow();
    });
  });

  describe("sendKillSwitchAll", () => {
    it("publishes kill switch to all online devices", async () => {
      await registry.register("pk-2", "device-002");
      registry.markSeen("pk-2");
      
      await adapter.sendKillSwitchAll("Global emergency");
      
      expect(mockClient.publishedKillSwitches).toHaveLength(2);
    });
  });

  describe("broadcastOta", () => {
    const otaPayload = {
      version: "1.2.3",
      versionCode: 123,
      apkUrl: "https://example.com/app.apk",
      apkSha256: "abc123",
      apkSignature: "sig",
    };

    it("broadcasts OTA to all online devices when no deviceIds specified", async () => {
      await registry.register("pk-2", "device-002");
      registry.markSeen("pk-2");
      
      const count = await adapter.broadcastOta(otaPayload);
      
      expect(count).toBe(2);
      expect(mockClient.publishedOtas).toHaveLength(2);
    });

    it("broadcasts OTA only to specified devices", async () => {
      await registry.register("pk-2", "device-002");
      registry.markSeen("pk-2");
      
      const count = await adapter.broadcastOta(otaPayload, ["device-001"]);
      
      expect(count).toBe(1);
      expect(mockClient.publishedOtas).toHaveLength(1);
    });
  });

  describe("sendConfigPush", () => {
    it("publishes config to device", async () => {
      await adapter.sendConfigPush("device-001", { rateLimit: 10 });
      
      expect(mockClient.publishedConfigPushes).toHaveLength(1);
      expect(mockClient.publishedConfigPushes[0]!.config).toMatchObject({ rateLimit: 10 });
    });

    it("throws for unregistered device", async () => {
      await expect(
        adapter.sendConfigPush("unknown", {})
      ).rejects.toThrow("not registered");
    });
  });

  describe("sendRevoked", () => {
    it("publishes device reject", async () => {
      await adapter.sendRevoked("device-001");
      
      expect(mockClient.publishedDeviceRejects).toHaveLength(1);
      expect(mockClient.publishedDeviceRejects[0]!.reason).toBe("Device access revoked");
    });
  });

  describe("sendDeviceAck", () => {
    it("publishes device ack with approved status", async () => {
      await adapter.sendDeviceAck("device-001", "approved");
      
      expect(mockClient.publishedDeviceAcks).toHaveLength(1);
      expect(mockClient.publishedDeviceAcks[0]!.status).toBe("approved");
    });

    it("publishes device ack with pending status", async () => {
      await adapter.sendDeviceAck("device-001", "pending");
      
      expect(mockClient.publishedDeviceAcks).toHaveLength(1);
      expect(mockClient.publishedDeviceAcks[0]!.status).toBe("pending");
    });
  });

  describe("getters", () => {
    it("getDevicePubkey returns pubkey for registered device", () => {
      expect(adapter.getDevicePubkey("device-001")).toBe(deviceKeypair.pk);
    });

    it("getDevicePubkey returns null for unknown device", () => {
      expect(adapter.getDevicePubkey("unknown")).toBeNull();
    });

    it("getServerPubkey returns client pubkey", () => {
      expect(adapter.getServerPubkey()).toBe(serverKeypair.pk);
    });
  });

  // ─── T3: Job timeout handler ───────────────────────────────────────────────

  describe("sendJobWithTimeout", () => {
    it("creates pending job", async () => {
      const promise = adapter.sendJobWithTimeout("device-001", { type: "tap" });
      
      expect(adapter.getPendingJobIds()).toHaveLength(1);
      
      // Resolve the job to prevent timeout
      const jobId = adapter.getPendingJobIds()[0]!;
      adapter.resolveJob(jobId, { success: true }, true);
      
      const result = await promise;
      expect(result).toMatchObject({ success: true });
    });

    it("times out after specified duration", async () => {
      vi.useFakeTimers();
      
      const promise = adapter.sendJobWithTimeout("device-001", { type: "tap" }, 1000);
      
      vi.advanceTimersByTime(1001);
      
      await expect(promise).rejects.toThrow("timed out");
    });

    it("resolveJob resolves pending promise on success", async () => {
      const promise = adapter.sendJobWithTimeout("device-001", { type: "tap" });
      const jobId = adapter.getPendingJobIds()[0]!;
      
      adapter.resolveJob(jobId, "done", true);
      
      const result = await promise;
      expect(result).toBe("done");
      expect(adapter.getPendingJobIds()).toHaveLength(0);
    });

    it("resolveJob rejects pending promise on failure", async () => {
      const promise = adapter.sendJobWithTimeout("device-001", { type: "tap" });
      const jobId = adapter.getPendingJobIds()[0]!;
      
      adapter.resolveJob(jobId, "Failed to tap", false);
      
      await expect(promise).rejects.toThrow("Failed to tap");
      expect(adapter.getPendingJobIds()).toHaveLength(0);
    });

    it("resolveJob ignores unknown jobId", () => {
      expect(() => adapter.resolveJob("unknown-job", {}, true)).not.toThrow();
    });

    it("throws for unregistered device", async () => {
      await expect(
        adapter.sendJobWithTimeout("unknown", { type: "tap" })
      ).rejects.toThrow("not registered");
    });

    it("throws for offline device", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(100_000); // past offline threshold
      
      await expect(
        adapter.sendJobWithTimeout("device-001", { type: "tap" })
      ).rejects.toThrow("offline");
    });
  });

  describe("close", () => {
    it("cancels all pending jobs", async () => {
      vi.useFakeTimers();
      
      const promise1 = adapter.sendJobWithTimeout("device-001", { type: "tap" });
      const promise2 = adapter.sendJobWithTimeout("device-001", { type: "swipe" });
      
      await adapter.close();
      
      await expect(promise1).rejects.toThrow("cancelled");
      await expect(promise2).rejects.toThrow("cancelled");
    });
  });
});
