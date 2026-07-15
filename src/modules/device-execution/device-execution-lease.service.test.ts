import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/client", () => ({ getDb: () => ({ query: vi.fn().mockResolvedValue({}) }) }));
import { DeviceExecutionLeaseService, DeviceLeaseError } from "./device-execution-lease.service";
describe("DeviceExecutionLeaseService", () => {
  it("admits one owner, fences stale contexts, and increases tokens", () => {
    const service = new DeviceExecutionLeaseService(); const first = service.tryAcquire("d", { ingress: "raw", requestKey: "a" });
    expect(() => service.tryAcquire("d", { ingress: "hydra" })).toThrow(DeviceLeaseError);
    expect(service.reenter("d", first.ownerId, first.fencingToken)).toBe(first); service.release(first);
    const second = service.tryAcquire("d", { ingress: "hydra" }); expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(() => service.assertCurrent(first)).toThrow();
  });
  it("rejects forged contexts", () => { const service = new DeviceExecutionLeaseService(); const real = service.tryAcquire("d", { ingress: "x" }); expect(() => service.assertCurrent({ ...real } as any)).toThrow(/unissued/); });
  it("promotes queued waiters in FIFO order", async () => { const service = new DeviceExecutionLeaseService(); const first = service.tryAcquire("d", { ingress: "a" }); const second = service.acquire("d", { ingress: "b", ownerId: "second" }); const third = service.acquire("d", { ingress: "c", ownerId: "third" }); service.release(first); const next = await second; expect(next.ownerId).toBe("second"); service.release(next); expect((await third).ownerId).toBe("third"); });
});
