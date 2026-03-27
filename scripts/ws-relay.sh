#!/bin/bash
# ws-relay.sh — WebSocket relay from host:18791 to OpenClaw container:18791
#
# RECOMMENDED: Use Docker-network method (Option B) — survives reboots without re-running script.
# Option A (dynamic IP resolution) is a fallback if network sharing is not possible.
#
# Usage:
#   sudo bash ws-relay.sh            # start/restart relay (Option B by default)
#   sudo bash ws-relay.sh --ip       # force Option A (dynamic IP resolution)
#
# Requirements: docker, alpine/socat image available

set -euo pipefail

CONTAINER_NAME="openclaw_gateway_1"
RELAY_NAME="ws-relay"
PORT=18791
METHOD="${1:-}"

# ─── Remove old relay ─────────────────────────────────────────────────────────
echo "Removing old relay if exists..."
docker rm -f "$RELAY_NAME" 2>/dev/null || true

# ─── Option B: Docker network DNS (RECOMMENDED) ───────────────────────────────
# Uses Docker's internal DNS — openclaw_gateway_1 resolves automatically.
# Survives container restarts and reboots without re-running this script.
if [ "$METHOD" != "--ip" ]; then
    # Detect the network openclaw_gateway_1 is on
    NETWORK=$(docker inspect "$CONTAINER_NAME" \
        --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null | head -1)

    if [ -z "$NETWORK" ]; then
        echo "WARNING: Cannot detect network for $CONTAINER_NAME, falling back to --ip mode"
        METHOD="--ip"
    else
        echo "Detected network: $NETWORK"
        echo "Starting ws-relay via Docker DNS: $CONTAINER_NAME:${PORT}"

        docker run -d \
            --name "$RELAY_NAME" \
            --restart=always \
            --network="$NETWORK" \
            -p "${PORT}:${PORT}" \
            alpine/socat \
            TCP-LISTEN:${PORT},fork,reuseaddr \
            TCP:${CONTAINER_NAME}:${PORT}

        echo "ws-relay started (DNS): host:${PORT} -> ${CONTAINER_NAME}:${PORT} (network: ${NETWORK})"
        exit 0
    fi
fi

# ─── Option A: Dynamic IP resolution (fallback) ───────────────────────────────
# Resolves container IP at script run time.
# NOTE: if container restarts with a new IP, relay must be re-run.
CONTAINER_IP=$(docker inspect "$CONTAINER_NAME" \
    --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | head -1)

if [ -z "$CONTAINER_IP" ]; then
    echo "ERROR: Cannot find container $CONTAINER_NAME"
    echo "Is openclaw running? Try: docker ps | grep openclaw"
    exit 1
fi

echo "Resolved $CONTAINER_NAME -> $CONTAINER_IP"
echo "Starting ws-relay via IP: host:${PORT} -> ${CONTAINER_IP}:${PORT}"

docker run -d \
    --name "$RELAY_NAME" \
    --restart=always \
    --network=host \
    alpine/socat \
    TCP-LISTEN:${PORT},fork,reuseaddr,keepalive,keepidle=30,keepintvl=10,keepcnt=3 \
    TCP:${CONTAINER_IP}:${PORT},keepalive,keepidle=30,keepintvl=10,keepcnt=3

echo "ws-relay started (IP): host:${PORT} -> ${CONTAINER_IP}:${PORT}"
echo "WARNING: If $CONTAINER_NAME restarts with a new IP, re-run this script."
