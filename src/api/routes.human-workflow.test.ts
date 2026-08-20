import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const TASK_ID = "55555555-5555-4555-8555-555555555555";
const COMPILE_JOB_ID = "66666666-6666-4666-8666-666666666666";
const INTENT = "Open Reddit and collect an account health screenshot";
const SAFE_TIMEOUT_INTENT = "derulează feed-ul Instagram și fă un screenshot";
const OPEN_INSTAGRAM_INTENT = "deschide Instagram";
const REDDIT_COMMENT_INTENT = "deschide app reddit, intra pe prima postare si apasa butonul de comment sa comentezi";
const REDDIT_FIRST_POST_COMMENTS_INTENT = "intra pe reddit si apasa pe butonul de comantarii de prima postare";
const REDDIT_FIRST_POST_COMMENT_BUTTON_INTENT = "pe reddit, apasa butonul de comment la prima postare care apare in app";
const ASKREDDIT_HOT_INTENT = "Read the first post on AskReddit, sorted by hottest";
const ASKREDDIT_RO_INTENT = "citeste primul post de pe AskReddit";

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
  llmJson: vi.fn(),
  loadMap: vi.fn(),
  shortcutRegistryService: {
    lookupActiveShortcut: vi.fn(),
    recordHit: vi.fn(),
    recordRunResult: vi.fn(),
  },
  compileJobService: {
    createOrGet: vi.fn(),
    getById: vi.fn(),
    getByRequestKey: vi.fn(),
    runInProcess: vi.fn(),
  },
}));

vi.mock("../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
  getPoolStats: vi.fn(() => ({ totalCount: 1, idleCount: 1, waitingCount: 0, maxCount: 50 })),
}));

vi.mock("../modules/workflows/workflow.service", () => ({
  workflowService: mocks.workflowService,
}));

vi.mock("../modules/app-mapping/recorder.service", () => ({
  loadMap: mocks.loadMap,
}));

vi.mock("../utils/llm", () => ({
  llmJson: mocks.llmJson,
}));

vi.mock("../modules/workflow-shortcuts/shortcut-registry.service", () => ({
  shortcutRegistryService: mocks.shortcutRegistryService,
}));

