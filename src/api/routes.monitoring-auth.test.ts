import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "./auth.middleware";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
  getPoolStats: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0, maxCount: 50 })),
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
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
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
  });

  it("allows openclaw_agent tokens on GET /api/debug/connections", async () => {
    mockOpenClawTokenLookup("agent-token");

    const response = await getJson("/api/debug/connections", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { count: 0, connections: [] } });
  });

  it("allows openclaw_agent tokens on GET /api/scalability/status", async () => {
    mockOpenClawTokenLookup("agent-token");
    mocks.db.query.mockImplementationOnce(async () => ({ rows: [] }));

    const response = await getJson("/api/scalability/status", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toMatchObject({
      current: {
        workflows: { queued: 0, running: 0, paused: 0, total: 0 },
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
});
