/**
 * db/client.ts
 * PostgreSQL connection pool — single instance shared across modules.
 *
 * Pool sizing: driven by scalability.config.ts
 * - At 100 devices with max 50 concurrent workflows: ~50 connections needed
 * - Plus API handlers, admin queries, etc.
 * - Total pool max: configurable via DB_POOL_MAX (default 50)
 */

import { Pool } from "pg";
import { scalabilityConfig } from "../config/scalability.config";

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max:                      scalabilityConfig.dbPoolMax,
      idleTimeoutMillis:        scalabilityConfig.dbIdleTimeout,
      connectionTimeoutMillis:  scalabilityConfig.dbConnectionTimeout,
      statement_timeout:        scalabilityConfig.dbStatementTimeout,
    });

    pool.on("error", (err) => {
      console.error("[db] Unexpected pool error:", err.message);
    });
  }

  return pool;
}

/** Get pool statistics for monitoring */
export function getPoolStats(): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxCount: number;
} {
  if (!pool) return { totalCount: 0, idleCount: 0, waitingCount: 0, maxCount: 0 };
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxCount: scalabilityConfig.dbPoolMax,
  };
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
