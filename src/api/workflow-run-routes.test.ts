import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

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
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("disables POST /api/workflow-runs because it bypasses the device queue", async () => {
    const response = await postWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      ok: false,
      code: "WORKFLOW_RUNS_ENDPOINT_DISABLED",
      error: "POST /api/workflow-runs is disabled because it bypasses the per-device workflow queue.",
      replacement: "/api/workflows/human/run",
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
  });
});
