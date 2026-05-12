/**
 * redis/client.ts
 * Shared Redis connection for BullMQ and pub/sub.
 *
 * BullMQ bundles its own ioredis version and expects either:
 * - A plain connection options object { host, port } — recommended for BullMQ queues
 * - Its own IORedis instance
 *
 * We export both: connection options for BullMQ, and an IORedis instance for
 * any direct Redis operations (future pub/sub etc.)
 */

import IORedis from "ioredis";

let redis: IORedis | null = null;

// Suppress repeated Redis errors — log once per minute max
let lastRedisError = 0;
const REDIS_ERROR_THROTTLE_MS = 60_000;

export function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
        return Math.min(times * 1000, 30_000);
      },
    });

    redis.on("error", (err) => {
      const now = Date.now();
      if (now - lastRedisError > REDIS_ERROR_THROTTLE_MS) {
        console.error("[redis] Connection error (throttled, 1/min):", err.message);
        lastRedisError = now;
      }
    });

    redis.on("connect", () => {
      console.log("[redis] Connected.");
    });
  }

  return redis;
}

/**
 * Parse REDIS_URL into a plain host/port object for BullMQ.
 * BullMQ has its own bundled ioredis — passing our IORedis instance
 * causes type mismatch errors due to differing internal versions.
 */
export function getRedisConnectionOptions(): { host: string; port: number; password?: string } {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
