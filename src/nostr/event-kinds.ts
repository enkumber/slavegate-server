/**
 * nostr/event-kinds.ts
 * Custom Nostr event kind constants and helpers for Phone Network v2.
 *
 * All kinds are in the ephemeral range (20000-29999) per NIP-01.
 * Ephemeral events are not stored by relays, keeping message flow transient.
 */

import { finalizeEvent, type EventTemplate } from "nostr-tools";

// ─── Event Kind Constants ─────────────────────────────────────────────────────

/** Server → Device: Dispatch a job/command */
export const KIND_JOB_DISPATCH    = 21000 as const;

/** Device → Server: Result of a dispatched job */
export const KIND_JOB_RESULT      = 21001 as const;

/** Device → Server: Periodic health/heartbeat report */
export const KIND_HEARTBEAT       = 21002 as const;

/** Server → Device: Emergency kill switch */
export const KIND_KILL_SWITCH     = 21003 as const;

/** Server → Device: OTA update push */
export const KIND_OTA             = 21004 as const;

/** Server → Device: Configuration push (rate limits, feature flags, etc.) */
export const KIND_CONFIG_PUSH     = 21005 as const;

/** Device → Server: Device coming online, requesting registration/auth */
export const KIND_DEVICE_HELLO    = 21010 as const;

/** Server → Device: Server acknowledges / approves device */
export const KIND_DEVICE_ACK      = 21011 as const;

/** Server → Device: Server rejects device */
export const KIND_DEVICE_REJECT   = 21012 as const;

/** Device → Server: Request vision/screen analysis */
export const KIND_VISION_REQUEST  = 21020 as const;

/** Server → Device: Result of vision analysis */
export const KIND_VISION_RESULT   = 21021 as const;

// ─── NIP-40 Expiration Helper ─────────────────────────────────────────────────

/**
 * Add a NIP-40 expiration tag to a tags array.
 * Events with expiration tags are auto-deleted by relays after TTL.
 *
 * @param tags       - Existing tags array to augment
 * @param ttlSeconds - Seconds until expiration (default: 300 = 5 minutes)
 * @returns          - New tags array with expiration tag appended
 */
export function withExpiration(
  tags: string[][],
  ttlSeconds = 300
): string[][] {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return [...tags, ["expiration", String(expiresAt)]];
}

// ─── Event Factory ────────────────────────────────────────────────────────────

/**
 * Create, sign, and return a finalized Nostr event with NIP-40 expiration.
 *
 * @param kind       - Event kind (use KIND_* constants)
 * @param tags       - Tags array (expiration will be auto-added)
 * @param content    - Plaintext or NIP-44 encrypted content string
 * @param sk         - Signing secret key (Uint8Array, 32 bytes)
 * @param ttlSeconds - TTL for NIP-40 expiration (default: 300)
 * @returns          - Finalized (signed) Nostr event
 */
export function makeEvent(
  kind: number,
  tags: string[][],
  content: string,
  sk: Uint8Array,
  ttlSeconds = 300
): ReturnType<typeof finalizeEvent> {
  const tagsWithExpiry = withExpiration(tags, ttlSeconds);

  const unsigned: EventTemplate = {
    kind,
    tags: tagsWithExpiry,
    content,
    created_at: Math.floor(Date.now() / 1000),
  };

  return finalizeEvent(unsigned, sk);
}
