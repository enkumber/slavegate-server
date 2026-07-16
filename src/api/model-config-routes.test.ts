import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("legacy vision config route mapping", () => {
  it("keeps /api/vision/config mapped to redacted vision_vlm fields with snake_case compatibility", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/api/routes.ts"), "utf8");
    expect(source).toContain('router.get("/vision/config"');
    expect(source).toContain('modelConfigService.get("vision_vlm")');
    expect(source).toContain('api_key_ref: config.hasCredential ? "redacted" : null');
    expect(source).toContain('apiKeyRef: config.hasCredential ? "redacted" : null');
    expect(source).toContain("last_test_status: config.lastTestStatus");
    expect(source).toContain("last_test_message: config.lastTestMessage");
    expect(source).toContain("last_test_at: config.lastTestAt");
    expect(source).toContain("updated_at: config.updatedAt");
  });
});

