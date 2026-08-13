import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  db: {
    connect: vi.fn(),
  },
  safety: {
    reserve: vi.fn(),
  },
  taskRunner: {
    pollNow: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../db/client", () => ({
  getDb: () => mocks.db,
}));

vi.mock("../modules/task-runner", () => ({
  taskRunnerService: mocks.taskRunner,
}));

vi.mock("../modules/workflows/workflow-safety-admission.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../modules/workflows/workflow-safety-admission.service")>(),
  reserveWorkflowSafetyAdmission: mocks.safety.reserve,
}));

import { queueHumanAgencyWorkflowRun } from "./routes";

const deviceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";

function target() {
  return {
    device_id: deviceId,
    device_model: "Pixel",
    device_name: "Fixture",
    account_id: accountId,
    account_username: "fixture",
    account_platform: "com.example.surface",
    client_id: clientId,
  };
}

function cachedArtifact() {
  return {
    cache_key: "0123456789abcdef01234567",
    canonical_workflow_id: "generic_read_only_probe",
    canonical_workflow_version: "1.0.0",
    compiled_plan_hash: "a".repeat(64),
    source_metadata: { safetyClass: "read_only", intent: "open generic surface" },
    workflow: {
      id: "generic_read_only_probe",
      version: "1.0.0",
      platform: "com.example.surface",
      safetyClass: "read_only",
      intent: "open generic surface",
      steps: [{
        id: "observe",
        type: "action",
        action: "ui_tree_dump",
        effect: "observe",
        params: {},
      }],
    },
  };
}

function installQueueMocks() {
  let implicitIdentity = 0;
  let runSequence = 0;
  mocks.db.connect.mockResolvedValue(mocks.client);
  mocks.safety.reserve.mockResolvedValue({
    id: null,
    safetyClass: "read_only",
    policyVersion: "test_v1",
    scopeKey: `${clientId}/${accountId}/${deviceId}`,
    idempotencyKey: "unused",
    consumedUnits: 0,
    replayed: false,
  });
  mocks.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    if (text.includes("SELECT * FROM generated_workflow_plan_cache")) return { rows: [cachedArtifact()] };
    if (text.includes("resolve_resource_runtime_identity")) {
      const explicit = params?.[1];
      return {
        rows: [{
          admitted: true,
          identity: typeof explicit === "string" ? explicit : `implicit-${++implicitIdentity}`,
        }],
      };
    }
    if (text.includes("FROM agency_workflow_runs r")) return { rows: [] };
    if (text.includes("INSERT INTO agency_workflow_runs")) {
      runSequence += 1;
      return { rows: [{ id: `44444444-4444-4444-8444-44444444444${runSequence}`, status: "queued" }] };
    }
    if (text.includes("INSERT INTO tasks")) {
      return { rows: [{ id: `55555555-5555-4555-8555-55555555555${runSequence}` }] };
    }
    if (text.includes("UPDATE agency_workflow_runs SET task_id")) return { rows: [] };
    return { rows: [] };
  });
}

describe("dashboard human workflow run route authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.query.mockReset();
    mocks.client.release.mockReset();
    mocks.db.connect.mockReset();
    mocks.safety.reserve.mockReset();
  });

  it("creates distinct run identities for identical implicit requests", async () => {
    installQueueMocks();
    const input = {
      requestKey: "abcdefabcdefabcdefabcdef",
      cacheKey: "0123456789abcdef01234567",
      target: target(),
      intent: "open generic surface",
    };

    const first = await queueHumanAgencyWorkflowRun(input);
    const second = await queueHumanAgencyWorkflowRun(input);

    expect(first.id).not.toBe(second.id);
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(false);
    const identityCalls = mocks.client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("resolve_resource_runtime_identity")
    );
    expect(identityCalls).toHaveLength(2);
    expect(identityCalls.every(([, params]) => Array.isArray(params) && params[1] === null)).toBe(true);
    const runInserts = mocks.client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO agency_workflow_runs")
    );
    expect(runInserts.map(([, params]) => (params as unknown[])[13])).toEqual(["implicit-1", "implicit-2"]);
  });

  it("replays only an explicit idempotency identity", async () => {
    installQueueMocks();
    const replay = {
      id: "66666666-6666-4666-8666-666666666666",
      task_id: "77777777-7777-4777-8777-777777777777",
      status: "queued",
      cache_key: "0123456789abcdef01234567",
      compiled_plan_hash: "a".repeat(64),
      safety_class: "read_only",
      intent: "open generic surface",
      source: "dashboard_human",
    };
    mocks.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT * FROM generated_workflow_plan_cache")) return { rows: [cachedArtifact()] };
      if (text.includes("resolve_resource_runtime_identity")) {
        return { rows: [{ admitted: true, identity: params?.[1] }] };
      }
      if (text.includes("FROM agency_workflow_runs r")) return { rows: [replay] };
      return { rows: [] };
    });

    const result = await queueHumanAgencyWorkflowRun({
      requestKey: "abcdefabcdefabcdefabcdef",
      cacheKey: "0123456789abcdef01234567",
      target: target(),
      intent: "open generic surface",
      idempotencyKey: "operator-replay-key",
    });

    expect(result).toMatchObject({
      id: replay.id,
      taskId: replay.task_id,
      idempotentReplay: true,
    });
    expect(mocks.client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tasks"))).toBe(false);
  });

  it("preserves non-null account binding across run insert, task insert, and run-task linkage", async () => {
    installQueueMocks();

    const result = await queueHumanAgencyWorkflowRun({
      requestKey: "abcdefabcdefabcdefabcdef",
      cacheKey: "0123456789abcdef01234567",
      target: target(),
      intent: "open generic surface",
    });

    const runInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO agency_workflow_runs")
    );
    const taskInsert = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO tasks")
    );
    const runLink = mocks.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE agency_workflow_runs SET task_id")
    );
    expect(runInsert?.[1]?.[1]).toBe(accountId);
    expect(taskInsert?.[1]?.[0]).toBe(accountId);
    expect(runLink?.[1]).toEqual([result.taskId, result.id]);
  });
});
