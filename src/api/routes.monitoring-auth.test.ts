import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "./auth.middleware";
import { ResourceLifecyclePolicyUnavailableError } from "../modules/lifecycle/lifecycle.service";

const mocks = vi.hoisted(() => ({
  db: {
    connect: vi.fn(),
    query: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  dispatcherService: {
    dispatch: vi.fn(),
    getJob: vi.fn(),
  },
  transport: {
    isDeviceOnline: vi.fn(),
    sendStandaloneJobToDevice: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
  getPoolStats: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0, maxCount: 50 })),
}));

vi.mock("../modules/dispatcher/dispatcher.service", () => ({
  dispatcherService: mocks.dispatcherService,
}));

vi.mock("../transport/transport", () => ({
  isDeviceOnline: mocks.transport.isDeviceOnline,
  sendStandaloneJobToDevice: mocks.transport.sendStandaloneJobToDevice,
}));

vi.mock("../ws/direct-ws.server", () => ({
  directWsServer: {
    getConnectedDeviceIds: vi.fn(() => []),
    getAgentVersion: vi.fn(() => null),
    supportsEdgeExecution: vi.fn(() => false),
    getConnectionCount: vi.fn(() => 0),
  },
}));

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function app() {
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import("./routes");
  app.use("/api", apiRouter);
  return app;
}

async function getJson(path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return requestJson("GET", path, headers);
}

