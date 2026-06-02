import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const TASK_ID = "55555555-5555-4555-8555-555555555555";
const INTENT = "Open Reddit and collect an account health screenshot";

const mocks = vi.hoisted(() => ({
  db: {
    connect: vi.fn(),
    query: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  workflowService: {
    getGeneratedPlanCacheByRequestKey: vi.fn(),
    saveTemplate: vi.fn(),
    saveGeneratedPlanCache: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
  getPoolStats: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0, maxCount: 50 })),
}));

vi.mock("../modules/workflows/workflow.service", () => ({
  workflowService: mocks.workflowService,
}));

vi.mock("../ws/direct-ws.server", () => ({
  directWsServer: {
    getConnectedDeviceIds: vi.fn(() => []),
    getAgentVersion: vi.fn(() => null),
    supportsEdgeExecution: vi.fn(() => false),
    getConnectionCount: vi.fn(() => 0),
  },
}));

function requestKey(intent = INTENT): string {
  return crypto.createHash("sha256").update(`${DEVICE_ID}:${ACCOUNT_ID}:${intent}`).digest("hex").slice(0, 24);
}

function cacheKey(intent = INTENT): string {
  return crypto.createHash("sha256").update(`cache:${requestKey(intent)}`).digest("hex").slice(0, 24);
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function cachedPlan(overrides: Record<string, unknown> = {}) {
  const key = requestKey();
  const ck = cacheKey();
  return {
    cacheKey: ck,
    requestKey: key,
    canonicalWorkflowId: "dashboard_human_reddit_preview_v1",
    canonicalWorkflowVersion: "1.0.0",
    compiledPlanHash: "a".repeat(64),
    workflow: {
      id: "dashboard_human_reddit_preview_v1",
      version: "1.0.0",
      platform: "reddit",
      safetyClass: "read_only",
      intent: INTENT,
      steps: [
        { id: "open", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
        { id: "shot", type: "action", action: "screenshot", params: { quality: 80 } },
      ],
    },
    compiledPlan: {
      cacheKey: ck,
      metadata: {
        safetyClass: "read_only",
        intent: INTENT,
      },
      llmBudget: {
        happyPathRequests: 0,
        recoveryRequests: "only_on_failure",
      },
      steps: [
        { id: "open", type: "action", action: "open_app", path: ["open"], selectorName: null, selectorId: null },
        { id: "shot", type: "action", action: "screenshot", path: ["shot"], selectorName: null, selectorId: null },
      ],
    },
    ...overrides,
  };
}

function cachedPlanRow(overrides: Record<string, unknown> = {}) {
  const cached = cachedPlan(overrides);
  return {
    cache_key: cached.cacheKey,
    request_key: cached.requestKey,
    canonical_workflow_id: cached.canonicalWorkflowId,
    canonical_workflow_version: cached.canonicalWorkflowVersion,
    compiled_plan_hash: cached.compiledPlanHash,
    workflow: cached.workflow,
    compiled_plan: cached.compiledPlan,
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    device_id: DEVICE_ID,
    device_model: "Pixel 7",
    device_name: "Pixel Lab",
    account_id: ACCOUNT_ID,
    account_username: "reddit_user",
    account_platform: "reddit",
    account_device_id: DEVICE_ID,
    client_id: CLIENT_ID,
    ...overrides,
  };
}

async function app() {
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import("./routes");
  app.use("/api", apiRouter);
  return app;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-api-key": "test-api-key" }
): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        const json = await response.json();
        listener.close();
        resolve({ status: response.status, body: json });
      } catch (err) {
        listener.close(() => reject(err));
      }
    });
  });
}

