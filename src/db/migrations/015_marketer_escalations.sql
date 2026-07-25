-- Migration 015: Marketer Escalations
-- Tabel pentru întrebările generate de Marketer când lipsesc date

CREATE TABLE IF NOT EXISTS marketer_escalations (
  id              TEXT        PRIMARY KEY,  -- format: {account_id}-{category}
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_username TEXT       NOT NULL,
  client_name     TEXT        NOT NULL,
  category        TEXT        NOT NULL CHECK (category IN ('session_config', 'daily_limits', 'timing', 'engagement', 'safety')),
  question        TEXT        NOT NULL,
  context         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  options         JSONB,      -- Array de opțiuni sugerate
  status          TEXT        NOT NULL,
  answer          JSONB,      -- Răspunsul lui Dan
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_escalations_status ON marketer_escalations(status);
CREATE INDEX IF NOT EXISTS idx_escalations_account ON marketer_escalations(account_id);
CREATE INDEX IF NOT EXISTS idx_escalations_category ON marketer_escalations(category);
CREATE INDEX IF NOT EXISTS idx_escalations_created ON marketer_escalations(created_at DESC);

COMMENT ON TABLE marketer_escalations IS 'Întrebări de la Marketer când nu știe ce valori să folosească. Dan trebuie să răspundă.';
