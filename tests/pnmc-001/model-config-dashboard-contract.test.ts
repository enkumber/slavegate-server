import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelConfigDraft, RedactedModelConfig } from "../../dashboard-src/src/api/modelConfig";

const fixture: RedactedModelConfig = {
  role: "decision_llm",
  provider: "openai_compatible",
  endpoint: "https://models.example/v1",
  model: "llama-test",
  enabled: true,
  version: 7,
  updatedAt: "2026-07-16T00:00:00.000Z",
  credential: "redacted",
  credentialConfigured: true,
  credentialRefType: "db-secret",
  apiKeyFingerprint: "sha256:abc123",
  lastTestStatus: "ok",
  lastTestMessage: "Connection OK",
  lastTestAt: "2026-07-16T00:00:00.000Z",
};

describe("PNMC dashboard model config contract", () => {
  beforeAll(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  it("starts from redacted API data without rehydrating credential fields", () => {
    return import("../../dashboard-src/src/api/modelConfig").then(({ draftFromConfig }) => {
    const draft = draftFromConfig(fixture);

    expect(draft).toMatchObject({
      provider: "openai_compatible",
      endpoint: "https://models.example/v1",
      model: "llama-test",
      enabled: true,
      credentialMode: "retain",
      credential: "",
      credentialRef: "",
    });
    });
  });

  it("updates provider metadata separately from credential mutation", () => {
    return import("../../dashboard-src/src/api/modelConfig").then(({ buildModelPatch }) => {
    const patch = buildModelPatch({
      provider: " openai_compatible ",
      endpoint: " ",
      model: " gx10-vlm ",
      enabled: false,
      credentialMode: "retain",
      credential: "",
      credentialRef: "",
    });

    expect(patch).toEqual({
      provider: "openai_compatible",
      endpoint: null,
      model: "gx10-vlm",
      enabled: false,
    });
    });
  });

  it("expresses explicit retain, replace, reference, and clear credential semantics", () => {
    return import("../../dashboard-src/src/api/modelConfig").then(({ buildCredentialRequest }) => {
    const base: ModelConfigDraft = {
      provider: "openai_compatible",
      endpoint: "https://models.example/v1",
      model: "llama-test",
      enabled: true,
      credentialMode: "retain",
      credential: "",
      credentialRef: "",
    };

    expect(buildCredentialRequest(base)).toBeNull();
    expect(buildCredentialRequest({ ...base, credentialMode: "replace", credential: " local-token " })).toEqual({ credential: "local-token" });
    expect(buildCredentialRequest({ ...base, credentialMode: "reference", credentialRef: " env:GX10_TOKEN " })).toEqual({ credentialRef: "env:GX10_TOKEN" });
    expect(buildCredentialRequest({ ...base, credentialMode: "clear" })).toEqual({ credentialRef: null });
    expect(() => buildCredentialRequest({ ...base, credentialMode: "replace" })).toThrow("Enter a new API key/token");
    expect(() => buildCredentialRequest({ ...base, credentialMode: "reference" })).toThrow("credential reference");
    });
  });

  it("rejects API payloads that include raw or rehydratable secret fields", () => {
    return import("../../dashboard-src/src/api/modelConfig").then(({ assertRedactedModelConfig }) => {
    expect(assertRedactedModelConfig(fixture)).toBe(fixture);
    expect(() => assertRedactedModelConfig({ ...fixture, credential: "plain-leaked-token" } as RedactedModelConfig)).toThrow("unredacted");
    expect(() => assertRedactedModelConfig({ ...fixture, credentialRef: "env:SECRET" } as unknown as RedactedModelConfig)).toThrow("credentialRef");
    expect(() => assertRedactedModelConfig({ ...fixture, apiKeyEncrypted: "ciphertext" } as unknown as RedactedModelConfig)).toThrow("apiKeyEncrypted");
    });
  });

  it("summarizes credential metadata without exposing refs or secrets", () => {
    return import("../../dashboard-src/src/api/modelConfig").then(({ credentialSummary }) => {
    expect(credentialSummary(null)).toBe("Missing config row");
    expect(credentialSummary({ ...fixture, credentialConfigured: false, hasCredential: false })).toBe("Missing credential");
    expect(credentialSummary(fixture)).toBe("Stored as db-secret");
    expect(credentialSummary({ ...fixture, credentialRefType: null })).toBe("Stored secret sha256:abc123");
    });
  });

  it("keeps the Tokens / Models page free of direct secret rendering fields", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "dashboard-src/src/pages/TokenManagement.tsx"), "utf8");

    expect(source).not.toContain("apiKeyEncrypted");
    expect(source).not.toContain("api_key_encrypted");
    expect(source).not.toContain("apiKeyFingerprint");
    expect(source).not.toContain("credentialRefType");
    expect(source).not.toMatch(/config\.credential(?!Configured)/);
    expect(source).toContain("{ mode: \"clear\", label: \"Clear\" }");
  });
});