describe("dashboard human workflow routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.API_KEY = "test-api-key";
    process.env.JWT_SECRET = "test-jwt-secret";
    mocks.db.connect.mockResolvedValue(mocks.client);
    mocks.db.query.mockResolvedValue({ rows: [targetRow()] });
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cachedPlan());
  });

  it("compiles a valid cached human workflow preview", async () => {
    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(),
      cacheHit: true,
      cacheKey: cacheKey(),
      safetyClass: "read_only",
      platform: "reddit",
      target: {
        device_id: DEVICE_ID,
        account_id: ACCOUNT_ID,
        account_username: "reddit_user",
      },
    });
    expect(response.body.data.plan.actions).toHaveLength(2);
  });

  it("rejects tap/type/swipe steps despite read_only metadata", async () => {
    const base = cachedPlan();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce({
      ...base,
      workflow: {
        ...base.workflow,
        safetyClass: "read_only",
      },
      compiledPlan: {
        ...base.compiledPlan,
        metadata: { ...base.compiledPlan.metadata, safetyClass: "read_only" },
        steps: [
          { id: "tap-screen", type: "action", action: "tap", params: { x: 540, y: 960 } },
          { id: "type-text", type: "action", action: "type", params: { text: "hello" } },
          { id: "swipe-up", type: "action", action: "swipe", params: { distancePx: 400 } },
        ],
      },
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_APPROVAL_REQUIRED",
    });
  });

  it("rejects compile when the account is bound to another device", async () => {
    mocks.db.query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain("LEFT JOIN accounts");
      return { rows: [targetRow({ account_device_id: "66666666-6666-4666-8666-666666666666" })] };
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "ACCOUNT_DEVICE_MISMATCH",
    });
  });

  it("rejects social or account-changing human intents before compile", async () => {
    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: "Post a comment and follow the first Reddit account",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_SOCIAL_ACCOUNT_CHANGE_NOT_ALLOWED",
    });
  });

  it("rejects destructive cached plans during compile preview", async () => {
    const base = cachedPlan();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce({
      ...base,
      workflow: {
        ...base.workflow,
        safetyClass: "standard",
      },
      compiledPlan: {
        ...base.compiledPlan,
        metadata: { ...base.compiledPlan.metadata, safetyClass: "standard" },
        steps: [{ id: "reboot", type: "action", action: "reboot", path: ["reboot"] }],
      },
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_DESTRUCTIVE_NOT_ALLOWED",
    });
  });

  it("rejects low-level social mutation plans before run dispatch", async () => {
    const base = cachedPlan();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce({
      ...base,
      workflow: {
        ...base.workflow,
        safetyClass: "standard",
        steps: [
          { id: "tap-comment", type: "action", action: "tap", params: { selectorName: "comment_box" } },
          { id: "type-reply", type: "action", action: "type", params: { text: "Thanks for sharing" } },
          { id: "submit", type: "action", action: "tap", params: { selectorName: "post_button" } },
        ],
      },
      compiledPlan: {
        ...base.compiledPlan,
        metadata: { ...base.compiledPlan.metadata, safetyClass: null },
        steps: [
          { id: "tap-comment", type: "action", action: "tap", path: ["comment_box"], selectorName: "comment_box", selectorId: null },
          { id: "type-reply", type: "action", action: "type", path: ["comment_box"], selectorName: "comment_box", selectorId: null },
          { id: "submit", type: "action", action: "tap", path: ["post_button"], selectorName: "post_button", selectorId: null },
        ],
      },
    });

    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_SOCIAL_ACCOUNT_CHANGE_NOT_ALLOWED",
    });
    expect(mocks.db.connect).not.toHaveBeenCalled();
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tasks"))).toBe(false);
  });

  it("rejects standard low-level plans without explicit approval", async () => {
    const base = cachedPlan();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce({
      ...base,
      workflow: {
        ...base.workflow,
        safetyClass: "standard",
        steps: [{ id: "tap-settings", type: "action", action: "tap", params: { selectorName: "settings_button" } }],
      },
      compiledPlan: {
        ...base.compiledPlan,
        metadata: { ...base.compiledPlan.metadata, safetyClass: null },
        steps: [{ id: "tap-settings", type: "action", action: "tap", path: ["settings"], selectorName: "settings_button", selectorId: null }],
      },
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_APPROVAL_REQUIRED",
    });
  });

  it("rejects write actions even when compiled metadata claims read-only safety", async () => {
    const base = cachedPlan();
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce({
      ...base,
      workflow: {
        ...base.workflow,
        safetyClass: "read_only",
        steps: [
          { id: "tap-search", type: "action", action: "tap", params: { selectorName: "search_box" } },
          { id: "type-query", type: "action", action: "type", params: { text: "account health" } },
          { id: "swipe-feed", type: "action", action: "swipe", params: { direction: "up" } },
        ],
      },
      compiledPlan: {
        ...base.compiledPlan,
        metadata: { ...base.compiledPlan.metadata, safetyClass: "read_only" },
        steps: [
          { id: "tap-search", type: "action", action: "tap", path: ["search"], selectorName: "search_box", selectorId: null },
          { id: "type-query", type: "action", action: "type", path: ["search"], selectorName: "search_box", selectorId: null },
          { id: "swipe-feed", type: "action", action: "swipe", path: ["feed"], selectorName: "feed", selectorId: null },
        ],
      },
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "HUMAN_WORKFLOW_APPROVAL_REQUIRED",
    });
  });

  it("queues a run through the generated agency workflow task pipeline", async () => {
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cachedPlanRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: RUN_ID,
      status: "queued",
      taskId: TASK_ID,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    });

    const taskInsert = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO tasks"));
    expect(taskInsert).toBeDefined();
    expect(taskInsert?.[1][2]).toBe(JSON.stringify({
      requestKey: requestKey(),
      clientId: CLIENT_ID,
      agencyWorkflowRunId: RUN_ID,
      workflowRunId: RUN_ID,
      intent: INTENT,
      source: "dashboard_human",
    }));

    const runInsert = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO agency_workflow_runs"));
    expect(runInsert?.[1]).toEqual([
      CLIENT_ID,
      ACCOUNT_ID,
      DEVICE_ID,
      "reddit",
      INTENT,
      "read_only",
      requestKey(),
      "dashboard_human_reddit_preview_v1",
      "1.0.0",
      "a".repeat(64),
      expect.any(String),
    ]);
  });

  it("reuses an existing dashboard human run and task for identical request keys", async () => {
    let existingRun: { id: string; task_id: string | null; status: string } | null = null;
    let runInserts = 0;
    let taskInserts = 0;
    mocks.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("generated_workflow_plan_cache")) return { rows: [cachedPlanRow()] };
      if (sql.includes("FROM agency_workflow_runs")) return { rows: existingRun ? [existingRun] : [] };
      if (sql.includes("INSERT INTO agency_workflow_runs")) {
        runInserts += 1;
        existingRun = { id: RUN_ID, task_id: null, status: "queued" };
        return { rows: [{ id: RUN_ID }] };
      }
      if (sql.includes("INSERT INTO tasks")) {
        taskInserts += 1;
        return { rows: [{ id: TASK_ID }] };
      }
      if (sql.includes("UPDATE agency_workflow_runs")) {
        if (existingRun) existingRun = { ...existingRun, task_id: params?.[0] as string };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const body = {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    };
    const first = await postJson("/api/workflows/human/run", body);
    const second = await postJson("/api/workflows/human/run", body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data).toMatchObject({
      id: RUN_ID,
      status: "queued",
      taskId: TASK_ID,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    });
    expect(second.body.data).toMatchObject(first.body.data);
    expect(runInserts).toBe(1);
    expect(taskInserts).toBe(1);
    expect(mocks.client.query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_xact_lock"))).toHaveLength(2);
  });

  it("rejects run when requestKey does not match device, account and intent", async () => {
    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: "f".repeat(24),
      cacheKey: cacheKey(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "REQUEST_KEY_MISMATCH",
    });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("rejects run when cacheKey does not match the compiled preview", async () => {
    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      cacheKey: "f".repeat(24),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      code: "CACHE_KEY_MISMATCH",
    });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("denies monitoring tokens on the admin-only human workflow compile and run endpoints", async () => {
    mocks.db.query.mockImplementation(async (_sql: string, params: string[]) => {
      expect(params).toEqual([tokenHash("agent-token")]);
      return {
        rows: [{
          id: "token-openclaw",
          purpose: "openclaw_agent",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
        }],
      };
    });

    const compile = await postJson(
      "/api/workflows/human/compile",
      {
        device_id: DEVICE_ID,
        account_id: ACCOUNT_ID,
        intent: INTENT,
      },
      { authorization: "Bearer agent-token" }
    );
    const response = await postJson(
      "/api/workflows/human/run",
      {
        device_id: DEVICE_ID,
        account_id: ACCOUNT_ID,
        intent: INTENT,
      },
      { authorization: "Bearer agent-token" }
    );

    expect(compile.status).toBe(401);
    expect(compile.body).toEqual({ ok: false, error: "Unauthorized" });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unauthorized" });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });
});
