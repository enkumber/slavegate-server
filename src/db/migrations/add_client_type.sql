-- Add type field to clients table for farming profiles
ALTER TABLE clients ADD COLUMN IF NOT EXISTS type TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_type ON clients(type);
