import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
}));

vi.mock("../../db/client", () => ({ getDb: () => ({ query: mocks.dbQuery }) }));
vi.mock("../../transport/transport", () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock("./planner.service", () => ({ compileInstruction: vi.fn(), getCompiledWorkflow: vi.fn() }));

async function postRunCompiled(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("./compiler-routes");
  app.use("/api/hydra/workflow", router);

  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const listener = app.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/hydra/workflow/run-compiled`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
          body: JSON.stringify(body),
        });
        const responseBody = await response.json() as Record<string, unknown>;
        listener.close(() => resolve({ status: response.status, body: responseBody }));
      } catch (error) {
        listener.close(() => reject(error));
      }
    });
  });
}

describe("workflow compiler routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("queues compiled execution instead of dispatching directly to the device", async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [{ id: "22222222-2222-4222-8222-222222222222" }] });

    const response = await postRunCompiled({
      deviceId: "device-1",
      compiledWorkflow: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Controlled canary",
        source: "read-only canary",
        appId: "com.example.app",
        compiledAt: "2026-07-21T00:00:00.000Z",
        steps: [{
          id: "observe",
          action: "screenshot",
          expectedPage: "home",
          expectedPageHash: "abc123",
          retries: 0,
          retryDelay: 0,
          description: "Read-only observation"
        }],
        appMapVersion: "1",
        startPage: "home",
        maxRecoveryAttempts: 1,
        maxTotalRecoveryAttempts: 1
      }
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      taskId: "22222222-2222-4222-8222-222222222222",
      jobId: "22222222-2222-4222-8222-222222222222",
      workflowId: "11111111-1111-4111-8111-111111111111",
      status: "queued"
    });
    expect(mocks.dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tasks"),
      expect.arrayContaining([
        "device-1",
        "compiled_workflow",
        expect.stringContaining('"disableTaskRetry":true'),
      ]),
    );
  });

  it("returns bounded JSON when queue admission fails", async () => {
    mocks.dbQuery.mockRejectedValueOnce(new Error("queue unavailable"));
    const response = await postRunCompiled({
      deviceId: "device-1",
      compiledWorkflow: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Controlled canary",
        source: "read-only canary",
        appId: "com.example.app",
        compiledAt: "2026-07-21T00:00:00.000Z",
        steps: [{ id: "observe", action: "screenshot", expectedPage: "home", expectedPageHash: "abc123", retries: 0, retryDelay: 0, description: "Observe" }],
        appMapVersion: "1",
        startPage: "home",
        maxRecoveryAttempts: 1,
        maxTotalRecoveryAttempts: 1
      }
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      code: "RUN_COMPILED_ENQUEUE_FAILED",
      status: "failed",
      error: "queue unavailable"
    });
  });
});
