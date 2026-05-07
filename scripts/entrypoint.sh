#!/bin/bash
# entrypoint.sh — Phone Network server startup sequence
set -euo pipefail

echo "[entrypoint] Phone Network v3.0.0 starting..."

DATA_DIR="${DATA_DIR:-/data}"

# Run DB migrations (non-blocking — log errors but continue)
echo "[entrypoint] Running database migrations..."
/app/scripts/migrate.sh || {
  echo "[entrypoint] WARNING: Migrations had errors, continuing with server startup..."
}

# Start the server
echo "[entrypoint] Starting server on port ${PORT:-21211}..."
exec node dist/src/index.js
