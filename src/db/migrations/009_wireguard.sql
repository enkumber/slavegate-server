-- 009_wireguard.sql
-- Add WireGuard peer tracking to devices table

ALTER TABLE devices ADD COLUMN IF NOT EXISTS wireguard_peer_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wireguard_ip TEXT;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_devices_wireguard_peer_id ON devices(wireguard_peer_id);
