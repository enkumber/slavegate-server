import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMap } from "../app-mapping/schema";
import { createWorkflowRun, isAppMapCompleteEnough } from "./workflow-run.service";

const mocks = vi.hoisted(() => ({
  db: {
    query: vi.fn(),
  },
  loadMap: vi.fn(),
  startRecording: vi.fn(),
  compileInstruction: vi.fn(),
  workflowEvents: {
    publish: vi.fn(),
  },
}));

vi.mock("../../db/client", () => ({
  getDb: vi.fn(() => mocks.db),
}));

vi.mock("../app-mapping/recorder.service", () => ({
  loadMap: mocks.loadMap,
  startRecording: mocks.startRecording,
}));

vi.mock("../workflow-compiler/planner.service", () => ({
  compileInstruction: mocks.compileInstruction,
}));

vi.mock("../workflow-events", () => ({
  workflowEvents: mocks.workflowEvents,
}));

const completeMap: AppMap = {
  appId: "com.example.app",
  appName: "Example",
  version: "1.0.0",
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
  pageCount: 1,
  transitionCount: 0,
  pages: {
    page_0: {
      name: "home",
      detection: {
        method: "ui_tree_signature",
        anchors: ["text:Home"],
        signatureHash: "hash-home",
      },
      discoveryOrder: 0,
      elements: {
        button_continue: {
          type: "button",
          bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
          resourceId: "continue",
          text: "Continue",
          contentDescription: "",
          clickable: true,
          leadsTo: "self",
        },
      },
    },
  },
};

const compiledWorkflow = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Compiled",
  source: "tap continue",
  appId: "com.example.app",
  compiledAt: "2026-05-26T00:00:00.000Z",
  appMapVersion: "1.0.0",
  startPage: "page_0",
  maxRecoveryAttempts: 1,
  maxTotalRecoveryAttempts: 10,
  recoveryModel: "model",
  steps: [
    {
      id: "s1",
      action: "tap",
      expectedPage: "page_0",
      expectedPageHash: "hash-home",
      retries: 0,
      retryDelay: 0,
      description: "tap continue",
      target: { elementId: "button_continue", coords: { x: 0.25, y: 0.25 } },
    },
  ],
};

let row: Record<string, unknown>;

function resetDbRow() {
  row = {
    id: "11111111-1111-4111-8111-111111111111",
    instruction: "tap continue",
    app_id: "com.example.app",
    device_id: "device-1",
    status: "accepted",
    discovery_ran: false,
    app_map_version: null,
    compiled_workflow_id: null,
    result: {},
    error: null,
    created_at: new Date("2026-05-26T00:00:00.000Z"),
    updated_at: new Date("2026-05-26T00:00:00.000Z"),
    started_at: null,
    completed_at: null,
  };
}

function setupDbMock() {
  mocks.db.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT 1 FROM compiled_workflows")) {
      return { rows: [{ "?column?": 1 }] };
    }
    if (sql.includes("INSERT INTO workflow_runs")) {
      row = {
        ...row,
        instruction: values[0],
        app_id: values[1],
        device_id: values[2],
      };
      return { rows: [row] };
    }
    if (sql.includes("INSERT INTO tasks")) {
      return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }] };
    }
    if (sql.includes("UPDATE workflow_runs")) {
      row = { ...row, status: values[1], updated_at: new Date("2026-05-26T00:01:00.000Z") };
      if (sql.includes("discovery_ran")) row.discovery_ran = values.find((v) => typeof v === "boolean") ?? row.discovery_ran;
      if (sql.includes("app_map_version")) row.app_map_version = "1.0.0";
      if (sql.includes("compiled_workflow_id")) row.compiled_workflow_id = compiledWorkflow.id;
      if (sql.includes("result =")) {
        const resultValue = values.find((v) => typeof v === "string" && String(v).startsWith("{"));
        row.result = resultValue ? JSON.parse(resultValue as string) : {};
      }
      if (sql.includes("error =")) {
        row.error = values[values.length - 1] ?? null;
      }
      return { rows: [row] };
    }
    return { rows: [] };
  });
}

