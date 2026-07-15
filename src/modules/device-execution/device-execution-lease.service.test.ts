import { describe, expect, it } from "vitest";
import { DeviceBusyError, DeviceExecutionLeaseService, requireDeviceExecutionLeaseContext } from "./device-execution-lease.service";

class FakeClient {
  token = 0;
  lease: any;
  async query(sql: string, values: unknown[] = []): Promise<any> {
    if (sql.includes("SELECT owner_id")) return { rows: this.lease ? [this.lease] : [] };
    if (sql.includes("UPDATE device_execution_fences")) return { rows: [{ last_token: ++this.token }] };
    if (sql.includes("INSERT INTO device_execution_leases")) {
      this.lease = { owner_id: values[1], run_id: values[2], fencing_token: values[5], expires_at: new Date(Date.now() + Number(values[6])) };
    }
    return { rows: [] };
  }
}

describe("DeviceExecutionLeaseService", () => {
  it("admits at most one owner per device and fences the stale token forever", async () => {
    const service = new DeviceExecutionLeaseService();
    const db = new FakeClient();
    const first = await service.acquireInTransaction(db as any, { deviceId: "d1", ownerId: "a", runId: "r1", ingress: "test" });
    await expect(service.acquireInTransaction(db as any, { deviceId: "d1", ownerId: "b", runId: "r2", ingress: "test" })).rejects.toBeInstanceOf(DeviceBusyError);
    expect(first.fencingToken).toBe(1);
    db.lease.expires_at = new Date(0);
    const second = await service.acquireInTransaction(db as any, { deviceId: "d1", ownerId: "b", runId: "r2", ingress: "test" });
    expect(second.fencingToken).toBe(2);
    expect(() => requireDeviceExecutionLeaseContext("d1", { ...first })).toThrow("DEVICE_EXECUTION_LEASE_REQUIRED");
  });
});
