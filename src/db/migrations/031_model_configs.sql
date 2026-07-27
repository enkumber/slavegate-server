-- Server-side LLM/VLM model and credential configuration.
-- Secrets are intentionally stored server-side only and redacted by API handlers.

CREATE TABLE IF NOT EXISTS model_configs (
  role                TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  endpoint            TEXT,
  model               TEXT NOT NULL,
  api_key_encrypted   TEXT,
  credential_ref      TEXT,
  api_key_fingerprint TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  version             INT NOT NULL DEFAULT 1,
  last_test_status    TEXT,
  last_test_message   TEXT,
  last_test_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_model_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_configs_updated_at ON model_configs;
CREATE TRIGGER trg_model_configs_updated_at
BEFORE UPDATE ON model_configs
FOR EACH ROW EXECUTE FUNCTION set_model_configs_updated_at();

-- Provider roles and credentials are configured operationally after migration.
