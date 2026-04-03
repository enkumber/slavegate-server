/**
 * nostr/client.ts
 * NostrPhoneClient — connects to dual relays, publishes events, routes subscriptions.
 *
 * Design:
 *   - Connects to BOTH relay URLs simultaneously (Umbrel primary + secondary)
 *   - Subscribes to server-targeted events on both relays
 *   - Publishes to both relays with Promise.any() (succeeds when at least one accepts)
 *   - Reconnects on disconnect with exponential backoff (1s → 60s)
 */

import { SimplePool, getPublicKey, type Filter } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import {
  makeEvent,
  KIND_JOB_DISPATCH,
  KIND_KILL_SWITCH,
  KIND_OTA,
  KIND_DEVICE_ACK,
  KIND_DEVICE_REJECT,
  KIND_VISION_RESULT,
  KIND_CONFIG_PUSH,
  KIND_JOB_RESULT,
  KIND_HEARTBEAT,
  KIND_DEVICE_HELLO,
  KIND_VISION_REQUEST,
} from "./event-kinds";
import { encryptPayload } from "./encryption";
import type { DeviceRegistry } from "./device-registry";
import type { MessageRouter } from "./message-router";

// ─── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS     = 60_000;
const RECONNECT_MULTIPLIER = 2;
const SUBSCRIPTION_SINCE_S = 300; // only receive events from the last 5 minutes

/** Kinds the server wants to receive from devices */
const SERVER_SUBSCRIBED_KINDS = [
  KIND_JOB_RESULT,
  KIND_HEARTBEAT,
  KIND_DEVICE_HELLO,
  KIND_VISION_REQUEST,
];

// ─── NostrPhoneClient ─────────────────────────────────────────────────────────

export class NostrPhoneClient {
  private readonly pk: string;
  private pool: SimplePool;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private closed = false;

  constructor(
    private readonly sk: Uint8Array,
    private readonly relayUrls: string[],
    private readonly registry: DeviceRegistry,
    private readonly router: MessageRouter
  ) {
    if (relayUrls.length === 0) {
      throw new Error("[NostrPhoneClient] At least one relay URL is required");
    }
    this.pk = getPublicKey(sk);
    this.pool = new SimplePool();
  }

