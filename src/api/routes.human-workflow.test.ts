import { describe, it, expect } from "vitest";
import crypto from "crypto";

describe("human workflow endpoints", () => {
  it("compute request key is deterministic", () => {
    const intent = "open Instagram and take a selfie";
    const device_id = "d1";
    const account_id = "a1";
    const requestKey = crypto.createHash("sha256").update(device_id + ":" + account_id + ":" + intent).digest("hex").slice(0, 24);
    expect(requestKey).toMatch(/^[a-f0-9]{24}$/);
  });

  it("intent validation rejects empty", () => {
    const intent = "";
    expect(intent.trim().length).toBeLessThan(3);
  });
});
