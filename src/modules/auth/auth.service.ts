/**
 * modules/auth/auth.service.ts
 * EC key pair challenge-response auth (v4, since 007_auth_challenges).
 *
 * Flow:
 * 1. Device → HELLO { imei, publicKeyPem }
 *    Server upserts public_key_pem → issues CHALLENGE { nonce } if approved
 * 2. Device → CHALLENGE_RESPONSE { deviceId, signature=sign(nonce_bytes) }
 *    Server verifies ECDSA-SHA256 → connection authenticated
 *
 * Security:
 * - Server stores only public keys — compromise exposes nothing useful
 * - Nonces expire in 60s — prevents replay attacks
 * - Private keys are hardware-backed in Android Keystore (non-exportable)
 */

import { randomBytes, createVerify } from "crypto";
import { getDb } from "../../db/client";

export class AuthService {

  // ─── IMEI lookup ──────────────────────────────────────────────────────────

  async findByImei(imei: string): Promise<{
    deviceId: string;
    status: string;
    publicKeyPem: string | null;
  } | null> {
    const db = getDb();
    const result = await db.query(
      "SELECT id, status, public_key_pem FROM devices WHERE imei = $1 LIMIT 1",
      [imei]
    );
    if (result.rows.length === 0) return null;
    return {
      deviceId:     result.rows[0].id as string,
      status:       result.rows[0].status as string,
      publicKeyPem: (result.rows[0].public_key_pem as string | null) ?? null,
    };
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a new device as 'pending' with its EC public key.
   * ON CONFLICT (imei): updates public_key_pem + agent metadata (key rotation / reinstall).
   * Re-registration resets status to 'pending' — requires re-approval for security.
   */
  async registerPending(params: {
    imei: string;
    publicKeyPem: string;
    model: string;
    androidVersion: string;
    agentVersion: string;
    ipAddress: string;
    friendlyName?: string;
  }): Promise<string> {
    const db = getDb();
    const { imei, publicKeyPem, model, androidVersion, agentVersion, ipAddress, friendlyName } = params;

    const result = await db.query(
      `INSERT INTO devices
         (imei, public_key_pem, friendly_name, model, android_version, agent_version, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (imei) WHERE imei IS NOT NULL
       DO UPDATE SET
         public_key_pem  = EXCLUDED.public_key_pem,
         status          = NULL,
         agent_version   = EXCLUDED.agent_version,
         last_ip         = EXCLUDED.last_ip,
         last_seen_at    = NOW()
       RETURNING id`,
      [
        imei,
        publicKeyPem,
        friendlyName ?? model ?? "Unknown Device",
        model,
        androidVersion,
        agentVersion,
        ipAddress,
      ]
    );

    return result.rows[0].id as string;
  }

  /**
   * Update public_key_pem for an existing approved device without resetting status.
   * Used when device reconnects with an approved IMEI — server always upserts the key.
   */
  async updatePublicKey(deviceId: string, publicKeyPem: string): Promise<void> {
    const db = getDb();
    await db.query(
      "UPDATE devices SET public_key_pem = $1, last_seen_at = NOW() WHERE id = $2",
      [publicKeyPem, deviceId]
    );
  }

  // ─── Challenge-response ────────────────────────────────────────────────────

  /**
   * Issue a nonce challenge for an approved device.
   * Nonce: 32 random bytes, hex-encoded. Expires in 60s.
   * 
   * Race-condition fix: if a valid (non-expired) challenge exists, return it
   * instead of overwriting. This handles rapid reconnects where device sends
   * multiple HELLOs before completing the first challenge-response.
   */
  async issueChallenge(deviceId: string): Promise<string> {
    const db = getDb();

    // Check for existing valid challenge (not expired)
    const existing = await db.query(
      `SELECT nonce FROM auth_challenges
       WHERE device_id = $1 AND expires_at > NOW()`,
      [deviceId]
    );
    if (existing.rows.length > 0) {
      // Return existing nonce — don't overwrite
      return existing.rows[0].nonce as string;
    }

    // No valid challenge — create new one
    const nonce = randomBytes(32).toString("hex");
    await db.query(
      `INSERT INTO auth_challenges (device_id, nonce, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '60 seconds')
       ON CONFLICT (device_id)
       DO UPDATE SET nonce = $2, expires_at = NOW() + INTERVAL '60 seconds'`,
      [deviceId, nonce]
    );

    return nonce;
  }

  /**
   * Verify CHALLENGE_RESPONSE signature.
   * Deletes the challenge row (nonce consumed — one-time-use).
   * Returns true if signature is valid, false otherwise.
   *
   * Signed message: raw nonce bytes (Buffer.from(nonce, 'hex'))
   * Algorithm: ECDSA-SHA256 (DER-encoded output from Android Keystore)
   */
  async verifyChallengeResponse(
    deviceId: string,
    signatureBase64: string
  ): Promise<boolean> {
    const db = getDb();

    // Consume nonce (DELETE — one-time use, also handles expiry check)
    const challengeRow = await db.query(
      `DELETE FROM auth_challenges
       WHERE device_id = $1 AND expires_at > NOW()
       RETURNING nonce`,
      [deviceId]
    );
    if (challengeRow.rows.length === 0) return false; // expired or not found

    const nonce: string = challengeRow.rows[0].nonce as string;

    // Fetch public key
    const deviceRow = await db.query(
      "SELECT public_key_pem FROM devices WHERE id = $1",
      [deviceId]
    );
    if (deviceRow.rows.length === 0 || !deviceRow.rows[0].public_key_pem) return false;

    const publicKeyPem: string = deviceRow.rows[0].public_key_pem as string;

    // Verify ECDSA-SHA256 signature
    // Message = raw nonce bytes (not hex string) — matches Android: update(hexToBytes(nonceHex))
    try {
      const verify = createVerify("SHA256");
      verify.update(Buffer.from(nonce, "hex"));
      return verify.verify(publicKeyPem, signatureBase64, "base64");
    } catch {
      return false; // malformed key or signature
    }
  }

  // ─── Metadata update ──────────────────────────────────────────────────────

  async updateDeviceMeta(deviceId: string, params: {
    model: string;
    androidVersion: string;
    agentVersion: string;
    ipAddress: string;
  }): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE devices
       SET model           = COALESCE(NULLIF($1, ''), model),
           android_version = COALESCE(NULLIF($2, ''), android_version),
           agent_version   = $3,
           last_ip         = $4,
           last_seen_at    = NOW()
       WHERE id = $5`,
      [params.model, params.androidVersion, params.agentVersion, params.ipAddress, deviceId]
    );
  }

  // ─── Approval ─────────────────────────────────────────────────────────────

  async approveDevice(deviceId: string, friendlyName?: string): Promise<boolean> {
    const db = getDb();
    const updates: string[] = [
      `status = lifecycle_transition_target(
         'devices'::regclass,
         status,
         '{"targetDispatchable":true,"manualAllowed":true}'::jsonb
       )`,
    ];
    const values: unknown[] = [deviceId];

    if (friendlyName) {
      values.push(friendlyName);
      updates.push(`friendly_name = $${values.length}`);
    }

    const result = await db.query(
      `UPDATE devices
       SET ${updates.join(", ")}
       WHERE id = $1
         AND lifecycle_state_matches('devices'::regclass, status, '{"initial":true}'::jsonb)
         AND lifecycle_transition_target(
               'devices'::regclass,
               status,
               '{"targetDispatchable":true,"manualAllowed":true}'::jsonb
             ) IS NOT NULL
       RETURNING id`,
      values
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ─── Revocation ───────────────────────────────────────────────────────────

  async revokeDevice(deviceId: string): Promise<void> {
    const db = getDb();
    await db.query(
      `UPDATE devices
       SET status = lifecycle_transition_target(
         'devices'::regclass,
         status,
         '{"targetTerminal":true,"manualAllowed":true}'::jsonb
       )
       WHERE id = $1
         AND lifecycle_transition_target(
               'devices'::regclass,
               status,
               '{"targetTerminal":true,"manualAllowed":true}'::jsonb
             ) IS NOT NULL`,
      [deviceId],
    );
  }
}

export const authService = new AuthService();
