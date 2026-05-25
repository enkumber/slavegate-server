import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCreativeWorkflowRun: vi.fn(),
}));

vi.mock("../modules/creative-workflows/creative-workflow.service", () => ({
  createCreativeWorkflowRun: mocks.createCreativeWorkflowRun,
}));

async function postCreative(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("./creative-workflow-routes");
  app.use("/api/creative-workflows", router);

  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const listener = app.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${address.port}/api/creative-workflows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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

describe("creative workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 for queued creative workflow runs", async () => {
    mocks.createCreativeWorkflowRun.mockResolvedValueOnce({
      runId: "run-1",
      proposal: { objective: "Scan", intent: "account_scan", safetyClass: "read_only", summary: "Scan", clientId: "c", accountId: "a", deviceId: "d" },
      status: "queued",
      agencyWorkflowRunId: "run-1",
      taskId: "task-1",
      message: "queued",
    });

    const response = await postCreative({ clientId: "c", accountId: "a", deviceId: "d", objective: "Scan" });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.taskId).toBe("task-1");
  });

  it("returns 400 for missing required fields", async () => {
    mocks.createCreativeWorkflowRun.mockResolvedValueOnce({
      runId: null,
      proposal: { objective: "", intent: "account_scan", safetyClass: "read_only", summary: "", clientId: "", accountId: "", deviceId: "" },
      status: "not_ready",
      code: "CREATIVE_WORKFLOW_MISSING_FIELDS",
      agencyWorkflowRunId: null,
      taskId: null,
      message: "missing",
    });

    const response = await postCreative({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe("CREATIVE_WORKFLOW_MISSING_FIELDS");
  });

  it("returns 409 for not-ready artifact states", async () => {
    mocks.createCreativeWorkflowRun.mockResolvedValueOnce({
      runId: null,
      proposal: { objective: "Scan", intent: "account_scan", safetyClass: "read_only", summary: "Scan", clientId: "c", accountId: "a", deviceId: "d" },
      status: "not_ready",
      code: "CREATIVE_WORKFLOW_ARTIFACT_NOT_READY",
      agencyWorkflowRunId: null,
      taskId: null,
      message: "not ready",
    });

    const response = await postCreative({ clientId: "c", accountId: "a", deviceId: "d", objective: "Scan" });

    expect(response.status).toBe(409);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe("CREATIVE_WORKFLOW_ARTIFACT_NOT_READY");
  });
});
