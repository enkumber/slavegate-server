# Phone Network Server — Deployment Guide

## Prerequisites

### 1. Redis

Redis is required for BullMQ (workflow queue, job dispatcher).

**Current setup: Redis installed natively via Homebrew**

Redis runs as a managed PM2 process (see `ecosystem.config.cjs`). The startup script is at `scripts/start-redis.sh`.

```bash
# Start everything (Redis + server) with PM2:
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # enables PM2 auto-start on reboot
```

Redis starts automatically before the app server because PM2 launches apps in order.

**If Redis is not installed:**
```bash
brew install redis
# Verify:
/home/linuxbrew/.linuxbrew/bin/redis-server --version
```

**Alternative: Docker-based Redis** (for containerized deployments):
```bash
docker run -d \
  --name redis \
  --restart unless-stopped \
  -p 6379:6379 \
  -v /data/redis:/data \
  redis:alpine redis-server --appendonly yes
```

If using Docker Redis, remove the `redis` entry from `ecosystem.config.cjs` (PM2 shouldn't manage it).

**Verify Redis is running:**
```bash
redis-cli ping
# Should respond: PONG
```

**Environment variable** (in `.env`):
```
REDIS_URL=redis://localhost:6379
```

### 2. PostgreSQL

Database must be running and accessible.

**Environment variable:**
```
DATABASE_URL=postgresql://user:pass@host:5432/phone_network
```

### 3. Node.js

Node.js 18+ required.

---

## Deployment

### Start server with PM2:
```bash
cd /path/to/phone-network-server
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

### Verify:
```bash
pm2 logs phone-network-server --lines 50
# Should see: [redis] Connected.
# Should NOT see: ECONNREFUSED
```

---

## Troubleshooting

### Redis connection errors
```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Fix:** Ensure Redis container is running:
```bash
docker ps | grep redis
# If not running:
docker start redis
# Or recreate:
docker run -d --name redis --restart unless-stopped -p 6379:6379 redis:alpine
```

### Redis data persistence

The `-v /data/redis:/data` mount ensures Redis data survives container restarts.
The `--appendonly yes` flag enables AOF persistence.

---

## Architecture Notes

- **Redis** is used by BullMQ for:
  - Workflow queue (`workflow.executor.ts`)
  - Per-device job dispatcher (`dispatcher.service.ts`)
  - Alert cooldowns (`observability/alerts.ts`)

- **Task Runner** (`task-runner.service.ts`) polls PostgreSQL directly — does NOT require Redis.

- If Redis is unavailable, workflows and job dispatch will fail, but the server will continue running.

---

## WS-Relay (WebSocket Relay pentru telefoane)

Telefoanele se conectează la server prin WireGuard. Trebuie un relay care să expună portul 18791 de pe containerul OpenClaw pe host-ul Umbrel.

### Setup ws-relay

```bash
# 1. Află IP-ul containerului OpenClaw
docker inspect openclaw_gateway_1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# SAU din interiorul containerului: hostname -I

# 2. Pornește ws-relay cu IP-ul obținut (înlocuiește X.X.X.X)
docker rm -f ws-relay
docker run -d --name ws-relay --restart=always --network=host alpine/socat TCP-LISTEN:18791,fork,reuseaddr TCP:X.X.X.X:18791
```

**Exemplu concret:**
```bash
docker rm -f ws-relay
docker run -d --name ws-relay --restart=always --network=host alpine/socat TCP-LISTEN:18791,fork,reuseaddr TCP:10.21.0.6:18791
```

### Verificare

```bash
# Trebuie să returneze 401 (nu 000)
curl -s -o /dev/null -w "%{http_code}" http://192.168.50.57:18791/api/devices

# Status relay
docker ps | grep ws-relay
docker logs ws-relay
```

### ⚠️ IMPORTANT

**IP-ul containerului se schimbă la fiecare reboot Umbrel!** După reboot:
1. Verifică noul IP al containerului OpenClaw
2. Recrează ws-relay cu IP-ul nou

**Documentație completă:** `scripts/WS-RELAY.md`
