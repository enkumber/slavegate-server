/**
 * nostr/keys.ts
 * Server keypair management — load from DB or generate on first run.
 *
 * Priority:
 *   1. NOSTR_SECRET_KEY env var (dev / override)
 *   2. nostr_server_keys DB table (production)
 *   3. Generate new keypair and persist to DB
 */

import { generateSecretKey, getPublicKey } from "nostr-tools";
import { getDb } from "../db/client";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function skToHex(sk: Uint8Array): string {
  return Buffer.from(sk).toString("hex");
}

function hexToSk(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function encryptSecretKey(sk: Uint8Array): string {
  const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encKey) {
    console.warn(
      "[nostr:keys] CREDENTIAL_ENCRYPTION_KEY not set — storing secret key without encryption. Set this in production!"
    );
    return `plain:${Buffer.from(sk).toString("base64")}`;
  }

  // XOR with key bytes — sufficient for at-rest protection with a strong CREDENTIAL_ENCRYPTION_KEY.
  // Replace with AES-GCM if you need FIPS compliance.
  const keyBuf = Buffer.from(encKey.slice(0, 32).padEnd(32, "0"), "utf8");
  const skBuf = Buffer.from(sk);
  const xored = Buffer.alloc(skBuf.length);
  for (let i = 0; i < skBuf.length; i++) {
    xored[i] = skBuf[i]! ^ keyBuf[i % keyBuf.length]!;
  }
  return `xor:${xored.toString("base64")}`;
}

function decryptSecretKey(stored: string): Uint8Array {
  if (stored.startsWith("plain:")) {
    return Uint8Array.from(Buffer.from(stored.slice(6), "base64"));
  }

  if (stored.startsWith("xor:")) {
    const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!encKey) {
      throw new Error(
        "[nostr:keys] CREDENTIAL_ENCRYPTION_KEY is required to decrypt stored secret key"
      );
    }
    const keyBuf = Buffer.from(encKey.slice(0, 32).padEnd(32, "0"), "utf8");
    const encrypted = Buffer.from(stored.slice(4), "base64");
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i]! ^ keyBuf[i % keyBuf.length]!;
    }
    return Uint8Array.from(decrypted);
  }

  throw new Error(
    `[nostr:keys] Unknown secret key encoding: "${stored.slice(0, 10)}..."`
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Load server Nostr keypair from DB or generate a new one.
 * Returns { sk: Uint8Array, pk: string (hex) }.
 *
 * Call once at server startup and cache the result.
 */
export async function loadOrGenerateServerKeys(): Promise<{
  sk: Uint8Array;
  pk: string;
}> {
  // 1. Env var override — useful for dev and Umbrel secrets injection
  if (process.env.NOSTR_SECRET_KEY) {
    const sk = hexToSk(process.env.NOSTR_SECRET_KEY);
    const pk = getPublicKey(sk);
    console.log(
      `[nostr:keys] Loaded keypair from NOSTR_SECRET_KEY env. pubkey=${pk.slice(0, 8)}...`
    );
    return { sk, pk };
  }

  const db = getDb();

  // 2. Try loading from DB
  const result = await db.query<{
    secret_key_encrypted: string;
    public_key: string;
  }>(
    "SELECT secret_key_encrypted, public_key FROM nostr_server_keys WHERE id = $1",
    ["default"]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0]!;
    const sk = decryptSecretKey(row.secret_key_encrypted);
    const pk = row.public_key;
    console.log(
      `[nostr:keys] Loaded keypair from DB. pubkey=${pk.slice(0, 8)}...`
    );
    return { sk, pk };
  }

  // 3. Generate new keypair and persist
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const encryptedSk = encryptSecretKey(sk);

  await db.query(
    `INSERT INTO nostr_server_keys (id, secret_key_encrypted, public_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET secret_key_encrypted = EXCLUDED.secret_key_encrypted,
           public_key           = EXCLUDED.public_key`,
    ["default", encryptedSk, pk]
  );

  console.log(
    `[nostr:keys] Generated new server keypair. pubkey=${pk.slice(0, 8)}...`
  );
  console.log(`[nostr:keys] *** Server public key (share with devices for enrollment): ${pk} ***`);

  return { sk, pk };
}

/**
 * Export the server public key as a hex string from a raw secret key.
 * Convenience wrapper for use in tests and scripts.
 */
export function getServerPublicKey(sk: Uint8Array): string {
  return getPublicKey(sk);
}

export { skToHex, hexToSk };
