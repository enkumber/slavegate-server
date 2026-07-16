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

vi.mock("../modules/model-config/model-config.service", () => {
  class ModelConfigError extends Error {
    statusCode: number;
    code: string;
    constructor(message: string, statusCode = 400, code = "AI_MODEL_CONFIG_ERROR") {
      super(message);
      this.name = "ModelConfigError";
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    ModelConfigError,
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

async function requestJson(method: "PATCH" | "PUT", body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const server = await app();
  const token = signJwt({ sub: "dashboard-user", role: "admin" }, 60_000);
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/server/models/decision_llm`, {
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

describe("/server/models/:role credential contract", () => {
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

  it.each(["PATCH", "PUT"] as const)("rejects credential fields on %s /api/server/models/:role", async (method) => {
    const response = await requestJson(method, {
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

  it("rejects credentialRef null on the legacy config route so stale DB secrets cannot win", async () => {
    const response = await requestJson("PATCH", {
      provider: "openai_compatible",
      endpoint: "https://models.example.com/v1",
      model: "qwen-test",
      credentialRef: null,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "AI_MODEL_CONFIG_CREDENTIAL_FIELD_REJECTED",
    });
    expect(mocks.modelConfigService.update).not.toHaveBeenCalled();
    expect(mocks.modelConfigService.updateCredential).not.toHaveBeenCalled();
  });
});
