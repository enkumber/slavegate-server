#!/bin/bash
# migrate.sh — Run Phone Network database migrations
# Applies schema.sql (full idempotent schema) + any incremental migration files.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"

# Extract password from DATABASE_URL for psql (handles passwordless URLs too)
export PGPASSWORD="$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')"

echo "[migrate] Connecting to database..."

# Helper: run SQL against the database
run_sql() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-password -c "$1"
}

run_sql_file() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-password -f "$1"
}

# ─── 1. Apply main schema (idempotent — CREATE TABLE IF NOT EXISTS) ──────────
echo "[migrate] Applying main schema..."
run_sql_file /app/schema.sql
echo "[migrate] Main schema applied."

# ─── 2. Apply incremental migrations (ordered by filename) ───────────────────
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
