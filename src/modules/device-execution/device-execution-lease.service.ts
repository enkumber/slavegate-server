import { randomUUID } from "crypto";
import { getDb } from "../../db/client";

const LEASE_BRAND = Symbol("device-execution-lease");
export interface LeaseContext {
  readonly deviceId: string; readonly ownerId: string; readonly fencingToken: number;
  readonly ingress: string; readonly requestKey: string; readonly expiresAt: number;
  readonly [LEASE_BRAND]: true;
}
export type LeaseErrorCode = "DEVICE_BUSY" | "LEASE_EXPIRED" | "LEASE_STALE" | "LEASE_CANCELLED";
export class DeviceLeaseError extends Error { constructor(readonly code: LeaseErrorCode, message: string) { super(message); } }

interface ActiveLease { context: LeaseContext; heartbeatAt: number; expiresAt: number; state: "active" | "recovering"; graceUntil?: number; }

export class DeviceExecutionLeaseService {
  private readonly active = new Map<string, ActiveLease>();
  private readonly tokens = new Map<string, number>();
  private readonly issued = new WeakSet<object>();
  private readonly queues = new Map<string, Array<{ input: { ownerId?: string; ingress: string; requestKey?: string; attempt?: number }; resolve: (lease: LeaseContext) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>();
  constructor(private readonly ttlMs = 300_000, private readonly disconnectGraceMs = 30_000) {}

  async reconcileStartup(): Promise<void> {
    await getDb().query(`UPDATE device_execution_leases SET state='expired', released_at=now(), updated_at=now()
      WHERE state IN ('active','recovering') AND (expires_at <= now() OR state='active')`);
    const rows = await getDb().query(`SELECT device_id, fencing_token FROM device_execution_leases`);
    for (const row of rows.rows ?? []) this.tokens.set(String(row.device_id), Number(row.fencing_token));
  }

  tryAcquire(deviceId: string, input: { ownerId?: string; ingress: string; requestKey?: string; attempt?: number }): LeaseContext {
    this.expire(deviceId);
    const current = this.active.get(deviceId);
    if (current) throw new DeviceLeaseError("DEVICE_BUSY", `device ${deviceId} is exclusively leased`);
    const token = (this.tokens.get(deviceId) ?? 0) + 1; this.tokens.set(deviceId, token);
    const now = Date.now(); const ownerId = input.ownerId ?? randomUUID();
    const context = Object.freeze({ deviceId, ownerId, fencingToken: token, ingress: input.ingress,
      requestKey: input.requestKey ?? ownerId, expiresAt: now + this.ttlMs, [LEASE_BRAND]: true as const });
    this.issued.add(context); this.active.set(deviceId, { context, heartbeatAt: now, expiresAt: now + this.ttlMs, state: "active" });
    void this.persist(context, input.attempt ?? 1, "active"); return context;
  }
  acquire(deviceId: string, input: { ownerId?: string; ingress: string; requestKey?: string; attempt?: number }, waitMs = 30_000): Promise<LeaseContext> {
    try { return Promise.resolve(this.tryAcquire(deviceId, input)); } catch (error) { if (!(error instanceof DeviceLeaseError) || error.code !== "DEVICE_BUSY") return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const entry = { input, resolve, reject, timer: setTimeout(() => { const queue = this.queues.get(deviceId) ?? []; const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(new DeviceLeaseError("DEVICE_BUSY", "device lease wait deadline exceeded")); }, waitMs) };
      const queue = this.queues.get(deviceId) ?? []; queue.push(entry); this.queues.set(deviceId, queue);
    });
  }

  reenter(deviceId: string, ownerId: string, token: number): LeaseContext {
    this.expire(deviceId); const current = this.active.get(deviceId);
    if (!current || current.context.ownerId !== ownerId || current.context.fencingToken !== token) throw new DeviceLeaseError("LEASE_STALE", "lease owner/token mismatch");
    return current.context;
  }
  assertCurrent(context: LeaseContext): void {
    if (!this.issued.has(context as object)) throw new DeviceLeaseError("LEASE_STALE", "unissued lease context");
    const current = this.active.get(context.deviceId);
    if (!current || current.context !== context || Date.now() >= current.expiresAt) throw new DeviceLeaseError("LEASE_EXPIRED", "lease is no longer current");
  }
  heartbeat(context: LeaseContext): void { this.assertCurrent(context); const lease = this.active.get(context.deviceId)!; lease.heartbeatAt = Date.now(); lease.expiresAt = Date.now() + this.ttlMs; void this.persist(context, 1, lease.state, lease.expiresAt); }
  release(context: LeaseContext, state: "released" | "cancelled" = "released"): void {
    this.assertCurrent(context); this.active.delete(context.deviceId); void this.persist(context, 1, state); this.promote(context.deviceId);
  }
  markDisconnected(deviceId: string): void { const lease = this.active.get(deviceId); if (lease) { lease.state = "recovering"; lease.graceUntil = Date.now() + this.disconnectGraceMs; void this.persist(lease.context, 1, "recovering"); } }
  resume(deviceId: string, ownerId: string, token: number): LeaseContext { const lease = this.active.get(deviceId); if (!lease || lease.state !== "recovering" || (lease.graceUntil ?? 0) < Date.now()) throw new DeviceLeaseError("LEASE_EXPIRED", "recovery grace expired"); lease.state = "active"; return this.reenter(deviceId, ownerId, token); }
  private expire(deviceId: string): void { const lease = this.active.get(deviceId); if (lease && (Date.now() >= lease.expiresAt || (lease.state === "recovering" && Date.now() >= (lease.graceUntil ?? 0)))) { this.active.delete(deviceId); void this.persist(lease.context, 1, "expired"); } }
  private promote(deviceId: string): void { const next = this.queues.get(deviceId)?.shift(); if (!next) return; clearTimeout(next.timer); try { next.resolve(this.tryAcquire(deviceId, next.input)); } catch (error) { next.reject(error as Error); this.promote(deviceId); } }
  private async persist(context: LeaseContext, attempt: number, state: string, expiresAt = context.expiresAt): Promise<void> {
    try { await getDb().query(`INSERT INTO device_execution_leases(device_id, owner_id, ingress, request_key, attempt, state, fencing_token, acquired_at, heartbeat_at, expires_at, released_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now(),now(),to_timestamp($8/1000.0),CASE WHEN $6 IN ('released','cancelled','expired') THEN now() END)
      ON CONFLICT(device_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, ingress=EXCLUDED.ingress, request_key=EXCLUDED.request_key, attempt=EXCLUDED.attempt, state=EXCLUDED.state, fencing_token=GREATEST(device_execution_leases.fencing_token,EXCLUDED.fencing_token), heartbeat_at=now(), expires_at=EXCLUDED.expires_at, released_at=EXCLUDED.released_at`,
      [context.deviceId,context.ownerId,context.ingress,context.requestKey,attempt,state,context.fencingToken,expiresAt]); }
    catch (error) { console.error("[device-lease] persistence failed:", (error as Error).message); }
  }
}
export const deviceExecutionLeaseService = new DeviceExecutionLeaseService();
