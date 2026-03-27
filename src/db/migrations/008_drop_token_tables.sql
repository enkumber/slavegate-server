-- 006_drop_token_tables.sql
-- Drops token tables made obsolete by IMEI-based auth (005_imei_auth.sql).
-- Run AFTER 005_imei_auth.sql AND after verifying all devices are re-approved.
--
-- ⚠️  WARNING — DATA LOSS: this is irreversible.
-- Before running, confirm:
--   1. All active devices have re-connected and been approved (imei IS NOT NULL)
--   2. Historical token audit data is no longer needed
--   3. No rollback to token-based auth is planned
--
-- Safe to run on a fresh install (IF NOT EXISTS guards on original schema mean these
-- tables may not exist; DROP IF EXISTS handles that gracefully).

BEGIN;

DROP TABLE IF EXISTS revoked_tokens;
DROP TABLE IF EXISTS device_tokens;
DROP TABLE IF EXISTS registration_codes;

COMMIT;
