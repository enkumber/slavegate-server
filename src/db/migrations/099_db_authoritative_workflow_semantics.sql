-- Schema only. Runtime semantics are created and versioned through the
-- PostgreSQL control plane, never seeded or overwritten by an application
-- release.

CREATE TABLE IF NOT EXISTS runtime_semantic_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '*',
  status TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (namespace, entry_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_semantic_entries_lookup
  ON runtime_semantic_entries (namespace, platform, status, priority DESC);
