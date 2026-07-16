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

  it("routes legacy credential ref replacement and clear through credential mutation semantics", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/api/routes.ts"), "utf8");
    const patchRoute = source.slice(source.indexOf("async function updateLegacyVisionConfig"), source.indexOf("// ─── Metrics"));
    expect(patchRoute).not.toContain("credentialRef: (body.credentialRef ?? body.apiKeyRef) as string | null | undefined,");
    expect(patchRoute).toContain('modelConfigService.updateCredential("vision_vlm"');
    expect(patchRoute).toContain('["credentialRef", "apiKeyRef", "api_key_ref"]');
    expect(patchRoute).toContain("credentialRef: body[credentialRefField] as string | null");
    expect(patchRoute).toContain('router.patch("/vision/config", requireAuth, updateLegacyVisionConfig)');
    expect(patchRoute).toContain('router.post("/vision/config", requireAuth, updateLegacyVisionConfig)');
  });
});