async function requestJson(
  method: string,
  path: string,
  headers: Record<string, string>,
  requestBody?: unknown,
): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method,
          headers: requestBody === undefined ? headers : { ...headers, "content-type": "application/json" },
          body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
        });
        const body = await response.json();
        listener.close(() => resolve({ status: response.status, body }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

function mockOpenClawTokenLookup(token: string): void {
  mocks.db.query.mockImplementationOnce(async (_sql: string, params: string[]) => {
    expect(params).toEqual([tokenHash(token)]);
    return {
      rows: [{
        id: "token-openclaw",
        purpose: "openclaw_agent",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: null,
      }],
    };
  });
}

describe("real API router monitoring auth", () => {
  beforeEach(() => {
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.db.query.mockReset();
    mocks.db.connect.mockReset();
    mocks.client.query.mockReset();
    mocks.client.release.mockReset();
    mocks.db.connect.mockResolvedValue(mocks.client);
    mocks.dispatcherService.dispatch.mockReset();
    mocks.dispatcherService.getJob.mockReset();
    mocks.transport.isDeviceOnline.mockReset();
    mocks.transport.sendStandaloneJobToDevice.mockReset();
    mocks.dispatcherService.getJob.mockImplementation(async (id: string) => {
      const result = await mocks.db.query("SELECT * FROM jobs WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    });
    mocks.transport.isDeviceOnline.mockReturnValue(true);
    mocks.transport.sendStandaloneJobToDevice.mockResolvedValue({ sent: true, queued: false, decision: "dispatched" });
  });

  it("allows openclaw_agent tokens on GET /api/debug/connections", async () => {
    mockOpenClawTokenLookup("agent-token");

    const response = await getJson("/api/debug/connections", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { count: 0, connections: [] } });
  });

  it("allows openclaw_agent tokens on GET /api/scalability/status", async () => {
    mockOpenClawTokenLookup("agent-token");
    mocks.db.query.mockImplementationOnce(async () => ({
      rows: [
        { status: "operator_ready", count: "0" },
        { status: "operator_running", count: "0" },
      ],
    }));

    const response = await getJson("/api/scalability/status", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toMatchObject({
      current: {
        workflows: { operator_ready: 0, operator_running: 0, total: 0 },
        webSocket: { totalConnections: 0, onlineDevices: 0 },
      },
    });
  });

  it("allows Kraken read-only access to the incident registry", async () => {
    mockOpenClawTokenLookup("agent-token");
    mocks.db.query.mockResolvedValueOnce({ rows: [{ id: "incident-1", status: "open", assigned_agent: "kraken" }] });

    const response = await getJson("/api/incidents", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      data: [{ id: "incident-1", status: "open", assigned_agent: "kraken" }],
    });
  });

  it("keeps dashboard JWT compatibility on real monitoring routes", async () => {
    const token = signJwt({ sub: "dashboard-user", role: "admin" }, 60_000);

    const response = await getJson("/api/debug/connections", { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { count: 0, connections: [] } });
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("returns the persisted execution trace for an admin job lookup", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    mocks.db.query
      .mockResolvedValueOnce({ rows: [{
        id: jobId,
        device_id: "22222222-2222-4222-8222-222222222222",
        job_type: "open_app",
        params: {},
        status: "timeout",
        timeout_ms: 30_000,
        created_at: new Date(),
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 1,
        job_id: jobId,
        source: "direct_ws",
        event_type: "direct_ws_frame_sent",
        details: { jobType: "open_app" },
      }] });

    const response = await getJson(`/api/jobs/${jobId}/events`, { "x-api-key": "test-api-key" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ event_type: "direct_ws_frame_sent" }),
    ]);
  });

  it("requires admin auth for generic lifecycle resource policy GET, PUT, and DELETE", async () => {
    await expect(requestJson(
      "GET",
      "/api/lifecycle-resource-policies",
      {},
    )).resolves.toMatchObject({ status: 401 });

    await expect(requestJson(
      "PUT",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { authorization: "Bearer agent-token" },
      { policy: { arbitrary: true } },
    )).resolves.toMatchObject({ status: 401 });

    mockOpenClawTokenLookup("agent-token");
    await expect(requestJson(
      "DELETE",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { authorization: "Bearer agent-token" },
    )).resolves.toMatchObject({ status: 401 });
  });

  it("validates lifecycle resource policy payloads with clear structural errors", async () => {
    const response = await requestJson(
      "PUT",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { "x-api-key": "test-api-key" },
      { policy: { enabled: "yes" } },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("policy.enabled must be a boolean");
    expect(mocks.client.query).not.toHaveBeenCalled();
  });

  it("upserts, reads back, disables, and deletes a generic bound lifecycle policy", async () => {
    const row = {
      resource_table: "public.operator_resources",
      state_column: "state",
      policy: { arbitrary: { nested: true } },
      version: "1",
      updated_by: "operator",
      updated_at: new Date("2026-07-27T00:00:00.000Z"),
    };
    mocks.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ ...row, policy: { enabled: false }, version: "2" }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
      .mockResolvedValueOnce({});
    mocks.db.query.mockResolvedValueOnce({ rows: [row] });

    const upserted = await requestJson(
      "PUT",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { "x-api-key": "test-api-key" },
      { policy: { arbitrary: { nested: true } }, updatedBy: "operator" },
    );
    expect(upserted.status).toBe(200);
    expect(upserted.body.data).toMatchObject({ policy: { arbitrary: { nested: true } } });

    const readback = await requestJson(
      "GET",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { "x-api-key": "test-api-key" },
    );
    expect(readback.status).toBe(200);
    expect(readback.body.data).toMatchObject({ resourceTable: "public.operator_resources", stateColumn: "state" });

    const disabled = await requestJson(
      "PUT",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { "x-api-key": "test-api-key" },
      { disabled: true, updatedBy: "operator" },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.policy).toEqual({ enabled: false });

    const deleted = await requestJson(
      "DELETE",
      "/api/lifecycle-resource-policies/operator_resources/state",
      { "x-api-key": "test-api-key" },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ ok: true, deleted: true });
  });

  it("contains lifecycle admission policy failures and keeps health responsive in the same process", async () => {
    mocks.dispatcherService.dispatch
      .mockRejectedValueOnce(new ResourceLifecyclePolicyUnavailableError(
        "resource lifecycle operational policy is not configured",
      ))
      .mockRejectedValueOnce(new Error("lifecycle transition selector is ambiguous"));

    const server = await app();
    await new Promise<void>((resolve, reject) => {
      const listener = server.listen(0, async () => {
        try {
          const address = listener.address();
          if (!address || typeof address === "string") throw new Error("no address");
          const baseUrl = `http://127.0.0.1:${address.port}`;
          const body = JSON.stringify({ deviceId: "device-a", type: "screenshot", params: {} });

          const missing = await fetch(`${baseUrl}/api/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
            body,
          });
          expect(missing.status).toBe(503);
          await expect(missing.json()).resolves.toMatchObject({
            ok: false,
            code: "LIFECYCLE_RESOURCE_POLICY_UNAVAILABLE",
            details: { retryable: true },
          });

          const ambiguous = await fetch(`${baseUrl}/api/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
            body,
          });
          expect(ambiguous.status).toBe(400);
          await expect(ambiguous.json()).resolves.toMatchObject({
            ok: false,
            error: "lifecycle transition selector is ambiguous",
          });

          const health = await fetch(`${baseUrl}/api/health`, {
            headers: { "x-api-key": "test-api-key" },
          });
          expect(health.status).toBe(200);
          await expect(health.json()).resolves.toMatchObject({
            ok: true,
            data: { health: "healthy" },
          });
          listener.close(() => resolve());
        } catch (err) {
          listener.close(() => reject(err));
        }
      });
    });
    expect(mocks.transport.sendStandaloneJobToDevice).not.toHaveBeenCalled();
  });
});
