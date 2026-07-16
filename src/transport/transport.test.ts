import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isJobReplayEnvelope, type DeviceExecutionJobReplayEnvelopeV1 } from "./transport";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function envelope(): DeviceExecutionJobReplayEnvelopeV1 {
  return {
    schemaVersion: "pnq.job-dispatch/v1",
    deviceId: DEVICE_ID,
    rootKind: "job",
    rootExternalId: "job-1",
    operationKind: "job",
    operationId: "job-1",
    boundary: "standalone_job",
    payload: { jobId: "job-1", type: "screenshot", params: {}, timeoutMs: 10_000 },
  };
}

describe("PNQ job replay envelope", () => {
  it("accepts only the schema-versioned envelope tied to root and operation identity", () => {
    const identity = {
      deviceId: DEVICE_ID,
      rootKind: "job" as const,
      rootExternalId: "job-1",
      operationId: "job-1",
    };
    expect(isJobReplayEnvelope(envelope(), identity)).toBe(true);
    expect(isJobReplayEnvelope({ ...envelope(), deviceId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), rootExternalId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), operationId: "wrong" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), schemaVersion: "pnq.job-dispatch/v2" }, identity)).toBe(false);
    expect(isJobReplayEnvelope({ ...envelope(), payload: { ...envelope().payload, jobId: "wrong" } }, identity)).toBe(false);
  });

  it("pins immutable duplicate metadata and corrupt-head fail-closed SQL paths", () => {
    const arbiterSource = fs.readFileSync(
      path.join(process.cwd(), "src/modules/device-execution/device-execution-arbiter.ts"),
      "utf8",
    );
    const transportSource = fs.readFileSync(
      path.join(process.cwd(), "src/transport/transport.ts"),
      "utf8",
    );
    expect(arbiterSource).toContain("EXCLUDED.metadata - 'dispatchEnvelope'");
    expect(arbiterSource).toContain("queue_replay_corrupt_head_blocked");
    expect(transportSource).toContain("invalid_or_mismatched_dispatch_envelope");
  });

  it("tracks and clears the queue sweep and awaits shutdown ambiguity writes", () => {
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    const directWsSource = fs.readFileSync(path.join(process.cwd(), "src/ws/direct-ws.server.ts"), "utf8");
    expect(indexSource).toContain("const queueSweepTimer = setInterval");
    expect(indexSource).toContain("queueSweepTimer.unref()");
    expect(indexSource).toContain("clearInterval(queueSweepTimer)");
    expect(directWsSource).toContain("await Promise.allSettled(ambiguityWrites)");
  });
});
