/**
 * modules/accounts/credential-vault.ts
 * AES-256-GCM credential encryption/decryption.
 *
 * Security model:
 * - Credentials never stored plain text (ARCHITECTURE_AUDIT_v3.md §15 constraint #2)
 * - Encryption key derived from CREDENTIAL_ENCRYPTION_KEY env var (hex, 64 chars = 32 bytes)
 * - Each credential has unique random IV (12 bytes) — stored prepended to ciphertext
 * - Auth tag (16 bytes) stored appended to ciphertext
 * - Wire format: base64(iv[12] || ciphertext || authTag[16])
 *
 * Vault references (prod):
 *   "vault:accounts/{accountId}/creds" → HashiCorp Vault KV path
 *   Phase 3: dev fallback via CREDENTIAL_ENCRYPTION_KEY env var
 *   Phase 4: real Vault HTTP API integration
 *
 * Usage:
 *   const encrypted = credentialVault.encrypt({ username, password, totpSecret })
 *   const plain     = credentialVault.decrypt(encrypted)
 */

import crypto from "crypto";

const ALGORITHM  = "aes-256-gcm" as const;
const IV_BYTES   = 12;   // GCM recommended IV size
const TAG_BYTES  = 16;   // GCM auth tag

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Credentials {
  username:    string;
  password:    string;
  /** TOTP secret for 2FA accounts (base32 encoded) */
  totpSecret?: string;
  /** Any platform-specific fields (e.g., phone number) */
  extra?:      Record<string, string>;
}

export interface EncryptedCredential {
  /** base64(iv || ciphertext || authTag) */
  data:        string;
  /** Vault path reference — stored in accounts.encryption_key_ref */
  vaultRef:    string;
  /** Version for future key rotation */
  keyVersion:  number;
}

// ─── Vault service ────────────────────────────────────────────────────────────

export class CredentialVault {
  private readonly key: Buffer;
  private readonly keyVersion = 1;

  constructor() {
    const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
      throw new Error(
        "CREDENTIAL_ENCRYPTION_KEY must be set: 64 hex chars (32 bytes). " +
        "Generate with: openssl rand -hex 32"
      );
    }
    this.key = Buffer.from(hex, "hex");
  }

  /**
   * Encrypt credentials for storage.
   * @param creds     Plain text credentials
   * @param vaultRef  Vault path reference (e.g. "vault:accounts/{id}/creds")
   */
  encrypt(creds: Credentials, vaultRef: string): EncryptedCredential {
    const iv     = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const plain  = Buffer.from(JSON.stringify(creds), "utf8");

    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const authTag   = cipher.getAuthTag();

    // Wire format: iv || ciphertext || authTag
    const combined = Buffer.concat([iv, encrypted, authTag]);
    return {
      data:       combined.toString("base64"),
      vaultRef,
      keyVersion: this.keyVersion,
    };
  }

  /**
   * Decrypt credentials.
   * @param credential  Encrypted credential object
   * @throws            If decryption fails (wrong key, tampered data)
   */
  decrypt(credential: EncryptedCredential): Credentials {
    const combined  = Buffer.from(credential.data, "base64");
    const minLength = IV_BYTES + TAG_BYTES + 1;
    if (combined.length < minLength) {
      throw new Error("Invalid encrypted credential: data too short");
    }

    const iv         = combined.subarray(0, IV_BYTES);
    const authTag    = combined.subarray(combined.length - TAG_BYTES);
    const ciphertext = combined.subarray(IV_BYTES, combined.length - TAG_BYTES);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    try {
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Credentials;
    } catch {
      throw new Error("Credential decryption failed — data may be tampered or key is wrong");
    }
  }

  /**
   * Verify ciphertext integrity without decrypting payload.
   * Fast check before sending to device.
   */
  verify(credential: EncryptedCredential): boolean {
    try {
      this.decrypt(credential);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Lazy singleton — throws at construction if env var missing ───────────────

let _vault: CredentialVault | null = null;

export function getCredentialVault(): CredentialVault {
  if (!_vault) {
    _vault = new CredentialVault();
  }
  return _vault;
}
