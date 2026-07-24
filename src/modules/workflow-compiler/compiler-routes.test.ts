import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

async function postLegacy(path: string) {
  const app = express();
  app.use(express.json());
  const { default: router } = await import("./compiler-routes");
  app.use("/api/hydra/workflow", router);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const listener = app.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/hydra/workflow/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
          body: "{}",
        });
        const body = await response.json() as Record<string, unknown>;
        listener.close(() => resolve({ status: response.status, body }));
      } catch (error) {
        listener.close(() => reject(error));
      }
    });
  });
}

describe("retired workflow compiler routes", () => {
  beforeEach(() => {
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it.each(["compile", "compile-and-run", "run-compiled"])("returns 410 for %s", async (path) => {
    const response = await postLegacy(path);
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("LEGACY_WORKFLOW_COMPILER_RETIRED");
  });
});
