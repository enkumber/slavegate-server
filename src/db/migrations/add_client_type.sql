-- Add type field to clients table for farming profiles
ALTER TABLE clients ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'client' CHECK (type IN ('client', 'farming'));
CREATE INDEX IF NOT EXISTS idx_clients_type ON clients(type);