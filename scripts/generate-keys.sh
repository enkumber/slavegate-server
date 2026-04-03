#!/bin/bash
# generate-keys.sh — First-run Nostr keypair generation for Phone Network
#
# Priority:
#   1. NOSTR_SECRET_KEY env var is set → use it (no file write needed; server handles it)
#   2. /data/nostr-pubkey.txt exists   → keys already in DB, skip
#   3. Otherwise → check DB, server will auto-generate on startup
#
# This script exports the PUBLIC KEY to /data/nostr-pubkey.txt so the
# Umbrel dashboard and operators can easily find the server's Nostr pubkey
# for device enrollment without digging into the database.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
PUBKEY_FILE="$DATA_DIR/nostr-pubkey.txt"
INFO_FILE="$DATA_DIR/nostr-info.json"

mkdir -p "$DATA_DIR"

# ─── Case 1: Env override ────────────────────────────────────────────────────
if [ -n "${NOSTR_SECRET_KEY:-}" ]; then
  echo "[keys] NOSTR_SECRET_KEY is set via environment — server will use it directly."
  echo "[keys] Keypair source: environment variable"

  # Derive pubkey from the secret key using node + nostr-tools
  PUBKEY=$(node -e "
    const { getPublicKey } = require('nostr-tools');
    const sk = Uint8Array.from(Buffer.from(process.env.NOSTR_SECRET_KEY, 'hex'));
    console.log(getPublicKey(sk));
  " 2>/dev/null || echo "")

  if [ -n "$PUBKEY" ]; then
    echo "$PUBKEY" > "$PUBKEY_FILE"
    cat > "$INFO_FILE" <<EOF
{
  "source": "env",
  "public_key": "$PUBKEY",
  "note": "Secret key loaded from NOSTR_SECRET_KEY env var"
}
EOF
    echo "[keys] Server public key: $PUBKEY"
    echo "[keys] Public key saved to $PUBKEY_FILE"
  fi
  exit 0
fi

# ─── Case 2: Pubkey file exists → keys already provisioned ──────────────────
if [ -f "$PUBKEY_FILE" ]; then
  EXISTING_PUBKEY=$(cat "$PUBKEY_FILE")
  echo "[keys] Existing server public key found: $EXISTING_PUBKEY"
  echo "[keys] Keypair source: database (loaded from $PUBKEY_FILE)"
  exit 0
fi

# ─── Case 3: First run — generate keypair and store in DB ────────────────────
echo "[keys] No existing keypair found. Generating new secp256k1 Nostr keypair..."

# Generate keypair using nostr-tools (available in node_modules)
KEYGEN_OUTPUT=$(node -e "
const { generateSecretKey, getPublicKey } = require('nostr-tools');
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const skHex = Buffer.from(sk).toString('hex');
console.log(JSON.stringify({ secret_key: skHex, public_key: pk }));
" 2>/dev/null)

if [ -z "$KEYGEN_OUTPUT" ]; then
  echo "[keys] ERROR: Failed to generate Nostr keypair. Check that nostr-tools is installed."
  exit 1
fi

SECRET_KEY=$(echo "$KEYGEN_OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(d.secret_key)")
PUBLIC_KEY=$(echo "$KEYGEN_OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(d.public_key)")

echo "[keys] Generated new keypair."
echo "[keys] Public key: $PUBLIC_KEY"
echo "[keys] *** Share this public key with Android devices for enrollment ***"

# Store public key reference file (NO secret key in files — server keeps it in DB)
echo "$PUBLIC_KEY" > "$PUBKEY_FILE"
cat > "$INFO_FILE" <<EOF
{
  "source": "generated",
  "public_key": "$PUBLIC_KEY",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "Secret key is stored encrypted in the database (nostr_server_keys table). Do NOT store secret key in files."
}
EOF

# Inject the generated secret key into the environment so the server startup
# can seed it into the database on first connect (via NOSTR_SECRET_KEY bootstrap).
# Write to a temp env file that entrypoint.sh sources before starting the server.
BOOTSTRAP_ENV_FILE="$DATA_DIR/.nostr-bootstrap-key"
if [ ! -f "$BOOTSTRAP_ENV_FILE" ]; then
  echo "NOSTR_SECRET_KEY=$SECRET_KEY" > "$BOOTSTRAP_ENV_FILE"
  chmod 600 "$BOOTSTRAP_ENV_FILE"
  echo "[keys] Bootstrap key written to $BOOTSTRAP_ENV_FILE (will be consumed on first server start)."
fi

echo "[keys] Keypair generation complete."
echo "[keys] Public key saved to: $PUBKEY_FILE"
