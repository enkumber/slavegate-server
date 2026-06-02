import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkflowRun: vi.fn(),
}));

vi.mock("../modules/workflow-runs", () => ({
  createWorkflowRun: mocks.createWorkflowRun,
}));

async function app() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("./workflow-run-routes");
  app.use("/api/workflow-runs", router);
  return app;
}

async function appWithApiAuthGate() {
  process.env.API_KEY = "test-api-key";
  process.env.JWT_SECRET = "test-jwt-secret";

  const app = express();
  app.use(express.json());
  const [{ default: apiRouter }, { default: workflowRunRouter }] = await Promise.all([
    import("./routes"),
    import("./workflow-run-routes"),
  ]);
  app.use("/api", apiRouter);
  app.use("/api/workflow-runs", workflowRunRouter);
  return app;
}

async function postWorkflowRun(body: Record<string, unknown>) {
  const server = await app();
  return postJson(server, "/api/workflow-runs", body, { "x-api-key": "test-api-key" });
}

async function postJson(server: express.Express, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        listener.close(() => resolve({ status: res.status, body: json }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("workflow-runs API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("exposes POST /api/workflow-runs as the unified workflow-run surface", async () => {
    mocks.createWorkflowRun.mockResolvedValueOnce({
      ok: true,
      httpStatus: 201,
      status: "completed",
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        instruction: "tap continue",
        appId: "com.example.app",
        deviceId: "device-1",
        status: "completed",
        workflowId: "55555555-5555-4555-8555-555555555555",
        discoveryRan: false,
      },
    });

    const response = await postWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        workflowId: "55555555-5555-4555-8555-555555555555",
      },
    });
    expect(mocks.createWorkflowRun).toHaveBeenCalledWith({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });
  });

  it("returns service validation failures without changing the route contract", async () => {
    mocks.createWorkflowRun.mockResolvedValueOnce({
      ok: false,
      httpStatus: 400,
      status: "validation_failed",
      code: "WORKFLOW_RUN_MISSING_FIELDS",
      error: "instruction, appId and deviceId required",
    });

    const response = await postWorkflowRun({ instruction: "tap continue" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      code: "WORKFLOW_RUN_MISSING_FIELDS",
      error: "instruction, appId and deviceId required",
    });
  });

  it("is protected by the /api auth gate when mounted in server order", async () => {
    const server = await appWithApiAuthGate();
    const response = await postJson(server, "/api/workflow-runs", {
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
    expect(mocks.createWorkflowRun).not.toHaveBeenCalled();
  });
});
