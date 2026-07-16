import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { ModelConfigService, modelConfigFetch, sanitizeProviderError, setModelConfigEndpointResolverForTests } from "./model-config.service";
import { getDb } from "../../db/client";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
}));

const query = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const connect = vi.fn();

const CREDENTIAL_FIELD_ALIASES = [
  "authorization",
  "authorization_header",
  "credential",
  "credentials",
  "credentialConfigured",
  "credentialRef",
  "credential_ref",
  "credentialReference",
  "credentialValue",
  "clearCredential",
  "delete_credential",
  "removeCredential",
  "clear_credentials",
  "credential_clear",
  "apiKey",
  "api_key",
  "apiKeyConfigured",
  "apiKeyEncrypted",
  "api_key_encrypted",
  "apiKeyFingerprint",
  "api_key_fingerprint",
  "apiKeyRef",
  "api_key_ref",
  "apiKeyReference",
  "clearApiKey",
  "delete_api_key",
  "removeApiKey",
  "xApiKey",
  "x_api_key",
  "api_token",
  "token",
  "token_ref",
  "access_token",
  "authToken",
  "provider_token",
  "clearToken",
  "delete_token",
  "removeToken",
  "secret",
  "client_secret",
  "secret_ref",
] as const;

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
  clientQuery.mockReset();
  release.mockReset();
  connect.mockReset();
  connect.mockResolvedValue({ query: clientQuery, release });
  vi.mocked(getDb).mockReturnValue({ query, connect } as never);
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
  it("rejects every credential alias, including null clears, before generic metadata persistence", async () => {
    const service = new ModelConfigService();
    for (const field of CREDENTIAL_FIELD_ALIASES) {
      await expect(service.update("decision_llm", { [field]: null } as never)).rejects.toMatchObject({
        code: "AI_MODEL_CONFIG_CREDENTIAL_FIELD_REJECTED",
        statusCode: 400,
      });
    }
    expect(query).not.toHaveBeenCalled();
  });

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
      code: "AI_ENDPOINT_HTTPS_REQUIRED",
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

  it("requires HTTPS for credential-bearing public and OpenAI endpoints", async () => {
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "models.example.com";
    query.mockResolvedValue({ rows: [row()] });
    await expect(new ModelConfigService().update("decision_llm", {
      endpoint: "http://models.example.com/v1",
      enabled: true,
    })).rejects.toMatchObject({ code: "AI_ENDPOINT_HTTPS_REQUIRED" });

    delete process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST;
    await expect(new ModelConfigService().update("decision_llm", {
      provider: "openai",
      endpoint: "http://api.openai.com/v1",
      enabled: true,
    })).rejects.toMatchObject({ code: "AI_ENDPOINT_HTTPS_REQUIRED" });
  });

  it("rejects public-then-private DNS rebinding at the provider connection", async () => {
    let resolution = 0;
    setModelConfigEndpointResolverForTests(async () => [{
      address: resolution++ === 0 ? "93.184.216.34" : "169.254.169.254",
      family: 4,
    }]);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM model_configs")) return { rows: [row()] };
      if (sql.includes("UPDATE model_configs")) return { rows: [row()] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(new ModelConfigService().test("decision_llm")).rejects.toMatchObject({
      code: "AI_ENDPOINT_PRIVATE_ADDRESS",
    });
    expect(resolution).toBe(2);
  });

  it("connects the provider socket to the policy-validated DNS address", async () => {
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "local:validated.test";
    setModelConfigEndpointResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    let receivedHost = "";
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host ?? "";
      res.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    try {
      const response = await modelConfigFetch(`http://validated.test:${address.port}/models`, {
        signal: AbortSignal.timeout(2_000),
      }, "decision_llm");
      expect(await response.text()).toBe("pinned");
      expect(receivedHost).toBe(`validated.test:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("replacing or clearing a credential ref atomically clears an older DB secret and fingerprint", async () => {
    query.mockResolvedValueOnce({ rows: [row({
      api_key_encrypted: "enc:v1:old",
      credential_ref: null,
      api_key_fingerprint: "old-fingerprint",
    })] });
    query.mockResolvedValueOnce({ rows: [row({ credential_ref: "env:NEW_KEY" })] });

    await new ModelConfigService().updateCredential("decision_llm", { credentialRef: "env:NEW_KEY" });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("api_key_encrypted = $2"), [
      "decision_llm", null, "env:NEW_KEY", null,
    ]);

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [row({
      api_key_encrypted: "enc:v1:old",
      api_key_fingerprint: "old-fingerprint",
    })] });
    query.mockResolvedValueOnce({ rows: [row({ credential_ref: null })] });
    await new ModelConfigService().updateCredential("decision_llm", { credentialRef: null });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("api_key_encrypted = $2"), [
      "decision_llm", null, null, null,
    ]);
  });

  it("atomically combines legacy vision metadata and a supported credential ref", async () => {
    const existing = row({
      role: "vision_vlm",
      model: "vision-old",
      api_key_encrypted: "enc:v1:old",
      credential_ref: null,
      api_key_fingerprint: "old-fingerprint",
    });
    const savedRow = row({
      ...existing,
      role: "vision_vlm",
      model: "vision-next",
      credential_ref: "env:VISION_NEXT_KEY",
      api_key_encrypted: null,
      api_key_fingerprint: null,
      version: 4,
    });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [savedRow] })
      .mockResolvedValueOnce({ rows: [] });

    const config = await new ModelConfigService().updateLegacyVisionConfig({
      model: "vision-next",
      credentialRef: "env:VISION_NEXT_KEY",
    });

    expect(config).toMatchObject({
      role: "vision_vlm",
      model: "vision-next",
      hasCredential: true,
      credentialRefType: "env",
      version: 4,
    });
    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "INSERT", "COMMIT",
    ]);
    expect(clientQuery.mock.calls[2][1]).toEqual([
      "vision_vlm",
      "openai_compatible",
      "https://models.example.com/v1",
      "vision-next",
      null,
      "env:VISION_NEXT_KEY",
      null,
      true,
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(CREDENTIAL_FIELD_ALIASES.filter((field) =>
    !["credentialRef", "apiKeyRef", "api_key_ref"].includes(field),
  ))("rejects unsupported legacy credential alias %s even when null, before acquiring a connection", async (field) => {
    await expect(new ModelConfigService().updateLegacyVisionConfig({
      model: "must-not-write",
      [field]: null,
    })).rejects.toMatchObject({
      code: "AI_LEGACY_VISION_CREDENTIAL_FIELD_REJECTED",
      statusCode: 400,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects populated direct-secret and clear aliases before acquiring a connection", async () => {
    for (const payload of [
      { apiKey: "opaque-secret" },
      { credential: "opaque-secret" },
      { clearCredential: true },
      { clearApiKey: true },
    ]) {
      await expect(new ModelConfigService().updateLegacyVisionConfig({
        model: "must-not-write",
        ...payload,
      })).rejects.toMatchObject({
        code: "AI_LEGACY_VISION_CREDENTIAL_FIELD_REJECTED",
        statusCode: 400,
      });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an invalid legacy credential ref before any metadata write", async () => {
    await expect(new ModelConfigService().updateLegacyVisionConfig({
      model: "must-not-write",
      api_key_ref: "env:../../VISION_KEY",
    })).rejects.toMatchObject({
      code: "AI_CREDENTIAL_REF_UNSUPPORTED",
      statusCode: 400,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rolls back the legacy transaction when the combined credential write fails", async () => {
    const existing = row({
      role: "vision_vlm",
      model: "vision-old",
      credential_ref: "env:VISION_OLD_KEY",
    });
    const credentialFailure = Object.assign(new Error("credential constraint rejected"), { code: "23514" });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] })
      .mockRejectedValueOnce(credentialFailure)
      .mockResolvedValueOnce({ rows: [] });

    await expect(new ModelConfigService().updateLegacyVisionConfig({
      model: "must-rollback",
      apiKeyRef: "env:VISION_REJECTED_KEY",
    })).rejects.toBe(credentialFailure);

    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "INSERT", "ROLLBACK",
    ]);
    expect(clientQuery.mock.calls.filter(([sql]) => /^UPDATE\s/i.test(String(sql).trim()))).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
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
      .toBe("Authorization: [redacted]");
    expect(sanitizeProviderError('{"authorization":"Basic dXNlcjpwYXNz","error":"bad"}'))
      .toBe('{"authorization":"[redacted]","error":"bad"}');
    expect(sanitizeProviderError("Authorization: Basic dXNlcjpwYXNz\nauthorization=opaque-secret"))
      .toBe("Authorization: [redacted]\nauthorization=[redacted]");
  });

  it("removes API-key values and fragments from provider error variants", () => {
    const secrets = [
      "opaque-invalid-secret-123456",
      "opaque-provided-secret-abcdef",
      "opaque-equals-secret-fedcba",
      "opaque-provider-token-987654",
      "opaque-authorization-secret-246810",
    ];
    const messages = [
      `Invalid API key: ${secrets[0]}. Request id: req_safe_123.`,
      `API key provided: ${secrets[1]}`,
      `api key = ${secrets[2]}`,
      `ApI-kEy SuPpLiEd => '${secrets[2]}'`,
      JSON.stringify({
        error: {
          message: `Invalid API key: ${secrets[1]}`,
          headers: { Authorization: secrets[4], "X-Auth-Token": secrets[3], "request-id": "req_safe_456" },
        },
      }),
      JSON.stringify({ error: { message: `API key provided: ${secrets[2]}` } }),
      JSON.stringify({ error: { message: `api key = ${secrets[0]}` } }),
      `Authorization header: Bearer ${secrets[4]}`,
      `Proxy-Authorization=Basic ${secrets[4]}`,
      `x-api-key=${secrets[3]}`,
      `access_token: ${secrets[3]}`,
    ];

    for (const sanitized of messages.map((message) => sanitizeProviderError(message))) {
      for (const secret of secrets) {
        expect(sanitized).not.toContain(secret);
        expect(sanitized).not.toContain(secret.slice(0, 12));
        expect(sanitized).not.toContain(secret.slice(-12));
      }
    }
    expect(sanitizeProviderError(messages[0])).toContain("Request id: req_safe_123");
    expect(sanitizeProviderError(messages[4])).toContain("req_safe_456");
  });

  it("sanitizes historical last_test_message values before returning them", async () => {
    const secret = "opaque-historical-secret-123456";
    query.mockResolvedValueOnce({ rows: [row({
      last_test_status: "error",
      last_test_message: `Invalid API key: ${secret}. Request id: req_safe_historical.`,
    })] });

    const config = await new ModelConfigService().get("decision_llm");

    expect(config?.lastTestMessage).not.toContain(secret);
    expect(config?.lastTestMessage).toContain("req_safe_historical");
  });

  it("stores only sanitized provider failure text in last_test_message", async () => {
    const secret = "opaque-last-test-message-secret-123456";
    process.env.MODEL_CONFIG_TEST_KEY = secret;
    process.env.MODEL_CONFIG_ENDPOINT_ALLOWLIST = "local:provider.test";
    setModelConfigEndpointResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Invalid API key: ${secret}`,
          headers: { Authorization: secret },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT * FROM model_configs WHERE role = $1")) {
        return { rows: [row({ role: params?.[0], endpoint: `http://provider.test:${address.port}/v1` })] };
      }
      if (sql.includes("UPDATE model_configs")) {
        const message = String(params?.[2] ?? "");
        expect(message).not.toContain(secret);
        expect(message).not.toContain(secret.slice(0, 12));
        expect(message).not.toContain(secret.slice(-12));
        return { rows: [row({ last_test_status: params?.[1], last_test_message: message })] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    try {
      let failure: unknown;
      try {
        await new ModelConfigService().test("decision_llm");
      } catch (err) {
        failure = err;
      }
      expect(failure).toMatchObject({ code: "AI_PROVIDER_TEST_FAILED" });
      expect((failure as Error).message).not.toContain(secret);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
