import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { getDb } from "../../db/client";

const LEASE_BRAND = Symbol("device-execution-lease");
export interface LeaseContext {
  readonly deviceId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly ingress: string;
  readonly requestKey: string;
  readonly expiresAt: number;
  readonly [LEASE_BRAND]: true;
}
export type LeaseErrorCode = "DEVICE_BUSY" | "LEASE_EXPIRED" | "LEASE_STALE" | "LEASE_CANCELLED" | "LEASE_PERSIST_FAILED";
export class DeviceLeaseError extends Error {
  constructor(readonly code: LeaseErrorCode, message: string) { super(message); }
}

export interface LeaseRequest {
  ownerId?: string;
  ingress: string;
  requestKey?: string;
  attempt?: number;
}

interface LeaseRow {
  device_id: string;
  owner_id: string;
  ingress: string;
  request_key: string;
  fencing_token: string | number;
  expires_at: Date | string;
  state: string;
}

/** PostgreSQL is the source of truth. Every contender first joins the durable FIFO. */
export class DeviceExecutionLeaseService {
  private readonly issued = new WeakSet<object>();
  private readonly current = new Map<string, LeaseContext>();
  private readonly scope = new AsyncLocalStorage<LeaseContext>();
  private readonly workflowScoped = new WeakSet<object>();

  constructor(
    private readonly ttlMs = 300_000,
    private readonly disconnectGraceMs = 30_000,
    private readonly pollMs = 20,
  ) {}

  async reconcileStartup(): Promise<void> {
    const db = getDb();
    await db.query("BEGIN");
    try {
      const reconciled = await db.query(`
        WITH expired AS (
          UPDATE device_execution_leases
             SET state='expired', released_at=COALESCE(released_at,now()), updated_at=now()
           WHERE state IN ('active','recovering') AND expires_at <= now()
           RETURNING device_id, owner_id, fencing_token, ingress, request_key
        ), audited AS (
        INSERT INTO device_execution_lease_history(device_id,owner_id,fencing_token,ingress,request_key,event,details)
        SELECT device_id,owner_id,fencing_token,ingress,request_key,'startup_expired','{}'::jsonb FROM expired
        )
        SELECT device_id,owner_id,fencing_token,ingress,request_key,expires_at,state
          FROM device_execution_leases
         WHERE state IN ('active','recovering') AND expires_at > now()`);
      await db.query(`
        WITH cancelled AS (
          UPDATE device_execution_lease_queue
             SET cancelled_at=now(), cancel_reason='startup_deadline_expired'
           WHERE cancelled_at IS NULL AND deadline_at <= now()
           RETURNING device_id,owner_id,ingress,request_key
        )
        INSERT INTO device_execution_lease_history(device_id,owner_id,ingress,request_key,event,details)
        SELECT device_id,owner_id,ingress,request_key,'queue_expired','{}'::jsonb FROM cancelled`);
      await db.query("COMMIT");
      for (const row of reconciled.rows ?? []) this.remember(row as LeaseRow);
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw new DeviceLeaseError("LEASE_PERSIST_FAILED", `startup reconciliation failed: ${(error as Error).message}`);
    }
  }

  activeContext(): LeaseContext | undefined { return this.scope.getStore(); }

  async runWithLease<T>(deviceId: string, input: LeaseRequest, block: (lease: LeaseContext) => Promise<T>, waitMs = 30_000): Promise<T> {
    const inherited = this.scope.getStore();
    if (inherited) {
      if (inherited.deviceId !== deviceId) throw new DeviceLeaseError("LEASE_STALE", "nested execution cannot change devices");
      this.assertCurrent(inherited);
      return block(inherited);
    }
    const lease = await this.acquire(deviceId, input, waitMs);
    this.workflowScoped.add(lease as object);
    try { return await this.scope.run(lease, () => block(lease)); }
    finally { this.workflowScoped.delete(lease as object); await this.release(lease); }
  }