function setupHappyPath() {
  mocks.loadMap.mockResolvedValue(completeMap);
  mocks.compileInstruction.mockResolvedValue({
    ok: true,
    workflowId: compiledWorkflow.id,
    compiledWorkflow,
    fromCache: false,
  });
}

describe("workflow-run service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbRow();
    setupDbMock();
    setupHappyPath();
  });

  it("rejects missing required fields before persisting a run", async () => {
    const result = await createWorkflowRun({ instruction: "", appId: "app", deviceId: "device" });

    expect(result.httpStatus).toBe(400);
    expect(result.code).toBe("WORKFLOW_RUN_MISSING_FIELDS");
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("uses a complete existing app-map without running discovery", async () => {
    const result = await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.data?.workflowId).toBe(compiledWorkflow.id);
    expect(result.data?.discoveryRan).toBe(false);
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.compileInstruction).toHaveBeenCalledWith({
      appId: "com.example.app",
      instruction: "tap continue",
    });
    expect(result.status).toBe("queued");
    expect(result.httpStatus).toBe(202);
    expect(result.data?.result).toEqual(expect.objectContaining({
      taskId: "99999999-9999-4999-8999-999999999999",
    }));
  });

  it("runs discovery and reloads the persisted app-map when the map is missing", async () => {
    mocks.loadMap
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(completeMap);

    const result = await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(result.ok).toBe(true);
    expect(result.data?.discoveryRan).toBe(true);
    expect(mocks.startRecording).toHaveBeenCalledWith("device-1", "com.example.app");
    expect(mocks.loadMap).toHaveBeenCalledTimes(2);
  });

  it("fails before compilation if discovery does not persist a complete app-map", async () => {
    mocks.loadMap
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...completeMap, pages: {} });

    const result = await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not produce a complete app map");
    expect(mocks.compileInstruction).not.toHaveBeenCalled();
  });

  it("persists compile failures and does not execute", async () => {
    mocks.compileInstruction.mockResolvedValueOnce({ ok: false, error: "bad compile" });

    const result = await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(result.httpStatus).toBe(422);
    expect(result.code).toBe("WORKFLOW_COMPILE_FAILED");
  });

  it("rejects non-persisted compiled workflow IDs before execution", async () => {
    mocks.db.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SELECT 1 FROM compiled_workflows")) return { rows: [] };
      if (sql.includes("INSERT INTO workflow_runs")) {
        row = { ...row, instruction: values[0], app_id: values[1], device_id: values[2] };
        return { rows: [row] };
      }
      if (sql.includes("UPDATE workflow_runs")) {
        row = { ...row, status: values[1], updated_at: new Date("2026-05-26T00:01:00.000Z") };
        return { rows: [row] };
      }
      return { rows: [] };
    });

    const result = await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("WORKFLOW_NOT_PERSISTED");
    expect(result.error).toBe("Compiled workflow was not persisted");
  });

  it("publishes workflow-run lifecycle events with persisted IDs", async () => {
    await createWorkflowRun({
      instruction: "tap continue",
      appId: "com.example.app",
      deviceId: "device-1",
    });

    expect(mocks.workflowEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      source: "workflow_runs",
      event: "queued",
      workflowRunId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(mocks.workflowEvents.publish).toHaveBeenCalledWith(expect.objectContaining({
      source: "workflow_runs",
      event: "queued",
      workflowRunId: "11111111-1111-4111-8111-111111111111",
      workflowId: compiledWorkflow.id,
      details: expect.objectContaining({ taskId: "99999999-9999-4999-8999-999999999999" }),
    }));
  });

  it("treats maps without pages or element bounds as incomplete", () => {
    expect(isAppMapCompleteEnough(null)).toBe(false);
    expect(isAppMapCompleteEnough({ ...completeMap, pages: {} })).toBe(false);
    expect(isAppMapCompleteEnough({
      ...completeMap,
      pages: {
        page_0: {
          ...completeMap.pages.page_0,
          elements: {
            broken: {
              ...completeMap.pages.page_0.elements.button_continue,
              bounds: { x: Number.NaN, y: 0, w: 0, h: 0 },
            },
          },
        },
      },
    })).toBe(false);
  });
});
