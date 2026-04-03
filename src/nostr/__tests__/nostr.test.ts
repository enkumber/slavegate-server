/**
 * nostr/__tests__/nostr.test.ts
 * Unit tests for the Nostr Foundation layer (Sprint 1).
 *
 * All tests run in isolation — no real relay connections.
 * DB interactions are mocked with in-memory stubs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import type { Pool } from "pg";

import { encryptPayload, decryptPayload, DecryptionError } from "../encryption";
import {
  KIND_JOB_DISPATCH,
  KIND_JOB_RESULT,
  KIND_HEARTBEAT,
  KIND_KILL_SWITCH,
  KIND_OTA,
  KIND_CONFIG_PUSH,
  KIND_DEVICE_HELLO,
  KIND_DEVICE_ACK,
  KIND_DEVICE_REJECT,
  KIND_VISION_REQUEST,
  KIND_VISION_RESULT,
  withExpiration,
  makeEvent,
} from "../event-kinds";
import { DeviceRegistry, OFFLINE_THRESHOLD_MS } from "../device-registry";
import { MessageRouter } from "../message-router";
import { skToHex, hexToSk, loadOrGenerateServerKeys } from "../keys";

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

// ─── encryption.ts ────────────────────────────────────────────────────────────

describe("encryption", () => {
  it("roundtrip: encrypt → decrypt returns original payload", () => {
    const sender    = makeKeypair();
    const recipient = makeKeypair();

    const original = { action: "screenshot", jobId: "abc-123", ts: 1234567890 };
    const ciphertext = encryptPayload(original, sender.sk, recipient.pk);

    expect(typeof ciphertext).toBe("string");
    expect(ciphertext.length).toBeGreaterThan(10);

    const decrypted = decryptPayload(ciphertext, recipient.sk, sender.pk);
    expect(decrypted).toEqual(original);
  });

  it("roundtrip works with nested objects", () => {
    const a = makeKeypair();
    const b = makeKeypair();

    const payload = {
      type: "config",
      settings: { rateLimit: 20, features: { vision: true, ota: false } },
    };
    const ciphertext = encryptPayload(payload, a.sk, b.pk);
    const result = decryptPayload(ciphertext, b.sk, a.pk);
    expect(result).toEqual(payload);
  });

  it("throws DecryptionError on wrong recipient key", () => {
    const sender    = makeKeypair();
    const recipient = makeKeypair();
    const wrong     = makeKeypair();

    const ciphertext = encryptPayload({ msg: "hello" }, sender.sk, recipient.pk);
    expect(() => decryptPayload(ciphertext, wrong.sk, sender.pk)).toThrowError(DecryptionError);
  });

  it("throws DecryptionError on corrupted ciphertext", () => {
    const a = makeKeypair();
    const b = makeKeypair();

    const ciphertext = encryptPayload({ ok: true }, a.sk, b.pk);
    const corrupted  = ciphertext.slice(0, ciphertext.length - 4) + "XXXX";

    expect(() => decryptPayload(corrupted, b.sk, a.pk)).toThrowError(DecryptionError);
  });

  it("throws DecryptionError on non-JSON plaintext", () => {
    const a = makeKeypair();
    const b = makeKeypair();

    const convKey = nip44.v2.utils.getConversationKey(a.sk, b.pk);
    const broken  = nip44.v2.encrypt("NOT JSON }{", convKey);

    expect(() => decryptPayload(broken, b.sk, a.pk)).toThrowError(DecryptionError);
  });
});

// ─── event-kinds.ts ───────────────────────────────────────────────────────────

describe("event-kinds", () => {
  it("exports all expected KIND constants", () => {
    expect(KIND_JOB_DISPATCH).toBe(21000);
    expect(KIND_JOB_RESULT).toBe(21001);
    expect(KIND_HEARTBEAT).toBe(21002);
    expect(KIND_KILL_SWITCH).toBe(21003);
    expect(KIND_OTA).toBe(21004);
    expect(KIND_CONFIG_PUSH).toBe(21005);
    expect(KIND_DEVICE_HELLO).toBe(21010);
    expect(KIND_DEVICE_ACK).toBe(21011);
    expect(KIND_DEVICE_REJECT).toBe(21012);
    expect(KIND_VISION_REQUEST).toBe(21020);
    expect(KIND_VISION_RESULT).toBe(21021);
  });

  describe("withExpiration", () => {
    it("appends an expiration tag with correct timestamp", () => {
      const before = Math.floor(Date.now() / 1000);
      const tags   = [["p", "abc123"]];
      const result = withExpiration(tags, 300);
      const after  = Math.floor(Date.now() / 1000);

      const expirationTag = result.find((t) => t[0] === "expiration");
      expect(expirationTag).toBeDefined();
      const expTs = Number(expirationTag![1]);
      expect(expTs).toBeGreaterThanOrEqual(before + 300);
      expect(expTs).toBeLessThanOrEqual(after + 300 + 1);
    });

    it("does not mutate the original tags array", () => {
      const tags   = [["p", "abc"]];
      const result = withExpiration(tags, 60);
      expect(tags).toHaveLength(1);
      expect(result).toHaveLength(2);
    });

    it("uses 300s TTL by default", () => {
      const before = Math.floor(Date.now() / 1000);
      const result = withExpiration([], 300);
      const expTs  = Number(result.find((t) => t[0] === "expiration")?.[1]);
      expect(expTs - before).toBeGreaterThanOrEqual(299);
      expect(expTs - before).toBeLessThanOrEqual(302);
    });
  });

  describe("makeEvent", () => {
    it("produces a finalized event with correct kind and tags", () => {
      const { sk, pk } = makeKeypair();
      const event = makeEvent(
        KIND_JOB_DISPATCH,
        [["p", pk]],
        "encrypted-content",
        sk
      );

      expect(event.kind).toBe(KIND_JOB_DISPATCH);
      expect(event.pubkey).toBe(pk);
      expect(event.content).toBe("encrypted-content");
      expect(event.sig).toBeTruthy();
      expect(event.id).toBeTruthy();
    });

    it("includes an expiration tag", () => {
      const { sk } = makeKeypair();
      const event  = makeEvent(21000, [], "payload", sk, 600);
      const expTag = event.tags.find((t) => t[0] === "expiration");
      expect(expTag).toBeDefined();
      const expTs = Number(expTag![1]);
      expect(expTs - Math.floor(Date.now() / 1000)).toBeGreaterThan(598);
    });

    it("passes through additional tags", () => {
      const { sk } = makeKeypair();
      const event  = makeEvent(21000, [["job", "job-xyz"]], "", sk);
      const jobTag = event.tags.find((t) => t[0] === "job");
      expect(jobTag?.[1]).toBe("job-xyz");
    });
  });
});

// ─── device-registry.ts ───────────────────────────────────────────────────────

describe("DeviceRegistry", () => {
  it("register stores pubkey → deviceId mapping", async () => {
    const registry = new DeviceRegistry(makeMockDb());
    await registry.register("pubkey-aaa", "device-111");

    expect(registry.lookupDeviceId("pubkey-aaa")).toBe("device-111");
    expect(registry.lookupPubkey("device-111")).toBe("pubkey-aaa");
  });

  it("lookupDeviceId returns null for unknown pubkey", () => {
    const registry = new DeviceRegistry(makeMockDb());
    expect(registry.lookupDeviceId("unknown")).toBeNull();
  });

  it("lookupPubkey returns null for unknown deviceId", () => {
    const registry = new DeviceRegistry(makeMockDb());
    expect(registry.lookupPubkey("no-such-device")).toBeNull();
  });

  it("markSeen + isOnline returns true within threshold", async () => {
    const registry = new DeviceRegistry(makeMockDb());
    await registry.register("pub-xyz", "dev-xyz");
    registry.markSeen("pub-xyz");
    expect(registry.isOnline("pub-xyz")).toBe(true);
  });

  it("isOnline returns false for device never seen", async () => {
    const registry = new DeviceRegistry(makeMockDb());
    await registry.register("pub-never", "dev-never");
    expect(registry.isOnline("pub-never")).toBe(false);
  });

  it("isOnline returns false after OFFLINE_THRESHOLD_MS", async () => {
    vi.useFakeTimers();
    const registry = new DeviceRegistry(makeMockDb());
    await registry.register("pub-old", "dev-old");
    registry.markSeen("pub-old");

    expect(registry.isOnline("pub-old")).toBe(true);
    vi.advanceTimersByTime(OFFLINE_THRESHOLD_MS + 1_000);
    expect(registry.isOnline("pub-old")).toBe(false);

    vi.useRealTimers();
  });

  it("getOnlineDevices returns only online pubkeys", async () => {
    vi.useFakeTimers();
    const registry = new DeviceRegistry(makeMockDb());

    await registry.register("pub-a", "dev-a");
    await registry.register("pub-b", "dev-b");
    await registry.register("pub-c", "dev-c");

    registry.markSeen("pub-a");
    registry.markSeen("pub-b");
    // pub-c not seen

    const online = registry.getOnlineDevices();
    expect(online).toContain("pub-a");
    expect(online).toContain("pub-b");
    expect(online).not.toContain("pub-c");

    vi.useRealTimers();
  });

  it("loadFromDb populates mappings from DB rows", async () => {
    const db = makeMockDb([
      { id: "device-001", nostr_pubkey: "pubkey-001" },
      { id: "device-002", nostr_pubkey: "pubkey-002" },
    ]);
    const registry = new DeviceRegistry(db);
    await registry.loadFromDb();

    expect(registry.lookupDeviceId("pubkey-001")).toBe("device-001");
    expect(registry.lookupDeviceId("pubkey-002")).toBe("device-002");
    expect(registry.size).toBe(2);
  });

  it("re-registering device updates old pubkey mapping", async () => {
    const registry = new DeviceRegistry(makeMockDb());
    await registry.register("pub-old", "dev-001");
    await registry.register("pub-new", "dev-001");

    expect(registry.lookupDeviceId("pub-new")).toBe("dev-001");
    expect(registry.lookupDeviceId("pub-old")).toBeNull();
    expect(registry.lookupPubkey("dev-001")).toBe("pub-new");
  });
});

// ─── message-router.ts ────────────────────────────────────────────────────────

describe("MessageRouter", () => {
  function makeRouter(serverKeypair = makeKeypair()) {
    return {
      router: new MessageRouter(serverKeypair.sk),
      serverKeypair,
    };
  }

  function makeEncryptedEvent(
    kind: number,
    payload: object,
    senderKeypair: { sk: Uint8Array; pk: string },
    recipientPk: string
  ) {
    const content = encryptPayload(payload, senderKeypair.sk, recipientPk);
    return makeEvent(kind, [["p", recipientPk]], content, senderKeypair.sk);
  }

  it("routes KIND_HEARTBEAT to onHeartbeat handler", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onHeartbeat: handler });

    const event = makeEncryptedEvent(KIND_HEARTBEAT, { batteryLevel: 80 }, device, server.pk);
    await router.route(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toBe(device.pk);
    expect(handler.mock.calls[0]![1]).toMatchObject({ batteryLevel: 80 });
  });

  it("routes KIND_JOB_RESULT to onJobResult handler", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onJobResult: handler });

    const payload = { jobId: "job-001", status: "success" };
    const event = makeEncryptedEvent(KIND_JOB_RESULT, payload, device, server.pk);

    await router.route(event);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![1]).toMatchObject({ jobId: "job-001" });
  });

  it("routes KIND_DEVICE_HELLO to onDeviceHello handler", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onDeviceHello: handler });

    const event = makeEncryptedEvent(
      KIND_DEVICE_HELLO,
      { model: "Pixel 6", androidVersion: "13" },
      device,
      server.pk
    );

    await router.route(event);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes KIND_VISION_REQUEST to onVisionRequest handler", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onVisionRequest: handler });

    const event = makeEncryptedEvent(
      KIND_VISION_REQUEST,
      { jobId: "v-001", screenshotBase64: "data" },
      device,
      server.pk
    );

    await router.route(event);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("drops events that fail decryption (wrong key)", async () => {
    const server = makeKeypair();
    const wrong  = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onHeartbeat: handler });

    // Encrypt for 'wrong' pubkey instead of server
    const content = encryptPayload({ ok: true }, device.sk, wrong.pk);
    const event   = makeEvent(KIND_HEARTBEAT, [["p", server.pk]], content, device.sk);

    await router.route(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rate limits pubkey after exceeding 20 messages/second", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const handler = vi.fn();
    router.setHandlers({ onHeartbeat: handler });

    // Fire 25 messages in the same window — only 20 should reach the handler
    for (let i = 0; i < 25; i++) {
      const event = makeEncryptedEvent(KIND_HEARTBEAT, { battery: 50 }, device, server.pk);
      await router.route(event);
    }

    expect(handler).toHaveBeenCalledTimes(20);
  });

  it("does not throw on unknown event kind", async () => {
    const server = makeKeypair();
    const device = makeKeypair();
    const { router } = makeRouter(server);

    const content = encryptPayload({ x: 1 }, device.sk, server.pk);
    const event   = makeEvent(29999, [["p", server.pk]], content, device.sk);

    await expect(router.route(event)).resolves.not.toThrow();
  });
});

// ─── keys.ts helpers ──────────────────────────────────────────────────────────

describe("keys.ts helpers", () => {
  it("skToHex and hexToSk roundtrip", () => {
    const original = generateSecretKey();
    const hex      = skToHex(original);
    const restored = hexToSk(hex);
    expect(restored).toEqual(original);
  });

  it("skToHex produces 64-char hex string", () => {
    const sk  = generateSecretKey();
    const hex = skToHex(sk);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loadOrGenerateServerKeys uses NOSTR_SECRET_KEY env if set", async () => {
    const sk  = generateSecretKey();
    const pk  = getPublicKey(sk);
    const hex = skToHex(sk);

    process.env.NOSTR_SECRET_KEY = hex;
    const result = await loadOrGenerateServerKeys();
    delete process.env.NOSTR_SECRET_KEY;

    expect(result.pk).toBe(pk);
    expect(result.sk).toEqual(sk);
  });
});
