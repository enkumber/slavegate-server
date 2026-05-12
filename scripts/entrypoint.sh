#!/bin/bash
# entrypoint.sh — Phone Network server startup sequence
# Migrations are handled by Node.js (db/migrate.ts) at server startup.
# Shell-based migration removed — it was killing the container on any SQL error.

DATA_DIR="${DATA_DIR:-/data}"

echo "[entrypoint] Phone Network starting..."
echo "[entrypoint] Migrations will run automatically via Node.js."

# Start the server (auto-migrate happens inside index.ts before Express starts)
exec node dist/src/index.js
