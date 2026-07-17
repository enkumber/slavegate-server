import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceExecutionArbiter } from "../modules/device-execution";
import { setDeviceExecutionAuthorityForTest } from "../modules/device-execution/device-execution-authority";
import { evaluateWsJobResultAuthority, type WsJobResultAuthorityInput } from "./ws-job-result-authority";

const authorityInput: WsJobResultAuthorityInput = {
  deviceId: "00000000-0000-4000-8000-000000000001",
  jobId: "legacy-job-1",
  handle: null,
  status: "completed",
  actor: "ws",
  reason: "completed",
  metadata: { observeSource: "wsServer.handleJobResult" },
};

afterEach(() => {
  setDeviceExecutionAuthorityForTest(null);
  vi.restoreAllMocks();
});

describe("PNQ v2 shadow ECDSA WebSocket side effects", () => {
  it("does not await shadow auth or result bookkeeping on the legacy ingress path", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/ws.server.ts"), "utf8");

    expect(source).toContain("const epochObservation = Promise.resolve()");
    expect(source).toContain("pnqV2RuntimeService.onConnectionAuthenticated(deviceId)");
    expect(source).toContain("conn.pnqV2ConnectionEpochPromise = epochObservation");
    expect(source).toContain("this.connections.get(deviceId) === conn");
    expect(source).toContain('runPnqV2ShadowSideEffect("ws result"');
    expect(source).toContain("evaluateWsJobResultAuthority({");
    expect(source).not.toContain("deviceExecutionArbiter.acceptJobResult({");
    expect(source).not.toContain("conn.pnqV2ConnectionEpoch = await pnqV2RuntimeService.onConnectionAuthenticated");
    expect(source).not.toContain("await pnqV2RuntimeService.recordShadowResult");
  });
});

describe("PNQ observe-only ECDSA WebSocket result authority", () => {
  it("continues the legacy result path while observe-only telemetry is pending", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    const observe = vi.spyOn(deviceExecutionArbiter, "observeTerminal")
      .mockReturnValue(new Promise(() => undefined));

    await expect(evaluateWsJobResultAuthority(authorityInput)).resolves.toMatchObject({
      accepted: true,
      decision: "observe_only",
    });
    await Promise.resolve();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("continues the legacy result path when observe-only telemetry throws", async () => {
    setDeviceExecutionAuthorityForTest("observe_only");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(deviceExecutionArbiter, "observeTerminal").mockImplementation(() => {
      throw new Error("observe unavailable");
    });

    await expect(evaluateWsJobResultAuthority(authorityInput)).resolves.toMatchObject({
      accepted: true,
      decision: "observe_only",
    });
    await Promise.resolve();
  });

  it("keeps enforced rejection fail-closed", async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    vi.spyOn(deviceExecutionArbiter, "acceptJobResult").mockResolvedValue({
      accepted: false,
      decision: "rejected_stale",
      reason: "test stale result",
    } as never);

    await expect(evaluateWsJobResultAuthority(authorityInput)).resolves.toMatchObject({
      accepted: false,
      decision: "rejected_stale",
    });
  });

  it("keeps enforced ingress errors fail-closed", async () => {
    setDeviceExecutionAuthorityForTest("enforced");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(deviceExecutionArbiter, "acceptJobResult").mockRejectedValue(new Error("arbiter unavailable"));

    await expect(evaluateWsJobResultAuthority(authorityInput)).resolves.toMatchObject({
      accepted: false,
      decision: "enforced_error",
      reason: "arbiter unavailable",
    });
  });
});
