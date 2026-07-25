-- Migration 014: Marketing Schema Alignment
-- Aliniază schema DB cu serviciile Marketer, Tactician, Siren

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLIENTS — Adaugă status column (Marketer folosește WHERE status = 'active')
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS status TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MATERIALS — Adaugă coloane lipsă pentru Siren
-- ═══════════════════════════════════════════════════════════════════════════════

-- client_id (Siren folosește materials per client, nu per account)
ALTER TABLE materials 
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE CASCADE;

-- tags pentru matching cu content themes
ALTER TABLE materials 
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- used_at pentru tracking reuse (Siren folosește used_at, nu used boolean)
ALTER TABLE materials 
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Migrează din used boolean în used_at
UPDATE materials SET used_at = NOW() WHERE used = true AND used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_materials_client ON materials(client_id);
CREATE INDEX IF NOT EXISTS idx_materials_used_at ON materials(used_at);
CREATE INDEX IF NOT EXISTS idx_materials_tags ON materials USING GIN(tags);

-- ═══════════════════════════════════════════════════════════════════════════════
-- POSTS — Extinde status values pentru Siren workflow
-- ═══════════════════════════════════════════════════════════════════════════════

-- Product lifecycle policy is provisioned in PostgreSQL outside migrations.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACCOUNTS — Asigură coloanele necesare pentru Marketer
-- ═══════════════════════════════════════════════════════════════════════════════

-- updated_at pentru tracking strategy updates
ALTER TABLE accounts 
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Trigger pentru auto-update
CREATE OR REPLACE FUNCTION accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION accounts_updated_at();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (comentate, pentru debug)
-- ═══════════════════════════════════════════════════════════════════════════════

-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'clients';
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'materials';
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'posts';
