import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { PnqV2RuntimeRepository } from "./pnq-v2-runtime.repository";
import { PnqV2RuntimeService, runPnqV2ShadowSideEffect } from "./pnq-v2-runtime.service";
import { setPnqV2RuntimeConfigForTest } from "./pnq-v2-runtime-config";

afterEach(() => {
  setPnqV2RuntimeConfigForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PNQ v2 shadow runtime service", () => {
  it("has zero repository and timer effects when disabled", async () => {
    setPnqV2RuntimeConfigForTest({ enabled: false, sweepIntervalMs: 5 });
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
    setPnqV2RuntimeConfigForTest({ enabled: true, sweepIntervalMs: 1234 });
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

  it("loads runtime enablement from PostgreSQL without nominal modes", () => {
    const source = fs.readFileSync(`${process.cwd()}/src/modules/device-execution/pnq-v2-runtime-config.ts`, "utf8");
    expect(source).toContain("runtime_semantic_entries");
    expect(source).toContain("typeof payload.enabled");
    expect(source).not.toContain("PNQ_V2_RUNTIME_MODE");
  });

  it("detaches side effects and handles synchronous throws as telemetry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolved = vi.fn();
    const operation = vi.fn(() => {
      throw new Error("sync shadow failure");
    });

    expect(() => runPnqV2ShadowSideEffect("test", operation, resolved)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(operation).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "[pnq-v2-shadow] test side effect rejected:",
      "sync shadow failure",
    );
  });

  it("handles asynchronous rejections without surfacing them to legacy callers", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const operation = vi.fn(() => Promise.reject(new Error("async shadow failure")));

    expect(() => runPnqV2ShadowSideEffect("test-async", operation)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(operation).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[pnq-v2-shadow] test-async side effect rejected:",
      "async shadow failure",
    );
  });
});