  async acquire(deviceId: string, input: LeaseRequest, waitMs = 30_000): Promise<LeaseContext> {
    const ownerId = input.ownerId ?? randomUUID();
    const requestKey = input.requestKey ?? ownerId;
    // The row must remain claimable for the initial atomic attempt even when the
    // caller requested a non-blocking acquire.
    const waitDeadline = Date.now() + Math.max(0, waitMs);
    // Keep the durable row eligible through scheduling/DB latency around the
    // final claim; waitDeadline still enforces the caller-visible timeout.
    const deadline = waitDeadline + Math.max(100, this.pollMs * 2);
    try {
      await getDb().query(`
        INSERT INTO device_execution_lease_queue(device_id,owner_id,ingress,request_key,attempt,deadline_at)
        VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
        ON CONFLICT(device_id,request_key) DO UPDATE
          SET deadline_at=GREATEST(device_execution_lease_queue.deadline_at,EXCLUDED.deadline_at)
        WHERE device_execution_lease_queue.cancelled_at IS NULL`,
        [deviceId, ownerId, input.ingress, requestKey, input.attempt ?? 1, deadline]);
    } catch (error) {
      throw new DeviceLeaseError("LEASE_PERSIST_FAILED", `lease enqueue failed: ${(error as Error).message}`);
    }

    do {
      const lease = await this.claimHead(deviceId, ownerId, input.ingress, requestKey, input.attempt ?? 1);
      if (lease) return lease;
      if (Date.now() >= waitDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollMs, Math.max(1, waitDeadline - Date.now()))));
    } while (true);

    await this.cancelQueued(deviceId, requestKey, "wait_deadline_exceeded");
    throw new DeviceLeaseError("DEVICE_BUSY", `device ${deviceId} lease wait deadline exceeded`);
  }

  private async claimHead(deviceId: string, ownerId: string, ingress: string, requestKey: string, attempt: number): Promise<LeaseContext | null> {
    const expiresAt = Date.now() + this.ttlMs;
    let result;
    try {
      result = await getDb().query(`
        WITH expired_queue AS (
          UPDATE device_execution_lease_queue
             SET cancelled_at=now(), cancel_reason='deadline_expired'
           WHERE device_id=$1 AND cancelled_at IS NULL AND deadline_at <= now()
           RETURNING device_id,owner_id,ingress,request_key
        ), expired_audit AS (
          INSERT INTO device_execution_lease_history(device_id,owner_id,ingress,request_key,event,details)
          SELECT device_id,owner_id,ingress,request_key,'queue_expired','{}'::jsonb FROM expired_queue
        ), head AS (
          SELECT id,device_id,owner_id,ingress,request_key,attempt
            FROM device_execution_lease_queue
           WHERE device_id=$1 AND cancelled_at IS NULL AND deadline_at > now()
           ORDER BY created_at,id LIMIT 1
        ), claimed AS (
          INSERT INTO device_execution_leases(device_id,owner_id,ingress,request_key,attempt,state,fencing_token,acquired_at,heartbeat_at,expires_at,released_at,updated_at)
          SELECT device_id,owner_id,ingress,request_key,attempt,'active',nextval('device_execution_fencing_seq'),now(),now(),to_timestamp($5/1000.0),NULL,now()
            FROM head WHERE owner_id=$2 AND request_key=$4
          ON CONFLICT(device_id) DO UPDATE SET
            owner_id=EXCLUDED.owner_id, ingress=EXCLUDED.ingress, request_key=EXCLUDED.request_key,
            attempt=EXCLUDED.attempt, state='active', fencing_token=EXCLUDED.fencing_token,
            acquired_at=now(), heartbeat_at=now(), expires_at=EXCLUDED.expires_at, released_at=NULL, updated_at=now()
          WHERE device_execution_leases.state IN ('released','cancelled','expired') OR device_execution_leases.expires_at <= now()
          RETURNING device_execution_leases.*
        ), removed AS (
          DELETE FROM device_execution_lease_queue q USING claimed c
           WHERE q.device_id=c.device_id AND q.request_key=c.request_key
        ), audited AS (
          INSERT INTO device_execution_lease_history(device_id,owner_id,fencing_token,ingress,request_key,event,details)
          SELECT device_id,owner_id,fencing_token,ingress,request_key,'acquired',jsonb_build_object('attempt',attempt) FROM claimed
        ) SELECT * FROM claimed`,
        [deviceId, ownerId, ingress, requestKey, expiresAt]);
    } catch (error) {
      throw new DeviceLeaseError("LEASE_PERSIST_FAILED", `atomic lease acquisition failed: ${(error as Error).message}`);
    }
    const row = result.rows?.[0] as LeaseRow | undefined;
    if (!row) return null;
    return this.remember(row);
  }

  private remember(row: LeaseRow): LeaseContext {
    const context = {
      deviceId: row.device_id,
      ownerId: row.owner_id,
      fencingToken: Number(row.fencing_token),
      ingress: row.ingress,
      requestKey: row.request_key,
      expiresAt: new Date(row.expires_at).getTime(),
      [LEASE_BRAND]: true as const,
    };
    this.issued.add(context);
    this.current.set(context.deviceId, context);
    return context;
  }

  reenter(deviceId: string, ownerId: string, token: number): LeaseContext {
    const lease = this.current.get(deviceId);
    if (!lease || lease.ownerId !== ownerId || lease.fencingToken !== token) throw new DeviceLeaseError("LEASE_STALE", "lease owner/token mismatch");
    this.assertCurrent(lease);
    return lease;
  }

  async resume(deviceId: string, ownerId: string, token: number): Promise<LeaseContext> {
    const lease = this.reenter(deviceId, ownerId, token);
    const result = await getDb().query(`UPDATE device_execution_leases SET state='active',heartbeat_at=now(),updated_at=now()
      WHERE device_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state='recovering' AND expires_at > now() RETURNING device_id`,
      [deviceId, ownerId, token]);
    if (!result.rowCount) throw new DeviceLeaseError("LEASE_EXPIRED", "recovery grace expired");
    return lease;
  }

  assertCurrent(context: LeaseContext): void {
    if (!this.issued.has(context as object)) throw new DeviceLeaseError("LEASE_STALE", "unissued lease context");
    if (this.current.get(context.deviceId) !== context || Date.now() >= context.expiresAt) throw new DeviceLeaseError("LEASE_EXPIRED", "lease is no longer current");
  }

  async heartbeat(context: LeaseContext): Promise<void> {
    this.assertCurrent(context);
    const expiresAt = Date.now() + this.ttlMs;
    const result = await getDb().query(`UPDATE device_execution_leases SET heartbeat_at=now(),expires_at=to_timestamp($4/1000.0),updated_at=now()
      WHERE device_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state IN ('active','recovering') RETURNING device_id`,
      [context.deviceId, context.ownerId, context.fencingToken, expiresAt]);
    if (!result.rowCount) throw new DeviceLeaseError("LEASE_STALE", "heartbeat rejected by durable owner");
    (context as { expiresAt: number }).expiresAt = expiresAt;
  }

  async release(context: LeaseContext, state: "released" | "cancelled" = "released"): Promise<boolean> {
    if (!this.issued.has(context as object)) return false;
    const result = await getDb().query(`WITH changed AS (
      UPDATE device_execution_leases SET state=$4,released_at=COALESCE(released_at,now()),updated_at=now()
       WHERE device_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state IN ('active','recovering') RETURNING *
      ), audited AS (
       INSERT INTO device_execution_lease_history(device_id,owner_id,fencing_token,ingress,request_key,event,details)
       SELECT device_id,owner_id,fencing_token,ingress,request_key,$4,'{}'::jsonb FROM changed
      ) SELECT * FROM changed`, [context.deviceId, context.ownerId, context.fencingToken, state]);
    if (this.current.get(context.deviceId) === context) this.current.delete(context.deviceId);
    return Boolean(result.rowCount);
  }

  async releaseTerminal(context: LeaseContext, state: "released" | "cancelled" = "released"): Promise<boolean> {
    if (this.workflowScoped.has(context as object)) return false;
    return this.release(context, state);
  }

  async cancelQueued(deviceId: string, requestKey: string, reason = "cancelled"): Promise<boolean> {
    try {
      const result = await getDb().query(`WITH changed AS (
        UPDATE device_execution_lease_queue SET cancelled_at=COALESCE(cancelled_at,now()),cancel_reason=COALESCE(cancel_reason,$3)
         WHERE device_id=$1 AND request_key=$2 AND cancelled_at IS NULL RETURNING *
        ), audited AS (
         INSERT INTO device_execution_lease_history(device_id,owner_id,ingress,request_key,event,details)
         SELECT device_id,owner_id,ingress,request_key,'queue_cancelled',jsonb_build_object('reason',$3::text) FROM changed
        ) SELECT * FROM changed`, [deviceId, requestKey, reason]);
      return Boolean(result.rowCount);
    } catch (error) {
      throw new DeviceLeaseError("LEASE_PERSIST_FAILED", `queue cancellation failed: ${(error as Error).message}`);
    }
  }

  async markDisconnected(deviceId: string): Promise<void> {
    const lease = this.current.get(deviceId); if (!lease) return;
    await getDb().query(`UPDATE device_execution_leases SET state='recovering',expires_at=LEAST(expires_at,now()+($4::text||' milliseconds')::interval),updated_at=now()
      WHERE device_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state='active'`, [deviceId, lease.ownerId, lease.fencingToken, this.disconnectGraceMs]);
    (lease as { expiresAt: number }).expiresAt = Math.min(lease.expiresAt, Date.now() + this.disconnectGraceMs);
  }
}

export const deviceExecutionLeaseService = new DeviceExecutionLeaseService();
