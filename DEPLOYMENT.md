# Phone Network Server — Deployment Guide

## Prerequisites

### 1. Redis

Redis is required for BullMQ (workflow queue, job dispatcher).

**Install on Umbrel/Docker host:**
```bash
docker run -d \
  --name redis \
  --restart unless-stopped \
  -p 6379:6379 \
  -v /data/redis:/data \
  redis:alpine redis-server --appendonly yes
```

**Verify:**
```bash
docker exec redis redis-cli ping
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
