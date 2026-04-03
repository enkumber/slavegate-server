#!/bin/bash
# migrate.sh — Run Phone Network database migrations
# Applies schema.sql (full idempotent schema) + any incremental migration files.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"

echo "[migrate] Connecting to database..."

# Helper: run SQL against the database
run_sql() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$1"
}

run_sql_file() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"
}

# ─── 1. Apply main schema (idempotent — CREATE TABLE IF NOT EXISTS) ──────────
echo "[migrate] Applying main schema..."
run_sql_file /app/schema.sql
echo "[migrate] Main schema applied."

# ─── 2. Ensure nostr_server_keys table exists (Nostr-specific) ───────────────
echo "[migrate] Ensuring Nostr tables..."
run_sql "
CREATE TABLE IF NOT EXISTS nostr_server_keys (
  id         TEXT        PRIMARY KEY DEFAULT 'default',
  secret_key_encrypted TEXT NOT NULL,
  public_key TEXT        NOT NULL,
  created_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  rotated_at TIMESTAMP
);
"

# ─── 3. Ensure nostr_event_log table exists ───────────────────────────────────
run_sql "
CREATE TABLE IF NOT EXISTS nostr_event_log (
  id         BIGSERIAL   PRIMARY KEY,
  event_id   TEXT        UNIQUE,
  kind       INTEGER,
  pubkey     TEXT,
  created_at INTEGER,
  logged_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nostr_event_log_logged_at ON nostr_event_log(logged_at);
CREATE INDEX IF NOT EXISTS idx_nostr_event_log_pubkey    ON nostr_event_log(pubkey);
"

# ─── 4. Auto-cleanup: remove events older than 7 days ────────────────────────
echo "[migrate] Cleaning up stale Nostr event log entries..."
DELETED=$(psql "$DATABASE_URL" -t -c "
DELETE FROM nostr_event_log WHERE logged_at < NOW() - INTERVAL '7 days';
SELECT ROW_COUNT();
" 2>/dev/null || echo "0")
echo "[migrate] Cleaned up old event log entries."

# ─── 5. Apply incremental migrations (ordered by filename) ───────────────────
MIGRATIONS_DIR="/app/migrations"
if [ -d "$MIGRATIONS_DIR" ] && [ "$(ls -A "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "[migrate] Applying incremental migrations from $MIGRATIONS_DIR..."

  # Create migrations tracking table if it doesn't exist
  run_sql "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT        PRIMARY KEY,
    applied_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  "

  for migration_file in "$MIGRATIONS_DIR"/*.sql; do
    filename=$(basename "$migration_file")
    applied=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM schema_migrations WHERE filename = '$filename';" | tr -d '[:space:]')

    if [ "$applied" = "0" ]; then
      echo "[migrate] Applying $filename..."
      run_sql_file "$migration_file"
      run_sql "INSERT INTO schema_migrations (filename) VALUES ('$filename') ON CONFLICT DO NOTHING;"
      echo "[migrate] Applied $filename."
    else
      echo "[migrate] Skipping $filename (already applied)."
    fi
  done
else
  echo "[migrate] No incremental migrations found."
fi

echo "[migrate] All migrations complete."
