-- Server-side LLM/VLM model and credential configuration.
-- Secrets are intentionally stored server-side only and redacted by API handlers.

CREATE TABLE IF NOT EXISTS model_configs (
  role                TEXT PRIMARY KEY CHECK (role IN ('decision_llm', 'vision_vlm')),
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

INSERT INTO model_configs (role, provider, endpoint, model, enabled)
VALUES
  ('decision_llm', 'openai_compatible', NULL, 'configure-me', FALSE),
  ('vision_vlm', 'openai_compatible', NULL, 'configure-me', FALSE)
ON CONFLICT (role) DO NOTHING;

-- Best-effort migration from legacy vision_config without carrying forward the
-- old Google default credential as an enabled runtime config.
UPDATE model_configs mc
SET provider = CASE WHEN vc.provider = 'google' THEN mc.provider ELSE vc.provider END,
    endpoint = CASE WHEN vc.provider = 'google' THEN mc.endpoint ELSE vc.endpoint END,
    model = CASE WHEN vc.provider = 'google' THEN mc.model ELSE vc.model END,
    credential_ref = CASE WHEN vc.provider = 'google' THEN mc.credential_ref ELSE vc.api_key_ref END,
    enabled = CASE WHEN vc.provider = 'google' THEN FALSE ELSE mc.enabled END,
    version = mc.version + 1,
    updated_at = NOW()
FROM vision_config vc
WHERE mc.role = 'vision_vlm'
  AND vc.id = 'default'
  AND vc.provider <> 'google'
  AND mc.model = 'configure-me';