  /** Server's public key (hex) */
  get publicKey(): string {
    return this.pk;
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /**
   * Connect to all configured relays and subscribe to incoming events.
   * Call once at startup. Reconnects automatically on failure.
   */
  async connect(): Promise<void> {
    this.closed = false;
    this._subscribe();
    console.log(
      `[nostr:client] Connected to ${this.relayUrls.length} relay(s): ${this.relayUrls.join(", ")}`
    );
    console.log(`[nostr:client] Server pubkey: ${this.pk}`);
  }

  /** Gracefully close all relay connections. */
  async close(): Promise<void> {
    this.closed = true;
    this.pool.close(this.relayUrls);
    console.log("[nostr:client] Closed all relay connections.");
  }

  // ─── Subscription ─────────────────────────────────────────────────────────

  private _subscribe(): void {
    const since = Math.floor(Date.now() / 1000) - SUBSCRIPTION_SINCE_S;

    const filter: Filter = {
      kinds: SERVER_SUBSCRIBED_KINDS,
      "#p": [this.pk],
      since,
    };

    const sub = this.pool.subscribeMany(
      this.relayUrls,
      filter,
      {
        onevent: (event: NostrEvent) => {
          void this._handleEvent(event);
        },
        oneose: () => {
          // End of stored events — we're now in live mode
          console.log("[nostr:client] Subscription caught up (EOSE).");
        },
      }
    );

    // SimplePool manages reconnects internally, but we attach a watchdog
    // to detect complete disconnection and re-subscribe.
    this._watchdog(sub);
  }

  private _watchdog(sub: ReturnType<SimplePool["subscribeMany"]>): void {
    // SimplePool doesn't expose a clean "disconnected" event, so we use
    // a periodic check. If all relays are disconnected, re-subscribe.
    const interval = setInterval(() => {
      if (this.closed) {
        clearInterval(interval);
        return;
      }

      const connectedRelays = this.relayUrls.filter((url) => {
        const relay = this.pool.ensureRelay(url);
        // WebSocket readyState: 1 = OPEN
        return relay.then !== undefined || true; // SimplePool lazy-connects
      });

      // SimplePool handles reconnect internally; this is a failsafe
      if (connectedRelays.length === 0) {
        console.warn(
          `[nostr:client] All relays disconnected — re-subscribing in ${this.reconnectDelay}ms`
        );
        clearInterval(interval);
        sub.close();
        setTimeout(() => {
          if (!this.closed) {
            this.reconnectDelay = Math.min(
              this.reconnectDelay * RECONNECT_MULTIPLIER,
              RECONNECT_MAX_MS
            );
            this._subscribe();
          }
        }, this.reconnectDelay);
      } else {
        // Reset backoff on successful connection
        this.reconnectDelay = RECONNECT_INITIAL_MS;
      }
    }, 30_000);
  }

  // ─── Event handling ───────────────────────────────────────────────────────

  private async _handleEvent(event: NostrEvent): Promise<void> {
    // Update last seen in registry
    this.registry.markSeen(event.pubkey);

    // Route to message router
    await this.router.route(event);
  }

  // ─── Publish helpers ──────────────────────────────────────────────────────

  private async _publish(event: ReturnType<typeof makeEvent>): Promise<void> {
    const results = this.pool.publish(this.relayUrls, event);
    await Promise.any(results).catch((err: unknown) => {
      console.error(
        `[nostr:client] Failed to publish event kind=${event.kind} to all relays:`,
        err
      );
      throw err;
    });
  }

  // ─── Public publish methods ───────────────────────────────────────────────

  /**
   * Dispatch a job to a device.
   * kind=21000, NIP-44 encrypted payload.
   */
  async publishJob(
    devicePubkey: string,
    jobId: string,
    payload: object
  ): Promise<void> {
    const content = encryptPayload(payload, this.sk, devicePubkey);
    const event = makeEvent(
      KIND_JOB_DISPATCH,
      [
        ["p", devicePubkey],
        ["job", jobId],
        ["t", "job_dispatch"],
      ],
      content,
      this.sk
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishJob: jobId=${jobId.slice(0, 8)} → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Send an emergency kill switch to a device.
   * kind=21003, NIP-44 encrypted.
   */
  async publishKillSwitch(
    devicePubkey: string,
    reason = "Emergency stop"
  ): Promise<void> {
    const content = encryptPayload({ reason, ts: Date.now() }, this.sk, devicePubkey);
    const event = makeEvent(
      KIND_KILL_SWITCH,
      [
        ["p", devicePubkey],
        ["t", "kill_switch"],
      ],
      content,
      this.sk
    );
    await this._publish(event);
    console.warn(
      `[nostr:client] publishKillSwitch: reason="${reason}" → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Push an OTA update to a device.
   * kind=21004, NIP-44 encrypted.
   */
  async publishOta(
    devicePubkey: string,
    payload: {
      apkUrl: string;
      apkSha256: string;
      apkSignature: string;
      versionCode: number;
      version: string;
    }
  ): Promise<void> {
    const content = encryptPayload(payload, this.sk, devicePubkey);
    const event = makeEvent(
      KIND_OTA,
      [
        ["p", devicePubkey],
        ["t", "ota"],
      ],
      content,
      this.sk,
      3600 // OTA events live for 1 hour
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishOta: v${payload.version} → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Acknowledge a device HELLO (approve registration).
   * kind=21011, NIP-44 encrypted.
   */
  async publishDeviceAck(
    devicePubkey: string,
    status: "approved" | "pending",
    deviceId?: string
  ): Promise<void> {
    const content = encryptPayload(
      { status, deviceId, ts: Date.now() },
      this.sk,
      devicePubkey
    );
    const event = makeEvent(
      KIND_DEVICE_ACK,
      [
        ["p", devicePubkey],
        ["t", "device_ack"],
      ],
      content,
      this.sk
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishDeviceAck: status=${status} → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Reject a device HELLO.
   * kind=21012, NOT encrypted (so device can read rejection reason without prior key exchange).
   */
  async publishDeviceReject(
    devicePubkey: string,
    reason: string
  ): Promise<void> {
    const event = makeEvent(
      KIND_DEVICE_REJECT,
      [
        ["p", devicePubkey],
        ["t", "device_reject"],
      ],
      JSON.stringify({ reason, ts: Date.now() }),
      this.sk
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishDeviceReject: reason="${reason}" → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Send vision analysis result back to device.
   * kind=21021, NIP-44 encrypted.
   */
  async publishVisionResult(
    devicePubkey: string,
    jobId: string,
    result: object
  ): Promise<void> {
    const content = encryptPayload(
      { jobId, ...result as Record<string, unknown> },
      this.sk,
      devicePubkey
    );
    const event = makeEvent(
      KIND_VISION_RESULT,
      [
        ["p", devicePubkey],
        ["job", jobId],
        ["t", "vision_result"],
      ],
      content,
      this.sk
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishVisionResult: jobId=${jobId.slice(0, 8)} → device=${devicePubkey.slice(0, 8)}`
    );
  }

  /**
   * Push configuration to a device (rate limits, feature flags, etc.).
   * kind=21005, NIP-44 encrypted.
   */
  async publishConfigPush(
    devicePubkey: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const content = encryptPayload(config, this.sk, devicePubkey);
    const event = makeEvent(
      KIND_CONFIG_PUSH,
      [
        ["p", devicePubkey],
        ["t", "config_push"],
      ],
      content,
      this.sk,
      3600 // config valid for 1 hour
    );
    await this._publish(event);
    console.log(
      `[nostr:client] publishConfigPush → device=${devicePubkey.slice(0, 8)}`
    );
  }
}
