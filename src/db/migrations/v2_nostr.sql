-- Migration: v2_nostr
-- Sprint 1: Nostr Foundation — schema changes for Nostr protocol migration
-- Created: 2026-04-03

-- ─── Devices table: add Nostr pubkey ─────────────────────────────────────────

ALTER TABLE devices ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT UNIQUE;

-- ─── Devices table: remove WireGuard columns (no longer needed) ───────────────

ALTER TABLE devices DROP COLUMN IF EXISTS wireguard_peer_id;
ALTER TABLE devices DROP COLUMN IF EXISTS wireguard_ip;

-- ─── Devices table: remove auth challenge columns (Nostr-native auth) ─────────

ALTER TABLE devices DROP COLUMN IF EXISTS challenge_nonce;
ALTER TABLE devices DROP COLUMN IF EXISTS challenge_expires_at;
ALTER TABLE devices DROP COLUMN IF EXISTS public_key_pem;

-- ─── Index for pubkey lookups ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_devices_nostr_pubkey ON devices(nostr_pubkey);

-- ─── Server keypair storage ────────────────────────────────────────────────────
-- Stores the server's Nostr secp256k1 keypair.
-- secret_key_encrypted is encrypted with CREDENTIAL_ENCRYPTION_KEY env var.

CREATE TABLE IF NOT EXISTS nostr_server_keys (
  id TEXT PRIMARY KEY DEFAULT 'default',
  secret_key_encrypted TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  previous_public_key TEXT
);

COMMENT ON COLUMN nostr_server_keys.rotated_at IS 'Timestamp of last key rotation';
COMMENT ON COLUMN nostr_server_keys.previous_public_key IS 'Previous pubkey for graceful rotation';

-- ─── Event log ────────────────────────────────────────────────────────────────
-- Audit log for processed Nostr events.
-- Auto-cleanup: delete entries older than 7 days via a cron or periodic job.

CREATE TABLE IF NOT EXISTS nostr_event_log (
  event_id TEXT PRIMARY KEY,
  kind INTEGER NOT NULL,
  device_id UUID,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_event_log_processed_at ON nostr_event_log(processed_at);

-- ─── Rollback script (for reference) ─────────────────────────────────────────
-- To revert this migration:
--
-- ALTER TABLE devices DROP COLUMN IF EXISTS nostr_pubkey;
-- DROP INDEX IF EXISTS idx_devices_nostr_pubkey;
-- DROP TABLE IF EXISTS nostr_server_keys;
-- DROP TABLE IF EXISTS nostr_event_log;
-- DROP INDEX IF EXISTS idx_event_log_processed_at;
--
-- Note: Dropped WireGuard + challenge columns cannot be restored automatically.
-- Restore from backup or re-run the WireGuard/auth migrations if needed.
