import type { PoolClient } from "pg";
import { getDb } from "../../db/client";

const issuedContexts = new WeakSet<object>();
const leaseContextBrand: unique symbol = Symbol("device-execution-lease");

export interface DeviceExecutionLeaseContext {
  readonly deviceId: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly fencingToken: number;
  readonly [leaseContextBrand]: true;
}

export function requireDeviceExecutionLeaseContext(
  deviceId: string,
  value: unknown,
): asserts value is DeviceExecutionLeaseContext {
  if (!value || typeof value !== "object" || !issuedContexts.has(value as object)) {
    throw new Error("DEVICE_EXECUTION_LEASE_REQUIRED");
  }
  if ((value as DeviceExecutionLeaseContext).deviceId !== deviceId) {
    throw new Error("DEVICE_EXECUTION_LEASE_DEVICE_MISMATCH");
  }
}

export interface AcquireLeaseInput {
  deviceId: string;
  ownerId: string;
  runId: string;
  ingress: string;
  requestKey?: string;
  ttlMs?: number;
}

export class DeviceBusyError extends Error {
  constructor() { super("DEVICE_BUSY"); }
}

export class DeviceExecutionLeaseService {
  async acquire(input: AcquireLeaseInput): Promise<DeviceExecutionLeaseContext> {
    const client = await getDb().connect();
    try {
      await client.query("BEGIN");
      const lease = await this.acquireInTransaction(client, input);
      await client.query("COMMIT");
      return lease;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async acquireInTransaction(client: Pick<PoolClient, "query">, input: AcquireLeaseInput): Promise<DeviceExecutionLeaseContext> {
    const ttlMs = Math.max(1_000, input.ttlMs ?? 300_000);
    await client.query(
      `INSERT INTO device_execution_fences (device_id, last_token) VALUES ($1, 0)
       ON CONFLICT (device_id) DO NOTHING`, [input.deviceId],
    );
    await client.query(`SELECT last_token FROM device_execution_fences WHERE device_id=$1 FOR UPDATE`, [input.deviceId]);
    const current = await client.query(
      `SELECT owner_id, run_id, fencing_token, expires_at FROM device_execution_leases
       WHERE device_id=$1 FOR UPDATE`, [input.deviceId],
    );
    const row = current.rows[0];
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      if (row.owner_id !== input.ownerId || row.run_id !== input.runId) throw new DeviceBusyError();
      return this.issue(input, Number(row.fencing_token));
    }
    const fence = await client.query(
      `UPDATE device_execution_fences SET last_token=last_token+1 WHERE device_id=$1 RETURNING last_token`,
      [input.deviceId],
    );
    const token = Number(fence.rows[0].last_token);
    await client.query(
      `INSERT INTO device_execution_leases
       (device_id, owner_id, run_id, ingress, request_key, fencing_token, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',now()+($7::text || ' milliseconds')::interval)
       ON CONFLICT (device_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, run_id=EXCLUDED.run_id,
       ingress=EXCLUDED.ingress, request_key=EXCLUDED.request_key, fencing_token=EXCLUDED.fencing_token,
       state='active', acquired_at=now(), heartbeat_at=now(), expires_at=EXCLUDED.expires_at,
       released_at=NULL, cancel_reason=NULL`,
      [input.deviceId, input.ownerId, input.runId, input.ingress, input.requestKey ?? null, token, ttlMs],
    );
    return this.issue(input, token);
  }

  private issue(input: AcquireLeaseInput, fencingToken: number): DeviceExecutionLeaseContext {
    const context = Object.freeze({
      deviceId: input.deviceId, ownerId: input.ownerId, runId: input.runId, fencingToken,
      [leaseContextBrand]: true as const,
    });
    issuedContexts.add(context);
    return context;
  }
}

export const deviceExecutionLeaseService = new DeviceExecutionLeaseService();
