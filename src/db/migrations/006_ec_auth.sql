-- 006_ec_auth.sql
-- Adds EC public key storage for ECDSA-P256 device authentication.
-- Replaces HMAC device_secret_enc with public_key_pem (server stores no secret).
-- Run after 005_imei_auth.sql.
--
-- Security benefit: compromising the server exposes only public keys (worthless to attacker).
-- Private keys remain hardware-backed in Android Keystore (non-exportable).
--
-- Note: device_secret_enc column (if added by a prior migration) is no longer used.
-- Drop it in 007_cleanup.sql after all devices have re-connected with EC keys.

BEGIN;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_key_pem TEXT;

-- Ensure IMEI index exists (idempotent — created in 005 but guard here too)
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_imei ON devices(imei) WHERE imei IS NOT NULL;

COMMIT;
