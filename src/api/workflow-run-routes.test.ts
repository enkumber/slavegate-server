import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

describe("retired workflow-runs API", () => {
  beforeEach(() => {
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("returns 410 and directs callers to the PostgreSQL-backed human workflow API", async () => {
    const app = express();
    app.use(express.json());
    const { default: router } = await import("./workflow-run-routes");
    app.use("/api/workflow-runs", router);
    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const listener = app.listen(0, async () => {
        try {
          const address = listener.address();
          if (!address || typeof address === "string") throw new Error("no address");
          const result = await fetch(`http://127.0.0.1:${address.port}/api/workflow-runs`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
            body: "{}",
          });
          const body = await result.json() as Record<string, unknown>;
          listener.close(() => resolve({ status: result.status, body }));
        } catch (error) {
          listener.close(() => reject(error));
        }
      });
    });
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("LEGACY_WORKFLOW_RUN_RETIRED");
  });
});
