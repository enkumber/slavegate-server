import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ModelConfigService, sanitizeProviderError, setModelConfigEndpointResolverForTests } from "./model-config.service";
import { getDb } from "../../db/client";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
}));

const query = vi.fn();

function row(overrides: Record<string, unknown> = {}) {
  return {
    role: "decision_llm",
    provider: "openai_compatible",
    endpoint: "https://models.example.com/v1",
    model: "qwen-test",
    api_key_encrypted: null,
    credential_ref: "env:MODEL_CONFIG_TEST_KEY",
    api_key_fingerprint: null,
    enabled: true,
    version: 3,
    last_test_status: null,
    last_test_message: null,
    last_test_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  query.mockReset();
  vi.mocked(getDb).mockReturnValue({ query } as never);
  process.env.MODEL_CONFIG_TEST_KEY = "secret-from-env";
  process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "models.example.com";
  setModelConfigEndpointResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  delete process.env.MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
});

afterEach(() => {
  setModelConfigEndpointResolverForTests();
  vi.restoreAllMocks();
});

describe("ModelConfigService credential and endpoint safety", () => {
  it("never includes raw apiKey material in the device bundle", async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT * FROM model_configs WHERE role = $1")) {
        return { rows: [row({ role: params?.[0] })] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const bundle = await new ModelConfigService().getDeviceBundle();

    expect(JSON.stringify(bundle)).not.toContain("secret-from-env");
    expect(JSON.stringify(bundle)).not.toContain("apiKey");
    expect(bundle.roles.decision_llm).not.toHaveProperty("credential");
    expect(bundle.roles.decision_llm).not.toHaveProperty("credentialRef");
    expect(bundle.roles.decision_llm).toMatchObject({
      credentialDelivery: "server_only",
      hasCredential: true,
    });
  });

  it("fails closed when a role is disabled or lacks a server-side credential", async () => {
    query.mockResolvedValueOnce({ rows: [row({ enabled: false })] });
    await expect(new ModelConfigService().resolve("decision_llm")).rejects.toMatchObject({
      code: "AI_MODEL_DISABLED",
      statusCode: 503,
    });

    query.mockResolvedValueOnce({ rows: [row({ credential_ref: null })] });
    await expect(new ModelConfigService().resolve("decision_llm")).rejects.toMatchObject({
      code: "AI_CREDENTIAL_MISSING",
      statusCode: 503,
    });
  });

  it("rejects arbitrary file credential refs before they can be resolved", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key";
    process.env.MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST = "/srv/model-credentials";
    query.mockResolvedValueOnce({ rows: [row()] });

    await expect(new ModelConfigService().updateCredential("decision_llm", {
      credentialRef: "file:/etc/passwd",
    })).rejects.toMatchObject({
      code: "AI_CREDENTIAL_REF_NOT_ALLOWLISTED",
      statusCode: 400,
    });
  });

  it("rejects invalid env credential names", async () => {
    query.mockResolvedValueOnce({ rows: [row()] });

    await expect(new ModelConfigService().updateCredential("decision_llm", {
      credentialRef: "env:../../TOKEN",
    })).rejects.toMatchObject({
      code: "AI_CREDENTIAL_REF_UNSUPPORTED",
      statusCode: 400,
    });
  });

  it("requires explicit allowlisting for HTTP and HTTPS OpenAI-compatible endpoints", async () => {
    delete process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    query.mockResolvedValueOnce({ rows: [row()] });
    await expect(new ModelConfigService().update("decision_llm", {
      provider: "openai_compatible",
      endpoint: "http://gx10.local/v1",
      model: "qwen3-vl",
      enabled: true,
    })).rejects.toMatchObject({
      code: "AI_ENDPOINT_NOT_ALLOWLISTED",
      statusCode: 400,
    });

    query.mockResolvedValueOnce({ rows: [row()] });
    await expect(new ModelConfigService().update("decision_llm", {
      provider: "openai_compatible",
      endpoint: "https://192.168.10.20/v1",
      model: "qwen3-vl",
      enabled: true,
    })).rejects.toMatchObject({
      code: "AI_ENDPOINT_NOT_ALLOWLISTED",
      statusCode: 400,
    });

    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "local:gx10.local";
    query.mockResolvedValueOnce({ rows: [row()] });
    query.mockResolvedValueOnce({ rows: [row({ endpoint: "http://gx10.local/v1", model: "qwen3-vl" })] });

    const saved = await new ModelConfigService().update("decision_llm", {
      provider: "openai_compatible",
      endpoint: "http://gx10.local/v1/chat/completions",
      model: "qwen3-vl",
      enabled: true,
    });

    expect(saved.endpoint).toBe("http://gx10.local/v1");
  });

  it("rejects allowlisted endpoints that resolve to private or metadata addresses unless marked local", async () => {
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "models.example.com";
    setModelConfigEndpointResolverForTests(async () => [{ address: "169.254.169.254", family: 4 }]);
    query.mockResolvedValueOnce({ rows: [row({ endpoint: "https://models.example.com/v1" })] });

    await expect(new ModelConfigService().resolve("decision_llm")).rejects.toMatchObject({
      code: "AI_ENDPOINT_PRIVATE_ADDRESS",
      statusCode: 400,
    });

    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "local:models.example.com";
    query.mockResolvedValueOnce({ rows: [row({ endpoint: "https://models.example.com/v1" })] });
    await expect(new ModelConfigService().resolve("decision_llm")).resolves.toMatchObject({
      endpoint: "https://models.example.com/v1",
    });
  });

  it("rejects file credential symlinks that escape the allowlisted directory at read time", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pnmc-model-config-"));
    const allowed = path.join(tmp, "allowed");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    const outsideSecret = path.join(outside, "secret.txt");
    const symlink = path.join(allowed, "secret-link.txt");
    await fs.writeFile(outsideSecret, "escaped-secret", "utf8");
    await fs.symlink(outsideSecret, symlink);

    process.env.CREDENTIAL_ENCRYPTION_KEY = "test-key";
    process.env.MODEL_CONFIG_CREDENTIAL_FILE_ALLOWLIST = allowed;
    query.mockResolvedValueOnce({ rows: [row({ credential_ref: `file:${symlink}` })] });

    try {
      await expect(new ModelConfigService().resolve("decision_llm")).rejects.toMatchObject({
        code: "AI_CREDENTIAL_REF_NOT_ALLOWLISTED",
        statusCode: 400,
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("redacts provider errors before API or log surfaces see them", () => {
    expect(sanitizeProviderError('{"error":"bad","apiKey":"sk-live-secret","authorization":"Bearer abc123"}'))
      .not.toContain("sk-live-secret");
    expect(sanitizeProviderError("Authorization: Bearer sk-test-secret"))
      .toContain("Bearer [redacted]");
  });
});
