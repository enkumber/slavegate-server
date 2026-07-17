import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { PnqV2RuntimeRepository } from "./pnq-v2-runtime.repository";
import { PnqV2RuntimeService } from "./pnq-v2-runtime.service";
import { setPnqV2RuntimeConfigForTest } from "./pnq-v2-runtime-config";

afterEach(() => {
  setPnqV2RuntimeConfigForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PNQ v2 shadow runtime service", () => {
  it("has zero repository and timer effects when disabled", async () => {
    setPnqV2RuntimeConfigForTest({ mode: "disabled", sweepIntervalMs: 5 });
    const enqueue = vi.spyOn(PnqV2RuntimeRepository.prototype, "enqueueMappedJob");
    const register = vi.spyOn(PnqV2RuntimeRepository.prototype, "registerNode");
    const result = vi.spyOn(PnqV2RuntimeRepository.prototype, "recordResult");
    const stuck = vi.spyOn(PnqV2RuntimeRepository.prototype, "markExpiredActiveStuck");
    const interval = vi.spyOn(globalThis, "setInterval");
    const service = new PnqV2RuntimeService();

    await expect(service.enqueueShadowJob({
      legacyJobId: "legacy-1",
      deviceId: "device-1",
      payload: {},
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ ok: true, metadata: { mode: "disabled" } });
    await expect(service.onConnectionAuthenticated("device-1")).resolves.toBeNull();
    await expect(service.recordShadowResult({
      legacyJobId: "legacy-1",
      socketEpoch: 1,
      success: true,
      result: {},
    })).resolves.toMatchObject({ ok: true, metadata: { mode: "disabled" } });
    await expect(service.sweepDeadlines()).resolves.toMatchObject({ ok: true });
    service.startPeriodicSweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    expect(stuck).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("uses configured sweep interval and only asks repository to mark expired active jobs", async () => {
    vi.useFakeTimers();
    setPnqV2RuntimeConfigForTest({ mode: "shadow", sweepIntervalMs: 1234 });
    const markExpired = vi
      .spyOn(PnqV2RuntimeRepository.prototype, "markExpiredActiveStuck")
      .mockResolvedValue(0);
    const interval = vi.spyOn(globalThis, "setInterval");
    const service = new PnqV2RuntimeService();

    service.startPeriodicSweep();
    await vi.advanceTimersByTimeAsync(1234);

    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(markExpired).toHaveBeenCalledWith("deadline_or_crash_window_recovery_required");
    await service.close();
  });

  it("keeps runtime mode parsing restricted to disabled and shadow", () => {
    const source = fs.readFileSync(`${process.cwd()}/src/modules/device-execution/pnq-v2-runtime-config.ts`, "utf8");
    expect(source).toContain('return value === "shadow" ? "shadow" : "disabled"');
  });
});
