import { beforeEach, describe, expect, it, vi } from "vitest";

type QueueRow = { device: string; owner: string; ingress: string; key: string; deadline: number; order: number; cancelled?: boolean };
type ActiveRow = QueueRow & { token: number; expires: number; state: string };

class FakeLeaseDb {
  queue: QueueRow[] = [];
  active = new Map<string, ActiveRow>();
  history: string[] = [];
  token = 0;
  order = 0;
  fail = false;

  async query(sql: string, args: unknown[] = []) {
    if (this.fail) throw new Error("db unavailable");
    if (sql.includes("INSERT INTO device_execution_lease_queue") && !sql.includes("history")) {
      const [device, owner, ingress, key, , deadline] = args as [string,string,string,string,number,number];
      const prior = this.queue.find(q => q.device === device && q.key === key);
      if (prior && !prior.cancelled) prior.deadline = Math.max(prior.deadline, deadline);
      else if (prior) return { rows: [], rowCount: 0 };
      else this.queue.push({ device, owner, ingress, key, deadline, order: ++this.order });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT * FROM claimed")) {
      const [device, owner, , key, expires] = args as [string,string,string,string,number];
      const now = Date.now();
      for (const row of this.queue) if (row.device === device && !row.cancelled && row.deadline <= now) {
        row.cancelled = true; this.history.push(`queue_expired:${row.owner}`);
      }
      const head = this.queue.filter(q => q.device === device && !q.cancelled && q.deadline > now).sort((a,b) => a.order-b.order)[0];
      const held = this.active.get(device);
      if (!head || head.owner !== owner || head.key !== key || (held && held.state === "active" && held.expires > now)) return { rows: [], rowCount: 0 };
      const row: ActiveRow = { ...head, token: ++this.token, expires, state: "active" };
      this.active.set(device, row); this.queue = this.queue.filter(q => q !== head); this.history.push(`acquired:${owner}`);
      return { rows: [{ device_id: device, owner_id: owner, ingress: row.ingress, request_key: key, fencing_token: row.token, expires_at: new Date(expires), state: row.state }], rowCount: 1 };
    }
    if (sql.includes("SET state=$4")) {
      const [device, owner, token, state] = args as [string,string,number,string]; const row = this.active.get(device);
      if (row && row.owner === owner && row.token === token && ["active","recovering"].includes(row.state)) { row.state = state; this.history.push(`${state}:${owner}`); return { rows: [row], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET heartbeat_at=now(),expires_at=")) {
      const [device,owner,token,expires] = args as [string,string,number,number]; const row = this.active.get(device);
      if (row && row.owner === owner && row.token === token && ["active","recovering"].includes(row.state)) {
        row.expires=expires; return {rows:[row],rowCount:1};
      }
      return {rows:[],rowCount:0};
    }
    if (sql.includes("cancel_reason=COALESCE")) {
      const [device,key] = args as [string,string]; const row = this.queue.find(q => q.device===device && q.key===key && !q.cancelled);
      if (row) { row.cancelled=true; return {rows:[row],rowCount:1}; } return {rows:[],rowCount:0};
    }
    if (sql.includes("WITH expired AS")) {
      const now = Date.now();
      for (const row of this.active.values()) if (["active","recovering"].includes(row.state) && row.expires <= now) row.state="expired";
      const rows = [...this.active.values()].filter(row => ["active","recovering"].includes(row.state) && row.expires > now).map(row => ({
        device_id: row.device, owner_id: row.owner, ingress: row.ingress, request_key: row.key,
        fencing_token: row.token, expires_at: new Date(row.expires), state: row.state,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("WITH cancelled AS")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }
}

const db = new FakeLeaseDb();
vi.mock("../../db/client", () => ({ getDb: () => db }));
import { DeviceExecutionLeaseService, DeviceLeaseError } from "./device-execution-lease.service";

describe("DeviceExecutionLeaseService", () => {
  beforeEach(() => { db.queue=[]; db.active.clear(); db.history=[]; db.token=0; db.order=0; db.fail=false; });

  it("atomically excludes a second server instance and fences old ownership", async () => {
    const a = new DeviceExecutionLeaseService(5_000, 100, 1);
    const b = new DeviceExecutionLeaseService(5_000, 100, 1);
    const first = await a.acquire("d", { ownerId:"workflow", ingress:"server", requestKey:"a" }, 0);
    await expect(b.acquire("d", { ownerId:"raw", ingress:"raw", requestKey:"b" }, 2)).rejects.toMatchObject({ code:"DEVICE_BUSY" });
    await a.release(first);
    const second = await b.acquire("d", { ownerId:"raw", ingress:"raw", requestKey:"b-retry" }, 5);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(() => a.assertCurrent(first)).toThrow(DeviceLeaseError);
  });

  it("keeps raw work FIFO behind one workflow-wide owner", async () => {
    const service = new DeviceExecutionLeaseService(5_000, 100, 1);
    const events: string[] = [];
    const workflow = service.runWithLease("d", { ownerId:"busta", ingress:"workflow", requestKey:"wf" }, async lease => {
      events.push(`step1:${lease.ownerId}`); await new Promise(r => setTimeout(r, 8));
      expect(service.activeContext()).toBe(lease); events.push(`step2:${lease.ownerId}`);
    }, 20);
    await new Promise(r => setTimeout(r, 1));
    const raw = service.acquire("d", { ownerId:"raw", ingress:"raw", requestKey:"raw" }, 30).then(l => { events.push("raw"); return service.release(l); });
    await Promise.all([workflow,raw]);
    expect(events).toEqual(["step1:busta","step2:busta","raw"]);
  });

  it("fails closed when acquisition persistence fails", async () => {
    db.fail=true;
    await expect(new DeviceExecutionLeaseService().acquire("d", { ingress:"raw" }, 0)).rejects.toMatchObject({ code:"LEASE_PERSIST_FAILED" });
  });

  it("cancels an expired waiter durably and release is idempotent", async () => {
    const service = new DeviceExecutionLeaseService(5_000,100,1);
    const held = await service.acquire("d", {ownerId:"held",ingress:"x",requestKey:"held"},0);
    await expect(service.acquire("d", {ownerId:"wait",ingress:"x",requestKey:"wait"},2)).rejects.toMatchObject({code:"DEVICE_BUSY"});
    expect(db.queue.find(q=>q.key==="wait")?.cancelled).toBe(true);
    expect(await service.release(held)).toBe(true);
    expect(await service.release(held)).toBe(false);
  });

  it("hydrates an unexpired durable owner on restart and fences newcomers", async () => {
    const before = new DeviceExecutionLeaseService(5_000,100,1);
    const held = await before.acquire("d", {ownerId:"run-1",ingress:"workflow",requestKey:"wf"},0);
    const restarted = new DeviceExecutionLeaseService(5_000,100,1);
    await restarted.reconcileStartup();
    expect(restarted.reenter("d", "run-1", held.fencingToken)).toMatchObject({ownerId:"run-1"});
    await expect(restarted.acquire("d", {ownerId:"new",ingress:"raw",requestKey:"new"},2)).rejects.toMatchObject({code:"DEVICE_BUSY"});
  });

  it("expires only elapsed durable owners during startup reconciliation", async () => {
    db.active.set("old", {device:"old",owner:"old-run",ingress:"workflow",key:"old",deadline:0,order:1,token:1,expires:Date.now()-1,state:"active"});
    db.active.set("live", {device:"live",owner:"live-run",ingress:"workflow",key:"live",deadline:0,order:2,token:2,expires:Date.now()+5_000,state:"recovering"});
    const restarted = new DeviceExecutionLeaseService(5_000,100,1);
    await restarted.reconcileStartup();
    expect(db.active.get("old")?.state).toBe("expired");
    expect(restarted.reenter("live", "live-run", 2).ownerId).toBe("live-run");
  });

  it("expires a dead FIFO head durably before promoting the next waiter", async () => {
    db.queue.push({device:"d",owner:"expired",ingress:"raw",key:"old",deadline:Date.now()-1,order:++db.order});
    const service = new DeviceExecutionLeaseService(5_000,100,1);
    const lease = await service.acquire("d", {ownerId:"next",ingress:"raw",requestKey:"next"}, 10);
    expect(lease.ownerId).toBe("next");
    expect(db.queue.find(row => row.key === "old")?.cancelled).toBe(true);
    expect(db.history).toContain("queue_expired:expired");
  });

  it("extends the locally enforced lifetime after a durable heartbeat", async () => {
    const service = new DeviceExecutionLeaseService(50,100,1);
    const lease = await service.acquire("d", {ownerId:"long",ingress:"workflow",requestKey:"long"}, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.heartbeat(lease);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => service.assertCurrent(lease)).not.toThrow();
  });
});
