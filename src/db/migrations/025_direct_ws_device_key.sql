-- Migration: 025_direct_ws_device_key
-- Adds device_key column for DirectWs authentication (v3 transport).
--
-- DirectWs auth flow:
--   Device → { type: "AUTH", deviceId, deviceKey }
--   Server validates deviceKey matches devices.device_key
--
-- Key generation: server auto-generates on device enrollment if null.
-- Key rotation: admin can reset via PATCH /api/devices/:id/rotate-key

ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_key TEXT UNIQUE;

-- Backfill: generate random keys for existing devices (hex 32 bytes)
UPDATE devices
SET device_key = encode(gen_random_bytes(32), 'hex')
WHERE device_key IS NULL;

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_devices_device_key ON devices(device_key);

-- Rollback:
-- ALTER TABLE devices DROP COLUMN IF EXISTS device_key;
-- DROP INDEX IF EXISTS idx_devices_device_key;
