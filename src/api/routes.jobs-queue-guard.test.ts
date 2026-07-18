import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  db: { query: vi.fn() },
  hasWorkingWorkflow: vi.fn(),
  dispatch: vi.fn(),
  sendJobToDevice: vi.fn(),
  isDeviceOnline: vi.fn(),
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
  getPoolStats: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0, maxCount: 50 })),
}));

vi.mock("../modules/workflows/workflow-queue.service", () => ({
  workflowQueueService: { hasWorkingWorkflow: mocks.hasWorkingWorkflow },
}));

vi.mock("../modules/dispatcher/dispatcher.service", () => ({
  dispatcherService: {
    dispatch: mocks.dispatch,
    listJobs: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

vi.mock("../transport/transport", () => ({
  sendJobToDevice: mocks.sendJobToDevice,
  isDeviceOnline: mocks.isDeviceOnline,
}));

vi.mock("../ws/direct-ws.server", () => ({
  directWsServer: {
    getConnectedDeviceIds: vi.fn(() => []),
    getAgentVersion: vi.fn(() => null),
    supportsEdgeExecution: vi.fn(() => false),
    getConnectionCount: vi.fn(() => 0),
  },
}));

async function app() {
  const server = express();
  server.use(express.json());
  const { default: apiRouter } = await import("./routes");
  server.use("/api", apiRouter);
  return server;
}

async function postJob(): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
          body: JSON.stringify({ deviceId: DEVICE_ID, type: "screenshot", params: { quality: 80 } }),
        });
        const body = await response.json();
        listener.close(() => resolve({ status: response.status, body }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("POST /api/jobs workflow queue guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.isDeviceOnline.mockReturnValue(true);
    mocks.dispatch.mockResolvedValue({ jobId: "22222222-2222-4222-8222-222222222222", timeoutMs: 30_000 });
    mocks.sendJobToDevice.mockReturnValue(true);
  });

  it("rejects a raw job while a workflow is working on the device", async () => {
    mocks.hasWorkingWorkflow.mockResolvedValue(true);

    const response = await postJob();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      ok: false,
      code: "DEVICE_WORKFLOW_BUSY",
      error: "A workflow is already working on this device. Retry after it reaches done or failed.",
    });
    expect(mocks.hasWorkingWorkflow).toHaveBeenCalledWith(DEVICE_ID);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.sendJobToDevice).not.toHaveBeenCalled();
  });

  it("keeps raw jobs available while the device workflow queue is idle", async () => {
    mocks.hasWorkingWorkflow.mockResolvedValue(false);

    const response = await postJob();

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      data: { jobId: "22222222-2222-4222-8222-222222222222", status: "queued" },
    });
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.sendJobToDevice).toHaveBeenCalledOnce();
  });
});
