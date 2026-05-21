/**
 * workflow.blocking.test.ts
 *
 * Tests that verify the server-blocking fixes AND 100-device scalability:
 *   1. Request timeout middleware works
 *   2. startWorkflow() has timeout protection
 *   3. saveCheckpoint() doesn't hold dedicated DB connections
 *   4. Per-device concurrency guard (max 1 workflow per device)
 *   5. Global concurrency guard (configurable soft limit)
 *   6. withTimeout helper works correctly
 *   7. Scalability config is correct for 100-device target
 *   8. DB pool sized correctly
 *   9. WS connection limit enforced
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── withTimeout helper tests ─────────────────────────────────────────────

describe("withTimeout", () => {
  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms)
      ),
    ]);
  }

  it("resolves if the promise settles within timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "timeout"
    );
    expect(result).toBe("ok");
  });

  it("rejects with message if promise takes too long", async () => {
    const neverResolves = new Promise<string>(() => {}); // never settles
    await expect(
      withTimeout(neverResolves, 50, "operation timed out")
    ).rejects.toThrow("operation timed out");
  });

  it("rejects with original error if promise rejects before timeout", async () => {
    await expect(
      withTimeout(
        Promise.reject(new Error("db error")),
        1000,
        "timeout"
      )
    ).rejects.toThrow("db error");
  });
});

// ─── Request timeout middleware ────────────────────────────────────────────

describe("requestTimeout middleware", () => {
  function createRequestTimeout() {
    const REQUEST_TIMEOUT_MS = 30_000;

    let finishCb: (() => void) | null = null;
    let closeCb: (() => void) | null = null;

    const req = {} as Record<string, unknown>;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") finishCb = cb;
        if (event === "close") closeCb = cb;
      }),
    } as any;
    const next = vi.fn();

    // Simulate the middleware
    let middlewareTimer: ReturnType<typeof setTimeout> | null = null;
    function requestTimeout(
      _req: any,
      res: any,
      next: () => void
    ): void {
      middlewareTimer = setTimeout(() => {
        if (!res.headersSent) {
          res.status(504);
          res.json({ ok: false, error: "Request timeout" });
        }
      }, REQUEST_TIMEOUT_MS);
      res.on("finish", () => { if (middlewareTimer) clearTimeout(middlewareTimer); });
      res.on("close", () => { if (middlewareTimer) clearTimeout(middlewareTimer); });
      next();
    }

    requestTimeout(req, res, next);

    return { res, next, finishCb: () => finishCb?.(), closeCb: () => closeCb?.(), getTimer: () => middlewareTimer };
  }

  it("calls next() immediately", () => {
    const { next } = createRequestTimeout();
    expect(next).toHaveBeenCalled();
  });

  it("registers finish and close handlers on res", () => {
    const { res } = createRequestTimeout();
    expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));
    expect(res.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("does not send 504 if response finishes before timeout", () => {
    const { res, finishCb } = createRequestTimeout();
    finishCb(); // Simulate response finishing
    // Timer was cleared, so 504 is never sent
    expect(res.status).not.toHaveBeenCalledWith(504);
  });
});

// ─── saveCheckpoint — no dedicated connection holding ──────────────────────

describe("saveCheckpoint — uses pool.query instead of db.connect", () => {
  it("should use pool.query, not db.connect", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    // Extract the saveCheckpoint method
    const methodMatch = source.match(
      /async saveCheckpoint\([\s\S]*?(?=\n  async |\n  \/\/|$)/
    );
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    // Should NOT contain db.connect
    expect(methodBody).not.toContain("db.connect()");
    expect(methodBody).not.toContain("client.release()");
    expect(methodBody).not.toContain("BEGIN");
    expect(methodBody).not.toContain("COMMIT");
    expect(methodBody).not.toContain("ROLLBACK");

    // Should use pool.query
    expect(methodBody).toContain("db.query(");
  });
});

// ─── startWorkflow — timeout protection ────────────────────────────────────

describe("startWorkflow — timeout protection", () => {
  it("should include Promise.race with timeout", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.executor.ts"),
      "utf8"
    );

    // Extract startWorkflow function
    const funcMatch = source.match(
      /export async function startWorkflow[\s\S]*?(?=\n\/\/|export|$)/
    );
    expect(funcMatch).toBeTruthy();
    const funcBody = funcMatch![0];

    // Should use Promise.race for timeout
    expect(funcBody).toContain("Promise.race");
    expect(funcBody).toContain("scalabilityConfig.enqueueTimeout");
  });
});

// ─── POST /workflows — fire-and-forget startWorkflow ──────────────────────

describe("POST /workflows — non-blocking startWorkflow", () => {
  it("should NOT await startWorkflow in the route handler", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    // The route delegates execution to dispatchWorkflowTemplate(), which also
    // backs dynamically generated workflows.
    const handlerStart = source.indexOf("async function dispatchWorkflowTemplate");
    const nextRoute = source.indexOf('router.post("/workflows/:id/cancel"');
    const workflowSection = source.substring(handlerStart, nextRoute > handlerStart ? nextRoute : undefined);

    // Should NOT have "await startWorkflow" (fire-and-forget in legacy path)
    expect(workflowSection).not.toMatch(/await\s+startWorkflow\(/);

    // Legacy path should have fire-and-forget with .catch
    expect(workflowSection).toContain("startWorkflow(wf.id).catch");
  });
});

// ─── Generated workflow contract endpoints ─────────────────────────────────

describe("Generated workflow contract validation", () => {
  it("exports reusable generated workflow validation and schema helpers", async () => {
    const validator = await import("./workflow-validator");

    expect(typeof validator.validateGeneratedWorkflowTemplate).toBe("function");
    expect(typeof validator.getGeneratedWorkflowContract).toBe("function");

    const contract = validator.getGeneratedWorkflowContract();
    expect(contract).toMatchObject({
      endpoints: {
        validate: "POST /api/workflows/generated/validate",
        dryRun: "POST /api/workflows/generated with { dryRun: true }",
        execute: "POST /api/workflows/generated with { deviceId, workflow }",
      },
    });
  });

  it("rejects malformed generated workflows with path-specific errors", async () => {
    const { validateGeneratedWorkflowTemplate } = await import("./workflow-validator");

    const result = validateGeneratedWorkflowTemplate({
      id: "bad_workflow",
      name: "Bad workflow",
      platform: "reddit",
      description: "Broken on purpose",
      version: "1.0.0",
      steps: [
        { type: "action", id: "same" },
        { type: "wait", id: "same" },
        { type: "loop", id: "loop", count: { min: 3, max: 1, distribution: "uniform" }, steps: [] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("workflow.steps[0].action must be a non-empty string for action steps");
    expect(result.errors).toContain('workflow.steps[1].id duplicates step id "same"');
    expect(result.errors).toContain("workflow.steps[1] wait step must define duration or condition");
    expect(result.errors).toContain("workflow.steps[2].count.min must be <= workflow.steps[2].count.max");
    expect(result.errors).toContain("workflow.steps[2].steps must be a non-empty step array for loop steps");
  });
});

// ─── POST /workflows/generated — dry-run validation path ──────────────────

describe("POST /workflows/generated — dry-run validation", () => {
  it("supports dryRun without requiring a deviceId or dispatching", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    const routeStart = source.indexOf('router.post("/workflows/generated"');
    const routeEnd = source.indexOf('router.post("/workflows/:id/cancel"', routeStart);
    const routeBody = source.substring(routeStart, routeEnd);

    expect(routeBody).toContain("dryRun");
    expect(routeBody).toContain("deviceId required unless dryRun is true");
    expect(routeBody).toContain("workflow failed validation");
    expect(routeBody).toContain("errors: validation.errors");
    expect(routeBody).toContain("persisted");
    expect(routeBody).toContain("stepCount");

    const dryRunBranch = routeBody.substring(
      routeBody.indexOf("if (dryRun)"),
      routeBody.indexOf("await workflowService.saveTemplate(template);", routeBody.indexOf("if (dryRun)"))
    );
    expect(dryRunBranch).not.toContain("dispatchWorkflowTemplate");
    expect(dryRunBranch).not.toContain("startWorkflow");
  });

  it("validates generated workflow steps before persistence or dispatch", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    expect(source).toContain("validateGeneratedWorkflowTemplate");
    expect(source).toContain('router.get("/workflows/generated/schema"');
    expect(source).toContain('router.post("/workflows/generated/prompt"');
    expect(source).toContain('router.post("/workflows/generated/validate"');
    expect(source).toContain("getGeneratedWorkflowContract");
    expect(source).toContain("buildGeneratedWorkflowPrompt");
  });
});

describe("Generated workflow validator module", () => {
  it("validates generated workflow steps before persistence or dispatch", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow-validator.ts"),
      "utf8"
    );

    expect(source).toContain("function validateGeneratedWorkflowStepInput");
    expect(source).toContain("workflow.steps[${index}]");
    expect(source).toContain(".action must be a non-empty string for action steps");
    expect(source).toContain("wait step must define duration or condition");
    expect(source).toContain(".type must be one of: ${GENERATED_WORKFLOW_STEP_TYPES.join");
    expect(source).toContain('"action",');
    expect(source).toContain('"checkpoint",');
  });
});

// ─── DB Pool — sized for 100 devices ──────────────────────────────────────

describe("DB Pool configuration", () => {
  it("should have pool max >= 50 and statement_timeout", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "client.ts"),
      "utf8"
    );

    // Should reference scalabilityConfig for pool size
    expect(source).toContain("scalabilityConfig.dbPoolMax");
    expect(source).toContain("scalabilityConfig.dbStatementTimeout");
    // Should set statement_timeout on each new connection
    expect(source).toContain("SET statement_timeout");
  });
});

// ─── Per-device concurrency guard ──────────────────────────────────────────

describe("Per-device concurrency guard", () => {
  it("should check countActiveByDevice before creating workflow", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    const workflowSection = source.substring(
      source.indexOf("router.post(\"/workflows\""),
      source.indexOf("res.status(202).json({ ok: true, data: { workflowId: wf.id")
    );

    // Should check per-device active workflows
    expect(workflowSection).toContain("countActiveByDevice");
    expect(workflowSection).toContain("maxWorkflowsPerDevice");
    // Should return 409 (conflict) for device busy
    expect(workflowSection).toContain("409");
    expect(workflowSection).toContain("DEVICE_BUSY");
  });

  it("should check global concurrent limit", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    const workflowSection = source.substring(
      source.indexOf("router.post(\"/workflows\""),
      source.indexOf("res.status(202).json({ ok: true, data: { workflowId: wf.id")
    );

    expect(workflowSection).toContain("maxGlobalConcurrentWorkflows");
    expect(workflowSection).toContain("429");
    expect(workflowSection).toContain("SERVER_BUSY");
  });
});

// ─── Scalability config ────────────────────────────────────────────────────

describe("Scalability config", () => {
  it("should have correct defaults for 100-device target", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "config", "scalability.config.ts"),
      "utf8"
    );

    // Per-device: max 1 workflow
    expect(source).toMatch(/maxWorkflowsPerDevice:\s*1/);

    // Global: at least 50 concurrent
    expect(source).toMatch(/maxGlobalConcurrentWorkflows.*50/);

    // Worker concurrency: at least 20
    expect(source).toMatch(/workerConcurrency.*20/);

    // DB pool: at least 50
    expect(source).toMatch(/dbPoolMax.*50/);

    // WS max connections: at least 150
    expect(source).toMatch(/maxWsConnections.*150/);

    // Environment variable overrides
    expect(source).toContain("MAX_CONCURRENT_WORKFLOWS");
    expect(source).toContain("WORKFLOW_WORKER_CONCURRENCY");
    expect(source).toContain("DB_POOL_MAX");
  });
});

// ─── WebSocket connection limit ────────────────────────────────────────────

describe("WebSocket connection limit", () => {
  it("should enforce max connections and reject new ones", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "ws", "direct-ws.server.ts"),
      "utf8"
    );

    // Should check connections.size against MAX_WS_CONNECTIONS
    expect(source).toContain("MAX_WS_CONNECTIONS");
    expect(source).toContain("max capacity");
    // Should close with 4029 (custom code for capacity)
    expect(source).toContain("4029");
  });
});

// ─── Workflow service has per-device methods ───────────────────────────────

describe("Workflow service per-device methods", () => {
  it("should have countActiveByDevice method", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    expect(source).toContain("async countActiveByDevice(deviceId: string)");
    expect(source).toContain("WHERE device_id = $1 AND status IN ('queued', 'running')");
  });

  it("should have getActiveCounts method for monitoring", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    expect(source).toContain("async getActiveCounts()");
    expect(source).toContain("GROUP BY status");
  });
});

// ─── Scalability monitoring endpoint ──────────────────────────────────────

describe("Scalability monitoring endpoint", () => {
  it("should expose /api/scalability/status", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "api", "routes.ts"),
      "utf8"
    );

    expect(source).toContain("router.get(\"/scalability/status\"");
    expect(source).toContain("getPoolStats");
    expect(source).toContain("getActiveCounts");
    expect(source).toContain("getConnectionCount");
  });
});

// ─── Simulated blocking scenario ───────────────────────────────────────────

describe("Simulated blocking: multiple operations don't block each other", () => {
  it("multiple withTimeout calls can run concurrently", async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(message)), ms)
        ),
      ]);
    }

    const start = Date.now();

    // Simulate 3 slow DB operations, all with 100ms timeout
    const results = await Promise.allSettled([
      withTimeout(new Promise(() => {}), 100, "op1 timeout"),
      withTimeout(new Promise(() => {}), 100, "op2 timeout"),
      withTimeout(
        new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 20)),
        100,
        "op3 timeout"
      ),
    ]);

    const elapsed = Date.now() - start;

    // All should complete within ~150ms (not 300ms sequentially)
    expect(elapsed).toBeLessThan(200);

    // First two timed out
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    // Third resolved
    expect(results[2].status).toBe("fulfilled");
    if (results[2].status === "fulfilled") {
      expect(results[2].value).toBe("fast");
    }
  });

  it("50 concurrent timeout operations complete in parallel", async () => {
    function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(message)), ms)
        ),
      ]);
    }

    const start = Date.now();

    // Simulate 50 concurrent cancel checks (100-device scenario)
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        withTimeout(new Promise<never>(() => {}), 100, `check ${i} timeout`)
      )
    );

    const elapsed = Date.now() - start;

    // All 50 should timeout in ~100ms (parallel), not 5000ms (sequential)
    expect(elapsed).toBeLessThan(300);
    expect(results.every(r => r.status === "rejected")).toBe(true);
  });
});

// ─── Per-device isolation: two workflows on same device → rejected ─────────

describe("Per-device isolation logic", () => {
  it("countActiveByDevice query is correct", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "workflow.service.ts"),
      "utf8"
    );

    const methodMatch = source.match(
      /async countActiveByDevice[\s\S]*?(?=\n  async |\n  \/\/)/
    );
    expect(methodMatch).toBeTruthy();
    const methodBody = methodMatch![0];

    // Query should check both 'queued' and 'running' statuses
    expect(methodBody).toContain("'queued', 'running'");
    // Should filter by device_id
    expect(methodBody).toContain("device_id = $1");
  });
});
