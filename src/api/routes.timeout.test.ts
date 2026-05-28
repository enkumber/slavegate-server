import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

async function getJson(path: string): Promise<{ status: number; body: any }> {
  process.env.REQUEST_TIMEOUT_MS = "10";
  process.env.API_KEY = "test-api-key";
  process.env.JWT_SECRET = "test-jwt-secret";
  vi.resetModules();

  const app = express();
  const { default: apiRouter } = await import("./routes");
  app.use("/api", apiRouter);
  app.use("/api/mapping", (_req, res) => {
    setTimeout(() => res.json({ ok: true }), 25);
  });

  return new Promise((resolve, reject) => {
    const listener = app.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          headers: { "x-api-key": "test-api-key" },
        });
        const body = await response.json();
        listener.close(() => resolve({ status: response.status, body }));
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("api request timeout", () => {
  afterEach(() => {
    delete process.env.REQUEST_TIMEOUT_MS;
    delete process.env.API_KEY;
    delete process.env.JWT_SECRET;
    vi.resetModules();
  });

  it("does not apply the generic /api timeout to mapping routes", async () => {
    const response = await getJson("/api/mapping/slow");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
