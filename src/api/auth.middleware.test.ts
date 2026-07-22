import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireApiGateAuth, signJwt } from "./auth.middleware";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function app() {
  const app = express();
  app.use(express.json());
  app.use("/api", requireApiGateAuth);
  app.get("/api/devices", (req, res) => res.json({ ok: true, principal: (req as any).authPrincipal }));
  app.get("/api/debug/connections", (_req, res) => res.json({ ok: true }));
  app.get("/api/scalability/status", (_req, res) => res.json({ ok: true }));
  app.get("/api/incidents", (_req, res) => res.json({ ok: true }));
  app.get("/api/incidents/11111111-1111-4111-8111-111111111111", (_req, res) => res.json({ ok: true }));
  app.get("/api/audits/daily", (_req, res) => res.json({ ok: true }));
  app.post("/api/agency/workflow-runs", (_req, res) => res.status(201).json({ ok: true }));
  app.post("/api/device-tokens/generate", (_req, res) => res.status(201).json({ ok: true }));
  app.post("/api/kill-switch", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function request(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const server = app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers });
        const body = await response.json();
        listener.close(() => resolve({ status: response.status, body }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

function mockTokenRow(token: string, row: Record<string, unknown> | null) {
  mocks.db.query.mockImplementationOnce(async (_sql: string, params: string[]) => {
    expect(params).toEqual([tokenHash(token)]);
    return { rows: row ? [row] : [] };
  });
}

describe("API auth middleware", () => {
  beforeEach(() => {
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.db.query.mockReset();
  });

  it("accepts a valid openclaw_agent token for read-only device monitoring", async () => {
    mockTokenRow("agent-token", {
      id: "token-1",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("GET", "/api/devices", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
    expect(response.body.principal).toMatchObject({
      kind: "api_token",
      purpose: "openclaw_agent",
      tokenId: "token-1",
    });
  });

  it("rejects an unknown API token", async () => {
    mockTokenRow("bad-token", null);

    const response = await request("GET", "/api/devices", { authorization: "Bearer bad-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("rejects an expired API token", async () => {
    mockTokenRow("expired-token", {
      id: "token-2",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("GET", "/api/devices", { authorization: "Bearer expired-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("rejects a revoked API token", async () => {
    mockTokenRow("revoked-token", {
      id: "token-3",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: new Date().toISOString(),
    });

    const response = await request("GET", "/api/devices", { authorization: "Bearer revoked-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("allows monitoring-purpose tokens on read-only status routes", async () => {
    mockTokenRow("monitor-token", {
      id: "token-4",
      purpose: "monitoring",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("GET", "/api/debug/connections", { authorization: "Bearer monitor-token" });

    expect(response.status).toBe(200);
  });

  it("accepts a valid openclaw_agent token for read-only connection monitoring", async () => {
    mockTokenRow("agent-token", {
      id: "token-5",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("GET", "/api/debug/connections", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(200);
  });

  it.each([
    "/api/incidents",
    "/api/incidents/11111111-1111-4111-8111-111111111111",
    "/api/audits/daily",
  ])("allows openclaw_agent tokens on Kraken read route %s", async (path) => {
    mockTokenRow("agent-token", {
      id: "token-kraken",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("GET", path, { authorization: "Bearer agent-token" });
    expect(response.status).toBe(200);
  });

  it("denies openclaw_agent tokens on mutating workflow routes", async () => {
    mockTokenRow("agent-token", {
      id: "token-6",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("POST", "/api/agency/workflow-runs", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("denies openclaw_agent tokens on POST /api/kill-switch", async () => {
    mockTokenRow("agent-token", {
      id: "token-7",
      purpose: "openclaw_agent",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("POST", "/api/kill-switch", { authorization: "Bearer agent-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("allows admin API tokens on admin-only routes", async () => {
    mockTokenRow("admin-token", {
      id: "token-8",
      purpose: "admin",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    });

    const response = await request("POST", "/api/device-tokens/generate", { authorization: "Bearer admin-token" });

    expect(response.status).toBe(201);
  });

  it("keeps global API key compatibility for admin routes", async () => {
    const response = await request("POST", "/api/agency/workflow-runs", { "x-api-key": "test-api-key" });

    expect(response.status).toBe(201);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("keeps dashboard JWT compatibility for admin routes", async () => {
    const token = signJwt({ sub: "dashboard-user", role: "admin" }, 60_000);

    const response = await request("POST", "/api/agency/workflow-runs", { authorization: `Bearer ${token}` });

    expect(response.status).toBe(201);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });
});
