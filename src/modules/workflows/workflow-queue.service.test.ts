import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const client = { query, release };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
  };
  return { query, release, client, pool };
});

vi.mock("../../db/client", () => ({ getDb: () => mocks.pool }));

function queueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    device_id: "22222222-2222-4222-8222-222222222222",
    workflow_id: "33333333-3333-4333-8333-333333333333",
    queue_sequence: "1",
    status: "queued",
    error: null,
    created_at: "2026-07-18T13:00:00.000Z",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("WorkflowQueueService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocates the next per-device sequence under an advisory transaction lock", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("WHERE workflow_id = $1") && sql.startsWith("SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO workflow_queue")) return { rows: [queueRow()] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const { WorkflowQueueService } = await import("./workflow-queue.service");
    const service = new WorkflowQueueService();
    const result = await service.enqueue(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
    );

    expect(result).toMatchObject({ sequence: 1, status: "queued" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_xact_lock"))).toBe(true);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO workflow_queue"));
    expect(String(insert?.[0])).toContain("COALESCE(MAX(queue_sequence), 0) + 1");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not claim a second workflow while the device has one working", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("status = 'working' LIMIT 1")) return { rows: [{ id: "active" }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const { WorkflowQueueService } = await import("./workflow-queue.service");
    const result = await new WorkflowQueueService().claimNext("22222222-2222-4222-8222-222222222222");

    expect(result).toBeNull();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("ORDER BY queue_sequence"))).toBe(false);
  });

  it("claims the oldest queued workflow and changes it atomically to working", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("status = 'working' LIMIT 1")) return { rows: [] };
      if (sql.includes("ORDER BY queue_sequence ASC")) return { rows: [{ id: "queue-row-1" }] };
      if (sql.includes("SET status = 'working'")) {
        return { rows: [queueRow({ status: "working", started_at: "2026-07-18T13:00:01.000Z" })] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const { WorkflowQueueService } = await import("./workflow-queue.service");
    const result = await new WorkflowQueueService().claimNext("22222222-2222-4222-8222-222222222222");

    expect(result).toMatchObject({ workflowId: "33333333-3333-4333-8333-333333333333", status: "working" });
    const select = mocks.query.mock.calls.find(([sql]) => String(sql).includes("ORDER BY queue_sequence ASC"));
    expect(String(select?.[0])).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("only terminalizes the working row before the next workflow can be claimed", async () => {
    mocks.pool.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const { WorkflowQueueService } = await import("./workflow-queue.service");
    const service = new WorkflowQueueService();

    await service.markDone("33333333-3333-4333-8333-333333333333");
    await service.markFailed("44444444-4444-4444-8444-444444444444", "boom");

    expect(String(mocks.pool.query.mock.calls[0][0])).toContain("WHERE workflow_id = $1 AND status = 'working'");
    expect(String(mocks.pool.query.mock.calls[0][0])).toContain("status = 'done'");
    expect(String(mocks.pool.query.mock.calls[1][0])).toContain("WHERE workflow_id = $1 AND status = 'working'");
    expect(String(mocks.pool.query.mock.calls[1][0])).toContain("status = 'failed'");
  });

  it("serializes workflow 1, 2 and 3 for one device in FIFO order", async () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const workflowIds = [
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const rows: Record<string, unknown>[] = [];

    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("SELECT * FROM workflow_queue WHERE workflow_id")) {
        return { rows: rows.filter((row) => row.workflow_id === params[0]) };
      }
      if (sql.includes("INSERT INTO workflow_queue")) {
        const row = queueRow({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${rows.length + 1}`,
          device_id: params[0],
          workflow_id: params[1],
          queue_sequence: String(rows.length + 1),
        });
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.includes("status = 'working' LIMIT 1")) {
        return { rows: rows.filter((row) => row.device_id === params[0] && row.status === "working").slice(0, 1) };
      }
      if (sql.includes("ORDER BY queue_sequence ASC")) {
        const next = rows
          .filter((row) => row.device_id === params[0] && row.status === "queued")
          .sort((a, b) => Number(a.queue_sequence) - Number(b.queue_sequence))[0];
        return { rows: next ? [{ id: next.id }] : [] };
      }
      if (sql.includes("SET status = 'working'")) {
        const row = rows.find((candidate) => candidate.id === params[0] && candidate.status === "queued");
        if (!row) return { rows: [] };
        row.status = "working";
        row.started_at = "2026-07-18T13:00:01.000Z";
        return { rows: [row] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    mocks.pool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("status = 'done'")) {
        const row = rows.find((candidate) => candidate.workflow_id === params[0] && candidate.status === "working");
        if (row) row.status = "done";
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    });

    const { WorkflowQueueService } = await import("./workflow-queue.service");
    const service = new WorkflowQueueService();
    const enqueued = [];
    for (const workflowId of workflowIds) enqueued.push(await service.enqueue(workflowId, deviceId));
    expect(enqueued.map((row) => row.sequence)).toEqual([1, 2, 3]);

    const first = await service.claimNext(deviceId);
    expect(first?.workflowId).toBe(workflowIds[0]);
    expect(await service.claimNext(deviceId)).toBeNull();

    await service.markDone(workflowIds[0]);
    const second = await service.claimNext(deviceId);
    expect(second?.workflowId).toBe(workflowIds[1]);
    expect(rows.map((row) => row.status)).toEqual(["done", "working", "queued"]);
  });
});

describe("simple workflow queue database contract", () => {
  it("enforces FIFO states and one working workflow per device in PostgreSQL", () => {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "..", "db", "migrations", "081_simple_workflow_queue.sql"),
      "utf8",
    );

    expect(migration).toContain("CHECK (status IN ('queued', 'working', 'done', 'failed'))");
    expect(migration).toContain("UNIQUE (device_id, queue_sequence)");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS workflow_queue_one_working_per_device");
    expect(migration).toContain("WHERE status = 'working'");
  });

  it("wraps the complete workflow without changing child JOB_RESULT handling", () => {
    const executor = fs.readFileSync(path.join(__dirname, "workflow.executor.ts"), "utf8");
    const queueService = fs.readFileSync(path.join(__dirname, "workflow-queue.service.ts"), "utf8");

    expect(executor).toContain("workflowQueueService.enqueue(workflowId, workflow.deviceId)");
    expect(executor).toContain("await runWorkflow(workflowId, job)");
    expect(queueService).not.toContain("JOB_RESULT");
    expect(queueService).not.toContain("stepIndex");
  });
});
