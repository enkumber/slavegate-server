/**
 * nostr/message-router.ts
 * Routes incoming Nostr events to handler stubs with per-pubkey rate limiting.
 *
 * Handlers are stubs in Sprint 1 — full integration with existing services
 * (dispatcherService, devicesService, visionService) happens in Sprint 2.
 */

import type { Event as NostrEvent } from "nostr-tools";
import { decryptPayload, DecryptionError } from "./encryption";
import {
  KIND_JOB_RESULT,
  KIND_HEARTBEAT,
  KIND_DEVICE_HELLO,
  KIND_VISION_REQUEST,
} from "./event-kinds";

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT_PER_S = 20; // messages per second per pubkey (configurable)
const RATE_WINDOW_MS   = 1_000;

interface RateWindow {
  count: number;
  windowStart: number;
}

class RateLimiter {
  private windows = new Map<string, RateWindow>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /**
   * Returns true if the pubkey is within rate limit, false if exceeded.
   */
  allow(pubkey: string): boolean {
    const now = Date.now();
    const win = this.windows.get(pubkey);

    if (!win || now - win.windowStart >= this.windowMs) {
      // New window
      this.windows.set(pubkey, { count: 1, windowStart: now });
      return true;
    }

    if (win.count >= this.limit) {
      return false;
    }

    win.count++;
    return true;
  }

  /** Remove tracking state for a pubkey (cleanup on disconnect). */
  delete(pubkey: string): void {
    this.windows.delete(pubkey);
  }
}

// ─── Handler types ────────────────────────────────────────────────────────────

export interface MessageHandlers {
  /** kind=21001: Device completed a job */
  onJobResult: (pubkey: string, payload: object, event: NostrEvent) => Promise<void> | void;

  /** kind=21002: Device sent a heartbeat */
  onHeartbeat: (pubkey: string, payload: object, event: NostrEvent) => Promise<void> | void;

  /** kind=21010: Device coming online */
  onDeviceHello: (pubkey: string, payload: object, event: NostrEvent) => Promise<void> | void;

  /** kind=21020: Device requests vision analysis */
  onVisionRequest: (pubkey: string, payload: object, event: NostrEvent) => Promise<void> | void;
}

// ─── MessageRouter ────────────────────────────────────────────────────────────

export class MessageRouter {
  private rateLimiter: RateLimiter;
  private handlers: Partial<MessageHandlers> = {};

  constructor(
    private readonly serverSk: Uint8Array,
    private readonly rateLimitPerSecond = RATE_LIMIT_PER_S
  ) {
    this.rateLimiter = new RateLimiter(rateLimitPerSecond, RATE_WINDOW_MS);
  }

  /**
   * Register handlers for incoming events.
   * Call this after constructing the router to wire up business logic.
   */
  setHandlers(handlers: Partial<MessageHandlers>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Route a received Nostr event to the appropriate handler.
   *
   * Steps:
   *  1. Rate limit check per pubkey
   *  2. Decrypt NIP-44 content
   *  3. Dispatch to handler based on kind
   *
   * @param event - The incoming Nostr event (from relay subscription)
   */
  async route(event: NostrEvent): Promise<void> {
    const pubkey = event.pubkey;
    const kindLabel = kindName(event.kind);

    // ── Rate limit check ─────────────────────────────────────────────────────
    if (!this.rateLimiter.allow(pubkey)) {
      console.warn(
        `[nostr:router] Rate limit exceeded: pubkey=${pubkey.slice(0, 8)} kind=${event.kind} (${kindLabel})`
      );
      return;
    }

    console.log(
      `[nostr:router] Event: kind=${event.kind} (${kindLabel}) pubkey=${pubkey.slice(0, 8)} id=${event.id.slice(0, 8)} ts=${event.created_at}`
    );

    // ── Decrypt content ───────────────────────────────────────────────────────
    let payload: object;
    try {
      payload = decryptPayload(event.content, this.serverSk, pubkey);
    } catch (err) {
      if (err instanceof DecryptionError) {
        console.error(
          `[nostr:router] Decryption failed for event ${event.id.slice(0, 8)}: ${err.message}`
        );
      } else {
        console.error(
          `[nostr:router] Unexpected error decrypting event ${event.id.slice(0, 8)}:`,
          err
        );
      }
      return;
    }

    // ── Dispatch to handler ───────────────────────────────────────────────────
    try {
      switch (event.kind) {
        case KIND_JOB_RESULT:
          if (this.handlers.onJobResult) {
            await this.handlers.onJobResult(pubkey, payload, event);
          } else {
            console.debug(`[nostr:router] No handler for JOB_RESULT (Sprint 2 stub)`);
          }
          break;

        case KIND_HEARTBEAT:
          if (this.handlers.onHeartbeat) {
            await this.handlers.onHeartbeat(pubkey, payload, event);
          } else {
            console.debug(`[nostr:router] No handler for HEARTBEAT (Sprint 2 stub)`);
          }
          break;

        case KIND_DEVICE_HELLO:
          if (this.handlers.onDeviceHello) {
            await this.handlers.onDeviceHello(pubkey, payload, event);
          } else {
            console.debug(`[nostr:router] No handler for DEVICE_HELLO (Sprint 2 stub)`);
          }
          break;

        case KIND_VISION_REQUEST:
          if (this.handlers.onVisionRequest) {
            await this.handlers.onVisionRequest(pubkey, payload, event);
          } else {
            console.debug(`[nostr:router] No handler for VISION_REQUEST (Sprint 2 stub)`);
          }
          break;

        default:
          console.warn(
            `[nostr:router] Unhandled event kind=${event.kind} from pubkey=${pubkey.slice(0, 8)}`
          );
      }
    } catch (err) {
      console.error(
        `[nostr:router] Handler error for kind=${event.kind} pubkey=${pubkey.slice(0, 8)}:`,
        err
      );
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function kindName(kind: number): string {
  const names: Record<number, string> = {
    21000: "JOB_DISPATCH",
    21001: "JOB_RESULT",
    21002: "HEARTBEAT",
    21003: "KILL_SWITCH",
    21004: "OTA",
    21005: "CONFIG_PUSH",
    21010: "DEVICE_HELLO",
    21011: "DEVICE_ACK",
    21012: "DEVICE_REJECT",
    21020: "VISION_REQUEST",
    21021: "VISION_RESULT",
  };
  return names[kind] ?? `UNKNOWN(${kind})`;
}
