-- 007_auth_challenges.sql
-- Adds nonce-based challenge table for EC key pair challenge-response auth.
-- Device signs nonce with EC private key; server verifies with stored public_key_pem.
-- Nonces expire after 60s — prevents replay attacks.
-- Run after 006_ec_auth.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS auth_challenges (
  device_id   UUID        PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  nonce       TEXT        NOT NULL,       -- 32 bytes, hex-encoded
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '60 seconds'
);

COMMIT;
