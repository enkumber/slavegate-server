import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PNQ v2 shadow ECDSA WebSocket side effects", () => {
  it("does not await shadow auth or result bookkeeping on the legacy ingress path", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/ws/ws.server.ts"), "utf8");

    expect(source).toContain("const epochObservation = pnqV2RuntimeService.onConnectionAuthenticated(deviceId)");
    expect(source).toContain("conn.pnqV2ConnectionEpochPromise = epochObservation");
    expect(source).toContain("this.connections.get(deviceId) === conn");
    expect(source).toContain("void pnqV2RuntimeService.recordShadowResult");
    expect(source).not.toContain("conn.pnqV2ConnectionEpoch = await pnqV2RuntimeService.onConnectionAuthenticated");
    expect(source).not.toContain("await pnqV2RuntimeService.recordShadowResult");
  });
});
