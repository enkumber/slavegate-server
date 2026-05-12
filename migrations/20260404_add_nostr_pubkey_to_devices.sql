-- Add nostr_pubkey column to devices table for Nostr transport enrollment
ALTER TABLE devices ADD COLUMN IF NOT EXISTS nostr_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_devices_nostr_pubkey ON devices(nostr_pubkey) WHERE nostr_pubkey IS NOT NULL;
