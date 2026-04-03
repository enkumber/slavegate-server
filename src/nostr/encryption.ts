/**
 * nostr/encryption.ts
 * NIP-44 encryption/decryption wrapper.
 *
 * All command/response messages between server and devices are E2EE using
 * NIP-44 (versioned encryption with secp256k1 shared secrets).
 *
 * References:
 *   - https://github.com/nostr-protocol/nips/blob/master/44.md
 *   - nostr-tools/nip44
 */

import { nip44 } from "nostr-tools";

// ─── Encrypt ──────────────────────────────────────────────────────────────────

/**
 * Encrypt a payload object to a NIP-44 ciphertext string.
 *
 * @param payload     - Any JSON-serializable object to encrypt
 * @param senderSk    - Sender's secp256k1 secret key (Uint8Array, 32 bytes)
 * @param recipientPk - Recipient's public key (hex string)
 * @returns           - NIP-44 ciphertext string (base64 encoded versioned payload)
 * @throws            - If serialization or encryption fails
 */
export function encryptPayload(
  payload: object,
  senderSk: Uint8Array,
  recipientPk: string
): string {
  const plaintext = JSON.stringify(payload);
  const conversationKey = nip44.v2.utils.getConversationKey(senderSk, recipientPk);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

// ─── Decrypt ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a NIP-44 ciphertext string to a payload object.
 *
 * @param content      - NIP-44 ciphertext string from event.content
 * @param recipientSk  - Recipient's secp256k1 secret key (Uint8Array, 32 bytes)
 * @param senderPk     - Sender's public key (hex string) — same as event.pubkey
 * @returns            - Decrypted and parsed payload object
 * @throws             - DecryptionError if content is invalid or keys are wrong
 */
export function decryptPayload(
  content: string,
  recipientSk: Uint8Array,
  senderPk: string
): object {
  let plaintext: string;

  try {
    const conversationKey = nip44.v2.utils.getConversationKey(recipientSk, senderPk);
    plaintext = nip44.v2.decrypt(content, conversationKey);
  } catch (err) {
    throw new DecryptionError(
      `NIP-44 decryption failed: ${(err as Error).message}`,
      { cause: err }
    );
  }

  try {
    return JSON.parse(plaintext) as object;
  } catch (err) {
    throw new DecryptionError(
      `Decrypted content is not valid JSON: ${plaintext.slice(0, 64)}`,
      { cause: err }
    );
  }
}

// ─── Custom error ─────────────────────────────────────────────────────────────

export class DecryptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DecryptionError";
  }
}
