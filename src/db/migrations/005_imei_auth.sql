-- 005_imei_auth.sql
-- Migrates from dual-token auth to IMEI-based permanent auth.
-- Run after 004_phase4.sql.
--
-- ⚠️  WARNING — EXISTING DEVICES:
-- After this migration, all previously approved devices will re-appear as 'pending'
-- in the dashboard on their next connection (imei column is NULL → registerPending()
-- inserts a NEW row with their IMEI, separate from the old hardware_uuid-based row).
-- Admin must re-approve each device from the dashboard once.
-- Old rows (hardware_uuid-based, imei=NULL) remain in DB and can be cleaned up manually:
--   DELETE FROM devices WHERE imei IS NULL AND status != 'online';
--
-- device_tokens + revoked_tokens are now orphaned — dropped in 006_drop_token_tables.sql.

BEGIN;

-- 1. Add IMEI column to devices
ALTER TABLE devices ADD COLUMN IF NOT EXISTS imei TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_imei ON devices(imei) WHERE imei IS NOT NULL;

-- 2. hardware_uuid becomes nullable (was device identifier, now replaced by imei)
ALTER TABLE devices ALTER COLUMN hardware_uuid DROP NOT NULL;

-- 3. Device lifecycle policy is provisioned operationally in PostgreSQL.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;

COMMIT;
