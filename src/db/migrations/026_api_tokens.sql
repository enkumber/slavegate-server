-- API tokens for programmatic access (openclaw_agent, admin, monitoring)
-- Separate from device_tokens (which are for device auth linked to device_id)

CREATE TABLE IF NOT EXISTS api_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT        NOT NULL UNIQUE,   -- SHA-256 of the raw token
  purpose     TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ                   -- NULL = active, set = revoked
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash    ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_purpose ON api_tokens(purpose);
