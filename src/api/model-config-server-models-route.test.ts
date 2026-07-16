import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "./auth.middleware";

const mocks = vi.hoisted(() => ({
  directWsServer: {
    getConnectedDeviceIds: vi.fn(() => []),
    sendToDevice: vi.fn(),
  },
  modelConfigService: {
    update: vi.fn(),
    updateCredential: vi.fn(),
  },
  visionService: {
    invalidateCache: vi.fn(),
  },
}));

vi.mock("../ws/direct-ws.server", () => ({
  directWsServer: mocks.directWsServer,
}));

vi.mock("../modules/vision/vision.service", () => ({
  visionService: mocks.visionService,
}));

vi.mock("../modules/model-config/model-config.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/model-config/model-config.service")>();
  return {
    ...actual,
    modelConfigService: mocks.modelConfigService,
  };
});

async function app() {
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import("./routes");
  app.use("/api", apiRouter);
  return app;
}

async function requestJson(
  route: "model-configs" | "server/models",
  method: "PATCH" | "PUT",
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const server = await app();
  const token = signJwt({ sub: "dashboard-user", role: "admin" }, 60_000);
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/${route}/decision_llm`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const responseBody = await response.json();
        listener.close(() => resolve({ status: response.status, body: responseBody }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

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

describe("generic model config route credential contract", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.modelConfigService.update.mockReset();
    mocks.modelConfigService.updateCredential.mockReset();
    mocks.visionService.invalidateCache.mockReset();
    mocks.directWsServer.sendToDevice.mockReset();
    mocks.modelConfigService.update.mockResolvedValue({
      role: "decision_llm",
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "qwen-test",
      hasCredential: true,
    });
  });

  it.each([
    ["model-configs", "PATCH"],
    ["model-configs", "PUT"],
    ["server/models", "PATCH"],
    ["server/models", "PUT"],
  ] as const)("rejects credential fields on %s %s", async (route, method) => {
    const response = await requestJson(route, method, {
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "qwen-test",
      credentialRef: "env:NEW_MODEL_KEY",
      apiKey: "sk-route-secret-123456",
      api_key_encrypted: "enc:v1:stale-secret",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "AI_MODEL_CONFIG_CREDENTIAL_FIELD_REJECTED",
    });
    expect(JSON.stringify(response.body)).not.toContain("sk-route-secret");
    expect(JSON.stringify(response.body)).not.toContain("stale-secret");
    expect(mocks.modelConfigService.update).not.toHaveBeenCalled();
    expect(mocks.modelConfigService.updateCredential).not.toHaveBeenCalled();
    expect(mocks.directWsServer.sendToDevice).not.toHaveBeenCalled();
  });

  it.each(CREDENTIAL_FIELD_ALIASES)("rejects own field %s even when its value is null on both aliases", async (field) => {
    for (const route of ["model-configs", "server/models"] as const) {
      const response = await requestJson(route, "PATCH", {
        provider: "openai_compatible",
        endpoint: "https://models.example.com/v1",
        model: "qwen-test",
        [field]: null,
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: "AI_MODEL_CONFIG_CREDENTIAL_FIELD_REJECTED",
      });
    }
    expect(mocks.modelConfigService.update).not.toHaveBeenCalled();
    expect(mocks.modelConfigService.updateCredential).not.toHaveBeenCalled();
    expect(mocks.directWsServer.sendToDevice).not.toHaveBeenCalled();
  });
});