vi.mock("../modules/human-workflow/compile-job.service", () => ({
  humanWorkflowCompileJobService: mocks.compileJobService,
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

function shortcutRecord(key: string, workflowTemplate: Record<string, unknown>) {
  return {
    shortcut: {
      id: "77777777-7777-4777-8777-777777777777",
      key,
      workflowTemplate,
    },
    normalizedIntent: "",
    matchedPattern: null,
  };
}

function redditFirstPostCommentsTemplate() {
  return {
    id: "dashboard_human_reddit_first_post_comments_v1",
    name: "Reddit first post comments opener",
    platform: "reddit",
    description: "Open Reddit and tap the comments button on the first visible post.",
    version: "1.0.0",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps: [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
      { id: "unlock_device", type: "action", action: "unlock", params: {} },
      { id: "open_reddit", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
      { id: "settle_feed", type: "action", action: "wait_for_idle", params: { timeoutMs: 3000 } },
      { id: "tap_first_post_comments", type: "action", action: "a11y_find_tap", params: { resourceId: "com.reddit.frontpage:id/comments_stub", partialMatch: false } },
      { id: "settle_comments", type: "action", action: "wait_for_idle", params: { timeoutMs: 2000 } },
      { id: "comments_opened", type: "checkpoint", reason: "Reddit first visible post comments opened from dashboard human workflow" },
    ],
  };
}

function askRedditTemplate() {
  return {
    id: "dashboard_human_reddit_askreddit_hot_first_item_v1",
    name: "AskReddit hot first item reader",
    platform: "reddit",
    description: "Open r/AskReddit hot feed and capture the first visible item for dashboard review.",
    version: "1.0.0",
    defaultVerificationStrategy: "local_with_screenshot",
    dataRetentionDays: 7,
    steps: [
      { id: "open_askreddit_hot", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage", uri: "https://www.reddit.com/r/AskReddit/hot/" } },
      { id: "wait_for_reddit", type: "wait", condition: "app_launched", timeoutMs: 10000 },
      { id: "settle_hot_feed", type: "action", action: "wait_for_idle", params: { timeoutMs: 3000 } },
      { id: "capture_visible_state", type: "action", action: "get_screen_state", params: { scope: "askreddit_hot_first_visible_item" } },
      { id: "dump_visible_content", type: "action", action: "ui_tree_dump", params: { scope: "askreddit_hot_first_visible_item" } },
      { id: "capture_visible_item", type: "action", action: "screenshot", params: { quality: 85 } },
      { id: "visible_item_ready", type: "checkpoint", reason: "AskReddit hot first visible item captured for reading" },
    ],
  };
}

function openAppTemplate(platform = "instagram", packageName = "com.instagram.android") {
  return {
    id: `dashboard_human_${platform}_open_app_v1`,
    name: `Open ${platform} app`,
    platform,
    description: `Open the ${platform} app and wait briefly for the first screen to settle.`,
    version: "1.0.0",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps: [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
      { id: "unlock_device", type: "action", action: "unlock", params: {} },
      { id: "open_app", type: "action", action: "open_app", params: { packageName } },
      { id: "settle_app", type: "action", action: "wait_for_idle", params: { timeoutMs: 2000 } },
      { id: "app_opened", type: "checkpoint", reason: `${platform} opened from dashboard human workflow` },
    ],
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

function openAppShortcutTemplate(platform = "instagram", packageName = "com.instagram.android") {
  return {
    id: `dashboard_human_${platform}_open_app_v1`,
    name: `Open ${platform} app`,
    platform,
    description: `Open the ${platform} app and wait briefly for the first screen to settle.`,
    version: "1.0.0",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps: [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
      { id: "unlock_device", type: "action", action: "unlock", params: {} },
      { id: "open_app", type: "action", action: "open_app", params: { packageName } },
      { id: "settle_app", type: "action", action: "wait_for_idle", params: { timeoutMs: 2000 } },
    ],
  };
}

function askRedditShortcutTemplate() {
  return {
    id: "dashboard_human_reddit_askreddit_hot_first_item_v1",
    name: "AskReddit hot first item reader",
    platform: "reddit",
    description: "Open r/AskReddit hot feed and capture the first visible item for dashboard review.",
    version: "1.0.0",
    defaultVerificationStrategy: "local_with_screenshot",
    dataRetentionDays: 7,
    steps: [
      { id: "open_askreddit_hot", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage", uri: "https://www.reddit.com/r/AskReddit/hot/" } },
      { id: "settle_hot_feed", type: "action", action: "wait_for_idle", params: { timeoutMs: 3000 } },
      { id: "capture_visible_state", type: "action", action: "get_screen_state", params: { scope: "askreddit_hot_first_visible_item" } },
      { id: "dump_visible_content", type: "action", action: "ui_tree_dump", params: { scope: "askreddit_hot_first_visible_item" } },
      { id: "capture_visible_item", type: "action", action: "screenshot", params: { quality: 85 } },
    ],
  };
}

function redditCommentsShortcutTemplate() {
  return {
    id: "dashboard_human_reddit_first_post_comments_v1",
    name: "Reddit first post comments opener",
    platform: "reddit",
    description: "Open Reddit and tap the comments button on the first visible post.",
    version: "1.0.0",
    defaultVerificationStrategy: "local_only",
    dataRetentionDays: 7,
    steps: [
      { id: "wake_screen", type: "action", action: "screen_wake", params: {} },
      { id: "unlock_device", type: "action", action: "unlock", params: {} },
      { id: "open_reddit", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
      { id: "settle_feed", type: "action", action: "wait_for_idle", params: { timeoutMs: 3000 } },
      { id: "tap_first_post_comments", type: "action", action: "a11y_find_tap", params: { resourceId: "com.reddit.frontpage:id/comments_stub", partialMatch: false } },
      { id: "settle_comments", type: "action", action: "wait_for_idle", params: { timeoutMs: 2000 } },
    ],
  };
}

function shortcutMatch(key: string, workflowTemplate: Record<string, unknown>) {
  return {
    shortcut: {
      id: `shortcut-${key}`,
      key,
      platform: workflowTemplate.platform,
      name: workflowTemplate.name,
      description: workflowTemplate.description,
      status: "active",
      priority: 10,
      intentPatterns: [],
      aliases: [],
      matchConfig: {},
      workflowTemplate,
      compatibility: {},
      metadata: {},
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
    },
    normalizedIntent: "",
    matchedPattern: null,
  };
}

function readyCompilePayload(intent = INTENT) {
  const cached = cachedPlan();
  return {
    status: "ready",
    requestKey: requestKey(intent),
    cacheHit: false,
    cacheKey: cacheKey(),
    source: "llm",
    plan: {
      templateId: cached.workflow.id,
      version: cached.workflow.version,
      steps: cached.workflow.steps,
      actions: cached.compiledPlan.steps,
      compiledPlan: cached.compiledPlan,
    },
    safetyClass: "read_only",
    platform: "reddit",
    target: {
      device_id: DEVICE_ID,
      device_model: "Pixel 7",
      device_name: "Pixel Lab",
      account_id: ACCOUNT_ID,
      account_username: "reddit_user",
      account_platform: "reddit",
      client_id: CLIENT_ID,
    },
    llmBudget: cached.compiledPlan.llmBudget,
  };
}

function compileJobRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPILE_JOB_ID,
    requestKey: requestKey(),
    deviceId: DEVICE_ID,
    accountId: ACCOUNT_ID,
    intent: INTENT,
    platform: "reddit",
    status: "queued",
    cacheKey: null,
    source: "llm",
    shortcutId: null,
    error: null,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

async function app() {
  const app = express();
  app.use(express.json());
  const imported = await import("./routes");
  const apiRouter = imported.default ?? (imported as unknown as { default: express.Router }).default;
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

async function getJson(
  path: string,
  headers: Record<string, string> = { "x-api-key": "test-api-key" }
): Promise<{ status: number; body: any }> {
  const server = await app();
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, async () => {
      try {
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("no address");
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "GET",
          headers,
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
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
    mocks.db.connect.mockResolvedValue(mocks.client);
    mocks.db.query.mockResolvedValue({ rows: [targetRow()] });
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(cachedPlan());
    mocks.workflowService.saveTemplate.mockResolvedValue(undefined);
    mocks.workflowService.saveGeneratedPlanCache.mockResolvedValue(undefined);
    mocks.loadMap.mockResolvedValue(null);
    mocks.llmJson.mockResolvedValue(cachedPlan().workflow);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValue(null);
    mocks.shortcutRegistryService.recordHit.mockResolvedValue(undefined);
    mocks.shortcutRegistryService.recordRunResult.mockResolvedValue(undefined);
    mocks.compileJobService.getByRequestKey.mockResolvedValue(null);
    mocks.compileJobService.createOrGet.mockResolvedValue(compileJobRecord({ requestKey: requestKey(SAFE_TIMEOUT_INTENT), intent: SAFE_TIMEOUT_INTENT }));
    mocks.compileJobService.getById.mockResolvedValue(null);
    mocks.compileJobService.runInProcess.mockImplementation(() => undefined);
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
  }, 10_000);

  it("allows tap/type/swipe steps during temporary no-safety mode", async () => {
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

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("requestKey", requestKey());
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

  it("allows social or account-changing human intents through the temporary no-safety compile gate", async () => {
    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: "Post a comment and follow the first Reddit account",
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      safetyClass: "read_only",
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
  });

  it.each([
    ["postează o poză pe Instagram"],
    ["comentează pe posturile de azi"],
    ["urmărește 10 persoane"],
    ["dezurmărește contul acesta"],
    ["schimbă parola contului"],
    ["cumpără ceva de pe site"],
    ["șterge contul de Instagram"],
    ["dezactivează contul"],
    ["trimite un mesaj"],
    ["posteaza o poza pe Instagram"],
    ["comenteaza pe posturile de azi"],
    ["urmareste 10 persoane"],
    ["dezurmareste contul acesta"],
    ["schimba parola contului"],
    ["cumpara ceva de pe site"],
    ["sterge contul de Instagram"],
    ["dezactiveaza contul"],
    ["trimite mesaj"],
  ])("allows Romanian social/account-changing intents through the temporary no-safety compile gate: %s", async (intent) => {
    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      safetyClass: "read_only",
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
  });

  it("compiles the AskReddit hottest first post read shortcut without LLM on cache miss", async () => {
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValueOnce(
      shortcutMatch("askreddit_first_hot_read", askRedditShortcutTemplate()),
    );

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: ASKREDDIT_HOT_INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(ASKREDDIT_HOT_INTENT),
      cacheHit: false,
      safetyClass: "read_only",
      platform: "reddit",
    });
    expect(response.body.data.cacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(response.body.data.plan).toMatchObject({
      templateId: "dashboard_human_reddit_askreddit_hot_first_item_v1",
      version: "1.0.0",
    });
    expect(response.body.data.plan.actions.map((action: { action: string }) => action.action)).toEqual([
      "open_app",
      "wait_for_idle",
      "get_screen_state",
      "ui_tree_dump",
      "screenshot",
    ]);
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.loadMap).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dashboard_human_reddit_askreddit_hot_first_item_v1",
        platform: "reddit",
      }),
    );
    expect(mocks.workflowService.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dashboard_human_reddit_askreddit_hot_first_item_v1" }),
      expect.objectContaining({
        templateId: "dashboard_human_reddit_askreddit_hot_first_item_v1",
        llmBudget: { happyPathRequests: 0, recoveryRequests: "only_on_failure" },
      }),
      requestKey(ASKREDDIT_HOT_INTENT),
      expect.objectContaining({
        artifactState: "promoted",
        sourceMetadata: expect.objectContaining({
          source: "dashboard_human",
          shortcut: "askreddit_first_hot_read",
          intent: ASKREDDIT_HOT_INTENT,
        }),
      }),
    );
  });

  it("compiles a simple Instagram open-app shortcut without LLM on cache miss", async () => {
    mocks.db.query.mockResolvedValueOnce({
      rows: [targetRow({
        account_username: "insta_user",
        account_platform: "instagram",
      })],
    });
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValueOnce(
      shortcutMatch("open_app", openAppShortcutTemplate("instagram", "com.instagram.android")),
    );

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: OPEN_INSTAGRAM_INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(OPEN_INSTAGRAM_INTENT),
      cacheHit: false,
      safetyClass: "read_only",
      platform: "instagram",
    });
    expect(response.body.data.cacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(response.body.data.plan).toMatchObject({
      templateId: "dashboard_human_instagram_open_app_v1",
      version: "1.0.0",
    });
    expect(response.body.data.plan.actions.map((action: { action: string }) => action.action)).toEqual([
      "screen_wake",
      "unlock",
      "open_app",
      "wait_for_idle",
    ]);
    expect(response.body.data.plan.actions[2]).toMatchObject({
      action: "open_app",
    });
    expect(response.body.data.plan.steps[2].params).toMatchObject({
      packageName: "com.instagram.android",
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.loadMap).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dashboard_human_instagram_open_app_v1",
        platform: "instagram",
      }),
    );
    expect(mocks.workflowService.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dashboard_human_instagram_open_app_v1" }),
      expect.objectContaining({
        templateId: "dashboard_human_instagram_open_app_v1",
        llmBudget: { happyPathRequests: 0, recoveryRequests: "only_on_failure" },
      }),
      requestKey(OPEN_INSTAGRAM_INTENT),
      expect.objectContaining({
        artifactState: "promoted",
        sourceMetadata: expect.objectContaining({
          source: "dashboard_human",
          shortcut: "open_app",
          intent: OPEN_INSTAGRAM_INTENT,
        }),
      }),
    );
  });

  it("does not classify multi-step Reddit comment intents as simple open-app shortcuts", async () => {
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.llmJson.mockResolvedValueOnce({
      id: "dashboard_human_reddit_comment_entry_v1",
      name: "Reddit comment entry",
      platform: "reddit",
      description: "Open Reddit, enter the first visible item, and focus the reply entry surface.",
      version: "1.0.0",
      defaultVerificationStrategy: "local_only",
      dataRetentionDays: 7,
      steps: [
        { id: "open_reddit", type: "action", action: "open_app", params: { packageName: "com.reddit.frontpage" } },
        { id: "wait_feed", type: "action", action: "wait_for_idle", params: { timeoutMs: 2000 } },
        { id: "open_first_post", type: "action", action: "tap", params: { selectorName: "first_post" } },
      ],
    });

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: REDDIT_COMMENT_INTENT,
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      status: "compiling",
      requestKey: requestKey(REDDIT_COMMENT_INTENT),
      compileJobId: COMPILE_JOB_ID,
      retryAfterMs: 2000,
      source: "llm",
    });
    expect(mocks.shortcutRegistryService.lookupActiveShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "reddit", intent: REDDIT_COMMENT_INTENT }),
    );
    expect(mocks.llmJson).not.toHaveBeenCalled();
  });

  it("compiles the Romanian Reddit first post comments shortcut without LLM on cache miss", async () => {
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValueOnce(
      shortcutMatch("reddit_first_post_comments", redditCommentsShortcutTemplate()),
    );

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: REDDIT_FIRST_POST_COMMENTS_INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(REDDIT_FIRST_POST_COMMENTS_INTENT),
      cacheHit: false,
      safetyClass: "read_only",
      platform: "reddit",
    });
    expect(response.body.data.cacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(response.body.data.plan).toMatchObject({
      templateId: "dashboard_human_reddit_first_post_comments_v1",
      version: "1.0.0",
    });
    expect(response.body.data.plan.actions.map((action: { action: string }) => action.action)).toEqual([
      "screen_wake",
      "unlock",
      "open_app",
      "wait_for_idle",
      "a11y_find_tap",
      "wait_for_idle",
    ]);
    expect(response.body.data.plan.actions[4]).toMatchObject({
      action: "a11y_find_tap",
      target: null,
      path: "workflow.steps[4]",
    });
    expect(response.body.data.plan.steps[4]).toMatchObject({
      action: "a11y_find_tap",
      params: { resourceId: "com.reddit.frontpage:id/comments_stub", partialMatch: false },
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.loadMap).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dashboard_human_reddit_first_post_comments_v1" }),
      expect.objectContaining({
        templateId: "dashboard_human_reddit_first_post_comments_v1",
        llmBudget: { happyPathRequests: 0, recoveryRequests: "only_on_failure" },
      }),
      requestKey(REDDIT_FIRST_POST_COMMENTS_INTENT),
      expect.objectContaining({
        artifactState: "promoted",
        sourceMetadata: expect.objectContaining({
          source: "dashboard_human",
          shortcut: "reddit_first_post_comments",
          intent: REDDIT_FIRST_POST_COMMENTS_INTENT,
        }),
      }),
    );
  });

  it("compiles Dan's Reddit first-post comment button phrasing without LLM", async () => {
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValueOnce(
      shortcutMatch("reddit_first_post_comments", redditCommentsShortcutTemplate()),
    );

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: REDDIT_FIRST_POST_COMMENT_BUTTON_INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(REDDIT_FIRST_POST_COMMENT_BUTTON_INTENT),
      source: "shortcut",
      cacheHit: false,
      platform: "reddit",
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dashboard_human_reddit_first_post_comments_v1" }),
      expect.any(Object),
      requestKey(REDDIT_FIRST_POST_COMMENT_BUTTON_INTENT),
      expect.objectContaining({
        artifactState: "promoted",
        sourceMetadata: expect.objectContaining({
          source: "dashboard_human",
          shortcut: "reddit_first_post_comments",
          intent: REDDIT_FIRST_POST_COMMENT_BUTTON_INTENT,
        }),
      }),
    );
  });

  it("keeps the Reddit first-post comments shortcut in the DB seed instead of routes.ts", () => {
    const routesSource = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");
    const migrationSource = fs.readFileSync(
      path.join(__dirname, "..", "db", "migrations", "038_human_workflow_shortcuts_async_compile.sql"),
      "utf8",
    );

    expect(routesSource).not.toContain("reddit_first_post_comments");
    expect(migrationSource).toContain("reddit_first_post_comments");
  });

  it("compiles the Romanian AskReddit first post shortcut without LLM on cache miss", async () => {
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    mocks.shortcutRegistryService.lookupActiveShortcut.mockResolvedValueOnce(
      shortcutMatch("askreddit_first_hot_read", askRedditShortcutTemplate()),
    );

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: ASKREDDIT_RO_INTENT,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requestKey: requestKey(ASKREDDIT_RO_INTENT),
      cacheHit: false,
      safetyClass: "read_only",
      platform: "reddit",
    });
    expect(response.body.data.cacheKey).toMatch(/^[a-f0-9]{24}$/);
    expect(response.body.data.plan).toMatchObject({
      templateId: "dashboard_human_reddit_askreddit_hot_first_item_v1",
      version: "1.0.0",
    });
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.loadMap).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dashboard_human_reddit_askreddit_hot_first_item_v1" }),
      expect.any(Object),
      requestKey(ASKREDDIT_RO_INTENT),
      expect.objectContaining({
        artifactState: "promoted",
        sourceMetadata: expect.objectContaining({
          source: "dashboard_human",
          shortcut: "askreddit_first_hot_read",
          intent: ASKREDDIT_RO_INTENT,
        }),
      }),
    );
  });

  it("returns an async compile job on safe cache misses instead of waiting for LLM timeout", async () => {
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "25";
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    mocks.llmJson.mockRejectedValueOnce(timeoutError);

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: SAFE_TIMEOUT_INTENT,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        status: "compiling",
        requestKey: requestKey(SAFE_TIMEOUT_INTENT),
        compileJobId: COMPILE_JOB_ID,
        retryAfterMs: 2000,
        source: "llm",
      },
    });
    expect(mocks.compileJobService.runInProcess).toHaveBeenCalled();
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).not.toHaveBeenCalled();
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
  });

  it("queues safe non-message Romanian intents even when they contain trimite", async () => {
    const intent = "trimite fluxul in jos si fa un screenshot";
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "25";
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    mocks.llmJson.mockRejectedValueOnce(timeoutError);

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        status: "compiling",
        requestKey: requestKey(intent),
        compileJobId: COMPILE_JOB_ID,
        retryAfterMs: 2000,
        source: "llm",
      },
    });
    expect(mocks.compileJobService.runInProcess).toHaveBeenCalled();
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).not.toHaveBeenCalled();
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
  });

  it("does not block on oversized compile timeout env overrides", async () => {
    process.env.REQUEST_TIMEOUT_MS = "30000";
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "60000";
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValueOnce(null);
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    mocks.llmJson.mockRejectedValueOnce(timeoutError);

    const response = await postJson("/api/workflows/human/compile", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: SAFE_TIMEOUT_INTENT,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        status: "compiling",
        requestKey: requestKey(SAFE_TIMEOUT_INTENT),
        compileJobId: COMPILE_JOB_ID,
        retryAfterMs: 2000,
        source: "llm",
      },
    });
    expect(mocks.compileJobService.runInProcess).toHaveBeenCalled();
    expect(mocks.llmJson).not.toHaveBeenCalled();
    expect(mocks.workflowService.saveGeneratedPlanCache).not.toHaveBeenCalled();
    delete process.env.REQUEST_TIMEOUT_MS;
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
  });

  it("returns the same compile job response on safe cache-miss retry", async () => {
    process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS = "25";
    mocks.workflowService.getGeneratedPlanCacheByRequestKey.mockResolvedValue(null);
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    mocks.llmJson.mockRejectedValue(timeoutError);
    const body = {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: SAFE_TIMEOUT_INTENT,
    };

    const first = await postJson("/api/workflows/human/compile", body);
    const second = await postJson("/api/workflows/human/compile", body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body).toMatchObject({
      ok: true,
      data: {
        status: "compiling",
        requestKey: requestKey(SAFE_TIMEOUT_INTENT),
        compileJobId: COMPILE_JOB_ID,
        retryAfterMs: 2000,
        source: "llm",
      },
    });
    expect(second.body).toMatchObject({
      ok: true,
      data: {
        status: "compiling",
        requestKey: requestKey(SAFE_TIMEOUT_INTENT),
        compileJobId: COMPILE_JOB_ID,
        retryAfterMs: 2000,
        source: "llm",
      },
    });
    expect(mocks.compileJobService.runInProcess).toHaveBeenCalledTimes(2);
    expect(mocks.workflowService.saveGeneratedPlanCache).not.toHaveBeenCalled();
    delete process.env.HUMAN_WORKFLOW_COMPILE_TIMEOUT_MS;
  });

  it("returns compact queued compile job status for polling", async () => {
    mocks.compileJobService.getById.mockResolvedValueOnce(compileJobRecord({ status: "running" }));

    const response = await getJson(`/api/workflows/human/compile-jobs/${COMPILE_JOB_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "running",
      requestKey: requestKey(),
      compileJobId: COMPILE_JOB_ID,
      retryAfterMs: 2000,
    });
  });

  it("returns ready compile job payload for polling", async () => {
    mocks.compileJobService.getById.mockResolvedValueOnce(compileJobRecord({
      status: "ready",
      result: readyCompilePayload(),
      cacheKey: cacheKey(),
    }));

    const response = await getJson(`/api/workflows/human/compile-jobs/${COMPILE_JOB_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "ready",
      requestKey: requestKey(),
      compileJobId: COMPILE_JOB_ID,
      cacheKey: cacheKey(),
      safetyClass: "read_only",
    });
  });

  it("returns failed compile job payload with retry guidance", async () => {
    mocks.compileJobService.getById.mockResolvedValueOnce(compileJobRecord({
      status: "failed",
      error: "planner unavailable",
    }));

    const response = await getJson(`/api/workflows/human/compile-jobs/${COMPILE_JOB_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      requestKey: requestKey(),
      compileJobId: COMPILE_JOB_ID,
      error: "planner unavailable",
      retryable: true,
      nextAction: "retry_compile",
    });
  });

  it("rejects run with compileJobId while compile job is not ready", async () => {
    mocks.compileJobService.getById.mockResolvedValueOnce(compileJobRecord({ status: "running" }));

    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      compileJobId: COMPILE_JOB_ID,
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      code: "COMPILE_NOT_READY",
      compileJobId: COMPILE_JOB_ID,
      requestKey: requestKey(),
      nextAction: "poll_compile_job",
    });
    expect(mocks.db.connect).not.toHaveBeenCalled();
  });

  it("queues run with compileJobId when compile job is ready", async () => {
    mocks.compileJobService.getById.mockResolvedValueOnce(compileJobRecord({
      status: "ready",
      result: readyCompilePayload(),
      cacheKey: cacheKey(),
    }));
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cachedPlanRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await postJson("/api/workflows/human/run", {
      device_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      intent: INTENT,
      requestKey: requestKey(),
      compileJobId: COMPILE_JOB_ID,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: RUN_ID,
      status: "queued",
      taskId: TASK_ID,
      requestKey: requestKey(),
      cacheKey: cacheKey(),
    });
  });

  it("allows destructive cached plans through the temporary no-safety compile gate", async () => {
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

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("requestKey", requestKey());
  });

  it("queues low-level social mutation plans during temporary no-safety mode", async () => {
    const base = cachedPlan();
    mocks.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [cachedPlanRow({
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
      })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
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

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: RUN_ID,
      taskId: TASK_ID,
      status: "queued",
    });
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tasks"))).toBe(true);
  });

  it("allows standard low-level plans through the temporary no-safety compile gate", async () => {
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

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("requestKey", requestKey());
  });

  it("allows write actions through the temporary no-safety compile gate even when metadata claims read-only safety", async () => {
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

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty("requestKey", requestKey());
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

  it("queues a dashboard human run for an account without a linked client", async () => {
    mocks.db.query.mockResolvedValueOnce({ rows: [targetRow({ client_id: null })] });
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
    expect(taskInsert?.[1][2]).toBe(JSON.stringify({
      requestKey: requestKey(),
      clientId: null,
      agencyWorkflowRunId: RUN_ID,
      workflowRunId: RUN_ID,
      intent: INTENT,
      source: "dashboard_human",
    }));

    const runInsert = mocks.client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO agency_workflow_runs"));
    expect(runInsert?.[1]).toEqual([
      null,
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

describe("request key determinism", () => {
  it("same input → same key", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    expect(k1).toBe(k2);
  });

  it("different device → different key", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("d:b:c").digest("hex").slice(0, 24);
    expect(k1).not.toBe(k2);
  });

  it("different intent → different key", () => {
    const k1 = crypto.createHash("sha256").update("a:b:c").digest("hex").slice(0, 24);
    const k2 = crypto.createHash("sha256").update("a:b:d").digest("hex").slice(0, 24);
    expect(k1).not.toBe(k2);
  });
});
