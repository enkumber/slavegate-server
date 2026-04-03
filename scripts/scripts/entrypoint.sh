#!/bin/bash
# entrypoint.sh — Phone Network server startup sequence
set -euo pipefail

echo "[entrypoint] Phone Network v3.0.0 starting..."

DATA_DIR="${DATA_DIR:-/data}"

# Run DB migrations
echo "[entrypoint] Running database migrations..."
/app/scripts/migrate.sh

# Generate Nostr keys if needed (stores pubkey reference in /data)
echo "[entrypoint] Checking Nostr keypair..."
/app/scripts/generate-keys.sh

# If a bootstrap key was generated on this first run, inject it for the
# server process so it seeds itself into the DB. After first start, the
# server will find the key in the DB and the bootstrap file is no longer needed.
BOOTSTRAP_ENV_FILE="$DATA_DIR/.nostr-bootstrap-key"
if [ -f "$BOOTSTRAP_ENV_FILE" ] && [ -z "${NOSTR_SECRET_KEY:-}" ]; then
  echo "[entrypoint] Loading bootstrap Nostr key for first-run DB seeding..."
  # shellcheck source=/dev/null
  export NOSTR_SECRET_KEY
  NOSTR_SECRET_KEY=$(grep '^NOSTR_SECRET_KEY=' "$BOOTSTRAP_ENV_FILE" | cut -d= -f2-)
  # Remove bootstrap file — key is now seeded into DB by the server
  rm -f "$BOOTSTRAP_ENV_FILE"
  echo "[entrypoint] Bootstrap key loaded. File removed."
fi

# Start the server
echo "[entrypoint] Starting server on port ${PORT:-3000}..."
exec node dist/phone-network-server/src/index.js
