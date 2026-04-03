/**
 * nostr/index.ts
 * Public re-exports for the Nostr layer.
 */

export { loadOrGenerateServerKeys, getServerPublicKey, skToHex, hexToSk } from "./keys";
export { encryptPayload, decryptPayload, DecryptionError } from "./encryption";
export {
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
} from "./event-kinds";
export { DeviceRegistry, OFFLINE_THRESHOLD_MS } from "./device-registry";
export { MessageRouter } from "./message-router";
export type { MessageHandlers } from "./message-router";
export { NostrPhoneClient } from "./client";

// Sprint 2: Adapter layer
export {
  createNostrAdapter,
  getNostrAdapter,
  type NostrAdapter,
  type JobPayload,
  type OtaPayload,
} from "./adapter";
export { createHandlers } from "./handlers";
