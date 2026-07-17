import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeDeviceExecutionHandle,
  DeviceExecutionArbiter,
  DEVICE_EXECUTION_BOUNDARY_MATRIX,
  DeviceExecutionSchemaError,
  type DeviceExecutionJobDispatchPermit,
  type DeviceExecutionState,
} from "../../src/modules/device-execution/device-execution-arbiter";

const repoRoot = path.resolve(__dirname, "../..");
const migrationPath = path.join(repoRoot, "src/db/migrations/081_device_execution_queue.sql");
const postgresUrl = process.env.PNQ001_PG_URL ?? "postgresql://pnqtest@127.0.0.1:55432/pnq001_test";
const describePostgres = postgresUrl ? describe : describe.skip;

const DEVICE_A = "00000000-0000-4000-8000-0000000000a1";
const DEVICE_B = "00000000-0000-4000-8000-0000000000b2";
const DEVICE_C = "00000000-0000-4000-8000-0000000000c3";
const DEVICE_D = "00000000-0000-4000-8000-0000000000d4";
const DEVICE_E = "00000000-0000-4000-8000-0000000000e5";
const ACTIVE_STATES = ["claimed", "dispatching", "dispatched", "reconciling", "blocked"] as const;

let pool: Pool;
let arbiter: DeviceExecutionArbiter;

describePostgres("PNQ-001 device execution arbiter with real PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeTestDatabase(postgresUrl!);
    pool = new Pool({ connectionString: postgresUrl, max: 8 });
    await assertRealPostgres(pool);
    arbiter = new DeviceExecutionArbiter(() => pool);
  });

  beforeEach(async () => {
    await resetPnqSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("admits 100 concurrent roots and drains the stable PostgreSQL FIFO with maxActive=1", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-fifo-a");
    const externalIds = Array.from({ length: 100 }, (_, index) => `fifo-job-${String(index + 1).padStart(3, "0")}`);

    const admissions = await Promise.all(externalIds.map((externalId) => arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId,
      requestKey: externalId,
      actor: "pnq-test",
    })));
    expect(admissions.map((admission) => admission.decision)).toEqual(Array.from({ length: 100 }, () => "admitted"));
    expect(await activeRootCount(pool, DEVICE_A)).toBe(0);

    const fifoRows = await rootRowsByFifo(pool, DEVICE_A);
    const fifoOrder = fifoRows.map((row) => row.external_id);
    expect(fifoOrder).toHaveLength(100);
    expect(new Set(fifoOrder)).toEqual(new Set(externalIds));
    expect(fifoRows.map((row) => row.fifo_sequence)).toEqual([...fifoRows].map((row) => row.fifo_sequence).sort((a, b) => a - b));

    const activeCounts: number[] = [];
    const claimedOrder: string[] = [];
    for (const externalId of fifoOrder) {
      const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" });
      expect(permit).not.toBeNull();
      activeCounts.push(await activeRootCount(pool, DEVICE_A));
      expect(await externalIdForRoot(pool, permit!.rootId)).toBe(externalId);
      claimedOrder.push(externalId);

      const dispatch = await arbiter.observeDispatch({
        deviceId: DEVICE_A,
        rootKind: "job",
        externalId,
        sent: true,
        actor: "transport-test",
      });
      expect(dispatch.decision).toBe("dispatched");
      activeCounts.push(await activeRootCount(pool, DEVICE_A));

      const terminal = await arbiter.observeTerminal({
        deviceId: DEVICE_A,
        rootId: permit!.rootId,
        status: "completed",
        actor: "device-test",
      });
      expect(terminal.decision).toBe("terminal");
      expect(await activeRootCount(pool, DEVICE_A)).toBe(0);
    }

    expect(claimedOrder).toEqual(fifoOrder);
    expect(Math.max(...activeCounts)).toBe(1);
    expect(await stateCount(pool, "completed")).toBe(100);
  }, 20_000);

  it("allows separate devices to hold active roots concurrently", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-parallel-a");
    await insertDevice(pool, DEVICE_B, "pnq-parallel-b");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "parallel-a" });
    await arbiter.observeAdmission({ deviceId: DEVICE_B, rootKind: "job", externalId: "parallel-b" });

    const [permitA, permitB] = await Promise.all([
      arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" }),
      arbiter.claimNextRoot({ deviceId: DEVICE_B, actor: "worker-b" }),
    ]);

    expect(permitA).toMatchObject({ deviceId: DEVICE_A, state: "claimed" });
    expect(permitB).toMatchObject({ deviceId: DEVICE_B, state: "claimed" });
    expect(await activeRootCount(pool)).toBe(2);
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
    expect(await activeRootCount(pool, DEVICE_B)).toBe(1);
  });

  it("serializes two workers racing to claim one device root", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-race-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "race-job" });

    const workerOne = new DeviceExecutionArbiter(() => pool);
    const workerTwo = new DeviceExecutionArbiter(() => pool);
    const results = await Promise.all([
      workerOne.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-one" }),
      workerTwo.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-two" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
    expect(await eventCount(pool, "root_claimed")).toBe(1);
  });

  it("uses one canonical DB/wire handle and registers the waiter before wire send", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-wire-a");
    const order: string[] = [];
    const seen: { waiter?: DeviceExecutionJobDispatchPermit; wire?: DeviceExecutionJobDispatchPermit } = {};

    const result = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "wire-job",
      requestKey: "wire-job",
      actor: "pnq-egress-test",
      metadata: { jobType: "screenshot" },
      registerWaiter: (permit) => {
        order.push("waiter");
        seen.waiter = permit;
      },
      wireDispatch: (permit) => {
        order.push("wire");
        seen.wire = permit;
        expect(order).toEqual(["waiter", "wire"]);
        return true;
      },
    });

    expect(result).toMatchObject({ decision: "dispatched", sent: true });
    expect(order).toEqual(["waiter", "wire"]);
    expect(seen.waiter).toEqual(seen.wire);
    expect(result.permit).toEqual(seen.waiter);
    expect(result.handle).toEqual(seen.waiter!.handle);
    expect(result.permit?.wireHandle).toEqual({
      pnqRootId: result.handle!.rootId,
      pnqDeviceId: DEVICE_A,
      pnqRootKind: "job",
      pnqOwnerGeneration: result.handle!.ownerGeneration,
      pnqOperationKind: "job",
      pnqOperationId: "wire-job",
    });

    const root = await rootForExternalId(pool, "wire-job");
    const operation = await operationFor(pool, "job", "wire-job");
    expect(root).toMatchObject({
      id: result.handle!.rootId,
      state: "dispatched",
      owner_generation: result.handle!.ownerGeneration,
    });
    expect(operation).toMatchObject({
      root_id: result.handle!.rootId,
      device_id: DEVICE_A,
      operation_id: "wire-job",
      owner_generation: result.handle!.ownerGeneration,
      state: "dispatched",
      wire_type: "JOB",
    });
    expect(operation!.wire_handle).toEqual(result.permit!.wireHandle);
    expect(decodeDeviceExecutionHandle(operation!.wire_handle)).toEqual(result.handle);
    expect(await eventTypes(pool)).toEqual(["implicit_admission", "root_dispatching", "root_dispatched"]);
  });

  it("uses canonical DB/wire handles for BATCH and WORKFLOW roots", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-boundary-a");
    const observed: Array<{ kind: "waiter" | "wire"; operationId: string; handle: unknown }> = [];

    for (const boundary of ["edge_batch", "server_workflow_root"] as const) {
      const policy = DEVICE_EXECUTION_BOUNDARY_MATRIX[boundary];
      const operationId = `${boundary}-operation`;
      if (boundary === "server_workflow_root") {
        await arbiter.observeAdmission({
          deviceId: DEVICE_A,
          rootKind: "server_workflow",
          externalId: operationId,
          requestKey: operationId,
          actor: `${boundary}-test`,
        });
      }
      const result = await arbiter.runObservedEgress({
        deviceId: DEVICE_A,
        boundary,
        rootExternalId: boundary === "server_workflow_root" ? operationId : undefined,
        operationId,
        wireType: boundary === "edge_batch" ? "BATCH_START" : "WORKFLOW_START",
        actor: `${boundary}-test`,
        metadata: { boundaryEvidence: true },
        registerWaiter: (handle) => {
          observed.push({ kind: "waiter", operationId, handle });
        },
        wireDispatch: (handle) => {
          observed.push({ kind: "wire", operationId, handle });
          return true;
        },
      });

      expect(result).toMatchObject({ decision: "dispatched", sent: true });
      expect(result.handle).toEqual({
        rootId: result.root!.id,
        deviceId: DEVICE_A,
        rootKind: policy.rootKind,
        ownerGeneration: result.root!.ownerGeneration,
        operationKind: policy.operationKind,
        operationId,
      });
      expect(decodeDeviceExecutionHandle(result.operation!.wireHandle)).toEqual(result.handle);
      expect(result.operation).toMatchObject({
        rootId: result.root!.id,
        deviceId: DEVICE_A,
        rootKind: policy.rootKind,
        operationKind: policy.operationKind,
        operationId,
        ownerGeneration: result.root!.ownerGeneration,
        state: "dispatched",
        egressLane: "device_execution",
      });

      await expect(arbiter.observeTerminal({
        deviceId: DEVICE_A,
        handle: result.handle!,
        status: "completed",
        actor: `${boundary}-terminal`,
      })).resolves.toMatchObject({ decision: "terminal" });
    }

    expect(observed.map((entry) => `${entry.operationId}:${entry.kind}`)).toEqual([
      "edge_batch-operation:waiter",
      "edge_batch-operation:wire",
      "server_workflow_root-operation:waiter",
      "server_workflow_root-operation:wire",
    ]);
    expect(observed[0]!.handle).toEqual(observed[1]!.handle);
    expect(observed[2]!.handle).toEqual(observed[3]!.handle);
  });

  it("keeps mixed JOB/BATCH/WORKFLOW roots FIFO and non-overlapping on one device", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-mixed-fifo-a");
    const roots = [
      { rootKind: "server_workflow" as const, externalId: "workflow-root" },
      { rootKind: "batch" as const, externalId: "batch-root" },
      { rootKind: "job" as const, externalId: "job-root" },
    ];

    for (const root of roots) {
      await expect(arbiter.observeAdmission({ deviceId: DEVICE_A, ...root })).resolves.toMatchObject({ decision: "admitted" });
    }

    expect(await rootExternalIdsByFifo(pool, DEVICE_A)).toEqual(roots.map((root) => root.externalId));

    for (const root of roots) {
      const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: `${root.externalId}-worker` });
      expect(permit).not.toBeNull();
      expect(await externalIdForRoot(pool, permit!.rootId)).toBe(root.externalId);
      expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
      await expect(arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: `${root.externalId}-overlap-worker` })).resolves.toBeNull();
      await expect(arbiter.observeTerminal({
        deviceId: DEVICE_A,
        rootId: permit!.rootId,
        rootKind: root.rootKind,
        status: "completed",
        actor: `${root.externalId}-terminal`,
      })).resolves.toMatchObject({ decision: "terminal" });
      expect(await activeRootCount(pool, DEVICE_A)).toBe(0);
    }
  });

  it("serializes multi-worker races across BATCH and WORKFLOW roots", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-mixed-race-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "batch", externalId: "race-batch" });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "server_workflow", externalId: "race-workflow" });

    const workers = Array.from({ length: 8 }, (_, index) => new DeviceExecutionArbiter(() => pool)
      .claimNextRoot({ deviceId: DEVICE_A, actor: `mixed-race-worker-${index}` }));
    const results = await Promise.all(workers);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await externalIdForRoot(pool, results.find(Boolean)!.rootId)).toBe("race-batch");
    expect(await stateForExternalId(pool, "race-batch")).toBe("claimed");
    expect(await stateForExternalId(pool, "race-workflow")).toBe("queued");
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
  });

  it("fails closed after waiter registration when observed WORKFLOW wire send times out", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-observed-timeout-a");
    const order: string[] = [];
    await arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: "timeout-workflow-root",
      requestKey: "timeout-workflow-root",
      actor: "workflow-timeout-test",
    });

    const result = await arbiter.runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "server_workflow_root",
      rootExternalId: "timeout-workflow-root",
      operationId: "timeout-workflow-root",
      wireType: "WORKFLOW_START",
      actor: "workflow-timeout-test",
      registerWaiter: () => {
        order.push("waiter");
      },
      wireDispatch: () => {
        order.push("wire");
        throw new Error("workflow_send_timeout");
      },
    });

    expect(order).toEqual(["waiter", "wire"]);
    expect(result).toMatchObject({ decision: "offline", sent: false, reason: "workflow_send_timeout" });
    expect(result.root).toMatchObject({ state: "blocked" });
    expect(result.operation).toMatchObject({ state: "blocked" });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "timeout-successor" });
    await expect(arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "after-timeout-worker" })).resolves.toBeNull();
    expect(await stateForExternalId(pool, "timeout-successor")).toBe("queued");
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
  });

  it("keeps a queued successor blocked across a crash/restart ambiguity", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-restart-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "ambiguous-root" });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "successor-root" });

    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-before-restart" });
    expect(permit).not.toBeNull();
    await arbiter.observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "ambiguous-root",
      sent: true,
      actor: "transport-before-restart",
    });

    const ambiguous = await arbiter.markAmbiguous({
      deviceId: DEVICE_A,
      rootId: permit!.rootId,
      reason: "restart_after_possible_wire_send",
      state: "reconciling",
      actor: "startup-reconciler-test",
    });
    expect(ambiguous.decision).toBe("ambiguous");

    const restartedArbiter = new DeviceExecutionArbiter(() => pool);
    await expect(restartedArbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-after-restart" })).resolves.toBeNull();
    expect(await stateForExternalId(pool, "ambiguous-root")).toBe("reconciling");
    expect(await stateForExternalId(pool, "successor-root")).toBe("queued");
    expect(await eventCount(pool, "root_ambiguous")).toBe(1);
  });

  it("releases terminal child-only server roots while retaining recent in-flight evidence", async () => {
    const workflowId = "00000000-0000-4000-8000-00000000f001";
    const jobId = "00000000-0000-4000-8000-00000000f002";
    const startedWorkflowId = "00000000-0000-4000-8000-00000000f003";
    const startedJobId = "00000000-0000-4000-8000-00000000f004";
    const failedWorkflowId = "00000000-0000-4000-8000-00000000f005";
    const failedJobId = "00000000-0000-4000-8000-00000000f006";
    const staleTerminalWorkflowId = "00000000-0000-4000-8000-00000000f007";
    const staleTerminalJobId = "00000000-0000-4000-8000-00000000f008";
    await insertDevice(pool, DEVICE_A, "pnq-undispatched-timeout-a");
    await insertDevice(pool, DEVICE_B, "pnq-started-timeout-b");
    await insertDevice(pool, DEVICE_C, "pnq-terminal-orphan-c");
    await insertDevice(pool, DEVICE_D, "pnq-stale-terminal-d");
    await insertWorkflow(pool, workflowId, DEVICE_A, "running");
    await insertWorkflow(pool, startedWorkflowId, DEVICE_B, "running");
    await insertWorkflow(pool, failedWorkflowId, DEVICE_C, "failed");
    await insertWorkflow(pool, staleTerminalWorkflowId, DEVICE_D, "failed");
    await arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: workflowId,
      actor: "workflow-test",
    });
    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "workflow-worker" });
    expect(permit).not.toBeNull();
    await arbiter.observeAdmission({
      deviceId: DEVICE_B,
      rootKind: "server_workflow",
      externalId: startedWorkflowId,
      actor: "workflow-test",
    });
    const startedPermit = await arbiter.claimNextRoot({ deviceId: DEVICE_B, actor: "workflow-worker" });
    expect(startedPermit).not.toBeNull();
    await arbiter.observeAdmission({
      deviceId: DEVICE_C,
      rootKind: "server_workflow",
      externalId: failedWorkflowId,
      actor: "workflow-test",
    });
    const failedPermit = await arbiter.claimNextRoot({ deviceId: DEVICE_C, actor: "workflow-worker" });
    expect(failedPermit).not.toBeNull();
    await arbiter.observeAdmission({
      deviceId: DEVICE_D,
      rootKind: "server_workflow",
      externalId: staleTerminalWorkflowId,
      actor: "workflow-test",
    });
    const staleTerminalPermit = await arbiter.claimNextRoot({ deviceId: DEVICE_D, actor: "workflow-worker" });
    expect(staleTerminalPermit).not.toBeNull();
    await pool.query(
      `INSERT INTO jobs (id, device_id, status, started_at, completed_at) VALUES ($1, $2, 'timeout', NULL, NOW())`,
      [jobId, DEVICE_A],
    );
    await pool.query(
      `INSERT INTO command_log (job_id, command_raw) VALUES ($1, $2)`,
      [jobId, `workflow:${workflowId} step:0 screen_wake`],
    );
    await pool.query(
      `INSERT INTO jobs (id, device_id, status, started_at, completed_at) VALUES ($1, $2, 'timeout', NOW(), NOW())`,
      [startedJobId, DEVICE_B],
    );
    await pool.query(
      `INSERT INTO command_log (job_id, command_raw) VALUES ($1, $2)`,
      [startedJobId, `workflow:${startedWorkflowId} step:0 screen_wake`],
    );
    await pool.query(
      `INSERT INTO jobs (id, device_id, status, started_at, completed_at) VALUES ($1, $2, 'timeout', NULL, NOW())`,
      [failedJobId, DEVICE_C],
    );
    await pool.query(
      `INSERT INTO command_log (job_id, command_raw) VALUES ($1, $2)`,
      [failedJobId, `workflow:${failedWorkflowId} step:0 screen_wake`],
    );
    await pool.query(
      `INSERT INTO jobs (id, device_id, status, started_at, completed_at)
       VALUES ($1, $2, 'timeout', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes')`,
      [staleTerminalJobId, DEVICE_D],
    );
    await pool.query(
      `INSERT INTO command_log (job_id, command_raw) VALUES ($1, $2)`,
      [staleTerminalJobId, `workflow:${staleTerminalWorkflowId} step:0 screen_wake`],
    );

    await expect(arbiter.reconcileUndispatchedTimedOutServerWorkflows()).resolves.toEqual({
      reconciledRoots: 3,
    });

    expect(await workflowStatus(pool, workflowId)).toBe("failed");
    expect(await stateForExternalId(pool, workflowId)).toBe("failed");
    expect(await workflowStatus(pool, failedWorkflowId)).toBe("failed");
    expect(await stateForExternalId(pool, failedWorkflowId)).toBe("failed");
    expect(await workflowStatus(pool, staleTerminalWorkflowId)).toBe("failed");
    expect(await stateForExternalId(pool, staleTerminalWorkflowId)).toBe("failed");
    expect(await eventCount(pool, "undispatched_timed_out_workflow_reconciled")).toBe(3);
    expect(await workflowStatus(pool, startedWorkflowId)).toBe("running");
    expect(await stateForExternalId(pool, startedWorkflowId)).toBe("claimed");
  });

  it("releases a stale blocked terminal workflow root after restart and admits its successor", async () => {
    const workflowId = "00000000-0000-4000-8000-00000000d001";
    await insertDevice(pool, DEVICE_A, "pnq-terminal-restart-a");
    await insertWorkflow(pool, workflowId, DEVICE_A, "running");
    await arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: workflowId,
      requestKey: workflowId,
    });
    await arbiter.runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "server_workflow_root",
      rootExternalId: workflowId,
      operationId: workflowId,
      wireType: "WORKFLOW_START",
      registerWaiter: () => undefined,
      wireDispatch: () => { throw new Error("pre_wire_timeout"); },
    });
    await pool.query(
      "UPDATE workflows SET status = 'failed', completed_at = NOW(), error = 'RECOVERY_BUDGET_EXCEEDED' WHERE id = $1",
      [workflowId],
    );

    const restartedArbiter = new DeviceExecutionArbiter(() => pool);
    const competingReconciler = new DeviceExecutionArbiter(() => pool);
    const reconciliationResults = await Promise.all([
      restartedArbiter.reconcileTerminalServerWorkflowRoots(),
      competingReconciler.reconcileTerminalServerWorkflowRoots(),
    ]);
    expect(reconciliationResults.reduce((sum, result) => sum + result.reconciledRoots, 0)).toBe(1);
    await expect(restartedArbiter.reconcileTerminalServerWorkflowRoots()).resolves.toEqual({ reconciledRoots: 0 });
    expect(await stateForExternalId(pool, workflowId)).toBe("failed");
    expect(await eventCount(pool, "terminal_workflow_root_reconciled")).toBe(1);

    await restartedArbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: "00000000-0000-4000-8000-00000000d002",
    });
    await expect(restartedArbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "post-restart-worker" }))
      .resolves.not.toBeNull();
  });

  it("keeps stale workflow roots blocked when terminal ownership evidence is incomplete or active", async () => {
    const cases = [
      { suffix: "11", workflowStatus: "running", completed: false, mutate: "none" },
      { suffix: "12", workflowStatus: "failed", completed: false, mutate: "none" },
      { suffix: "13", workflowStatus: "failed", completed: true, mutate: "identity" },
      { suffix: "14", workflowStatus: "failed", completed: true, mutate: "active-child" },
      { suffix: "15", workflowStatus: "cancelled", completed: true, mutate: "queued-job" },
    ] as const;
    const insertedDevices = new Set<string>();

    for (const testCase of cases) {
      const workflowId = `00000000-0000-4000-8000-00000000d0${testCase.suffix}`;
      const deviceId = testCase.suffix === "11" ? DEVICE_A
        : testCase.suffix === "12" ? DEVICE_B
          : testCase.suffix === "13" ? DEVICE_C
            : testCase.suffix === "14" ? DEVICE_D : DEVICE_E;
      if (!insertedDevices.has(deviceId)) {
        await insertDevice(pool, deviceId, `pnq-negative-${testCase.suffix}`);
        insertedDevices.add(deviceId);
      }
      await insertWorkflow(pool, workflowId, deviceId, "running");
      await arbiter.observeAdmission({ deviceId, rootKind: "server_workflow", externalId: workflowId });
      await arbiter.runObservedEgress({
        deviceId,
        boundary: "server_workflow_root",
        rootExternalId: workflowId,
        operationId: workflowId,
        wireType: "WORKFLOW_START",
        registerWaiter: () => undefined,
        wireDispatch: () => { throw new Error("ambiguous_send"); },
      });
      await pool.query(
        "UPDATE workflows SET status = $2, completed_at = CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id = $1",
        [workflowId, testCase.workflowStatus, testCase.completed],
      );
      if (testCase.mutate === "identity") {
        await pool.query(
          "UPDATE device_execution_operations SET operation_id = operation_id || '-mismatch' WHERE operation_kind = 'workflow' AND operation_id = $1",
          [workflowId],
        );
      } else if (testCase.mutate === "active-child") {
        const root = await rootForExternalId(pool, workflowId);
        await pool.query(
          `INSERT INTO device_execution_operations
             (root_id, device_id, root_kind, operation_kind, operation_id, owner_generation, state, egress_lane, wire_handle)
           VALUES ($1, $2, 'server_workflow', 'job', $3, $4, 'dispatched', 'device_execution', '{}'::jsonb)`,
          [root!.id, deviceId, `${workflowId}-child`, root!.owner_generation],
        );
      } else if (testCase.mutate === "queued-job") {
        const jobId = "00000000-0000-4000-8000-00000000d099";
        await pool.query("INSERT INTO jobs (id, device_id, status) VALUES ($1, $2, 'pending')", [jobId, deviceId]);
        await pool.query("INSERT INTO command_log (job_id, command_raw) VALUES ($1, $2)", [jobId, `workflow:${workflowId} step:0`]);
      }
    }

    await expect(arbiter.reconcileTerminalServerWorkflowRoots()).resolves.toEqual({ reconciledRoots: 0 });
    expect(await activeRootCount(pool)).toBe(cases.length);
  });

  it.each([
    ["timeout", "job_timeout", "blocked"] as const,
    ["disconnect", "device_disconnect", "blocked"] as const,
    ["restart", "server_startup_reconciliation", "reconciling"] as const,
  ])("keeps a successor queued when %s ambiguity is active", async (_label, reason, expectedState) => {
    await insertDevice(pool, DEVICE_A, `pnq-${reason}-a`);
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: `${reason}-root` });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: `${reason}-successor` });
    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: `${reason}-worker` });
    expect(permit).not.toBeNull();

    if (reason === "server_startup_reconciliation") {
      const startup = await arbiter.reconcileInFlightAtStartup({ actor: "startup-test", reason });
      expect(startup).toEqual({ reconciledRoots: 1, activeAmbiguousRoots: 1 });
      expect(await eventCount(pool, "startup_reconciled_root")).toBe(1);
    } else {
      await arbiter.observeDispatch({
        deviceId: DEVICE_A,
        rootKind: "job",
        externalId: `${reason}-root`,
        sent: true,
        actor: `${reason}-transport`,
      });
      const ambiguous = await arbiter.markAmbiguous({
        deviceId: DEVICE_A,
        handle: {
          rootId: permit!.rootId,
          deviceId: DEVICE_A,
          rootKind: "job",
          ownerGeneration: permit!.ownerGeneration,
          operationKind: "job",
          operationId: `${reason}-root`,
        },
        reason,
        state: expectedState,
        actor: `${reason}-test`,
      });
      expect(ambiguous.decision).toBe("ambiguous");
      expect(await eventCount(pool, "root_ambiguous")).toBe(1);
    }

    expect(await stateForExternalId(pool, `${reason}-root`)).toBe(expectedState);
    expect(await stateForExternalId(pool, `${reason}-successor`)).toBe("queued");
    await expect(arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: `${reason}-successor-worker` })).resolves.toBeNull();
    expect(await activeRootCount(pool, DEVICE_A)).toBe(1);
  });

  it("audits terminal CAS rejections for wrong-device, stale, duplicate, and late results", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-terminal-a");
    await insertDevice(pool, DEVICE_B, "pnq-terminal-b");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "terminal-job" });
    const permit = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-a" });
    expect(permit).not.toBeNull();
    await arbiter.observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      sent: true,
      actor: "transport-test",
    });

    const stale = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      ownerGeneration: permit!.ownerGeneration - 1,
      status: "completed",
      actor: "stale-worker",
    });
    expect(stale).toMatchObject({ decision: "rejected", reason: "owner_generation_mismatch" });
    expect(await stateForExternalId(pool, "terminal-job")).toBe("dispatched");

    const wrongDevice = await arbiter.observeTerminal({
      deviceId: DEVICE_B,
      rootKind: "job",
      externalId: "terminal-job",
      status: "completed",
      actor: "device-b",
    });
    expect(wrongDevice).toMatchObject({ decision: "rejected", reason: "root_owned_by_different_device" });
    expect(await stateForExternalId(pool, "terminal-job")).toBe("dispatched");

    const completed = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      status: "completed",
      actor: "device-a",
    });
    expect(completed.decision).toBe("terminal");

    const duplicate = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "terminal-job",
      status: "failed",
      actor: "device-a-late",
    });
    expect(["ignored", "rejected"]).toContain(duplicate.decision);
    expect(duplicate.reason).toBe("root_already_terminal");
    expect(await stateForExternalId(pool, "terminal-job")).toBe("completed");

    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "late-after-cancel" });
    const cancelled = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "late-after-cancel",
      status: "cancelled",
      actor: "dispatcher_cancel",
    });
    expect(cancelled.decision).toBe("terminal");
    const late = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "late-after-cancel",
      status: "completed",
      actor: "device-late",
    });
    expect(late).toMatchObject({ decision: "rejected", reason: "root_already_terminal" });
    expect(await stateForExternalId(pool, "late-after-cancel")).toBe("cancelled");

    expect(await eventCount(pool, "result_rejected_stale_generation")).toBe(1);
    expect(await eventCount(pool, "result_rejected_wrong_device")).toBe(1);
    expect(await eventCount(pool, "duplicate_or_late_result")).toBe(2);
  });

  it("cancels queued and running JOB roots without letting late results mutate successors", async () => {
    await insertDevice(pool, DEVICE_A, "pnq-cancel-a");
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "queued-cancel" });
    await arbiter.observeAdmission({ deviceId: DEVICE_A, rootKind: "job", externalId: "queued-successor" });

    const queuedCancel = await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "queued-cancel",
      status: "cancelled",
      actor: "dispatcher_cancel",
      reason: "queued_job_cancelled",
    });
    expect(queuedCancel.decision).toBe("terminal");
    expect(await stateForExternalId(pool, "queued-cancel")).toBe("cancelled");

    const queuedSuccessor = await arbiter.claimNextRoot({ deviceId: DEVICE_A, actor: "worker-after-queued-cancel" });
    expect(queuedSuccessor).not.toBeNull();
    expect(await externalIdForRoot(pool, queuedSuccessor!.rootId)).toBe("queued-successor");
    await arbiter.observeTerminal({
      deviceId: DEVICE_A,
      rootId: queuedSuccessor!.rootId,
      status: "completed",
      actor: "device-successor",
    });

    await insertDevice(pool, DEVICE_C, "pnq-cancel-c");
    await arbiter.observeAdmission({ deviceId: DEVICE_C, rootKind: "job", externalId: "running-cancel" });
    await arbiter.observeAdmission({ deviceId: DEVICE_C, rootKind: "job", externalId: "running-successor" });
    const runningPermit = await arbiter.claimNextRoot({ deviceId: DEVICE_C, actor: "worker-before-running-cancel" });
    expect(runningPermit).not.toBeNull();
    await arbiter.observeDispatch({
      deviceId: DEVICE_C,
      rootKind: "job",
      externalId: "running-cancel",
      sent: true,
      actor: "transport-before-running-cancel",
    });

    const runningCancel = await arbiter.observeTerminal({
      deviceId: DEVICE_C,
      rootKind: "job",
      externalId: "running-cancel",
      status: "cancelled",
      actor: "dispatcher_cancel",
      reason: "running_job_cancelled",
    });
    expect(runningCancel.decision).toBe("terminal");
    expect(await stateForExternalId(pool, "running-cancel")).toBe("cancelled");

    const lateRunning = await arbiter.observeTerminal({
      deviceId: DEVICE_C,
      rootKind: "job",
      externalId: "running-cancel",
      status: "completed",
      actor: "device-late-after-running-cancel",
    });
    expect(lateRunning).toMatchObject({ decision: "rejected", reason: "root_already_terminal" });

    const runningSuccessor = await arbiter.claimNextRoot({ deviceId: DEVICE_C, actor: "worker-after-running-cancel" });
    expect(runningSuccessor).not.toBeNull();
    expect(await externalIdForRoot(pool, runningSuccessor!.rootId)).toBe("running-successor");
  });

  it("keeps workflow and PNQ ownership intact when queued cancellation loses to the worker transition", async () => {
    const workflowId = "00000000-0000-4000-8000-00000000ca01";
    await insertDevice(pool, DEVICE_A, "pnq-workflow-cancel-race-a");
    await insertWorkflow(pool, workflowId, DEVICE_A, "queued");
    await arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: workflowId,
      requestKey: workflowId,
    });
    await arbiter.runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "server_workflow_root",
      rootExternalId: workflowId,
      operationId: workflowId,
      wireType: "WORKFLOW_START",
      wireDispatch: () => true,
    });

    const worker = await pool.connect();
    try {
      await worker.query("BEGIN");
      await worker.query(
        "UPDATE workflows SET status = 'running' WHERE id = $1 AND status = 'queued'",
        [workflowId],
      );

      const cancellation = arbiter.cancelQueuedPersistedWorkflow({
        deviceId: DEVICE_A,
        workflowId,
        actor: "postgres-cancellation-race-test",
      });
      await waitForWorkflowRowLockWait(pool, workflowId);
      await worker.query("COMMIT");

      await expect(cancellation).resolves.toMatchObject({
        decision: "rejected",
        reason: "workflow_not_queued",
      });
    } finally {
      await worker.query("ROLLBACK").catch(() => undefined);
      worker.release();
    }

    expect(await workflowStatus(pool, workflowId)).toBe("running");
    expect(await stateForExternalId(pool, workflowId)).toBe("dispatched");
    expect(await eventCount(pool, "persisted_workflow_cancel_rejected")).toBe(1);
  });

  it("rolls back PNQ terminalization when persisted workflow cancellation fails mid-transaction", async () => {
    const workflowId = "00000000-0000-4000-8000-00000000ca02";
    await insertDevice(pool, DEVICE_A, "pnq-workflow-cancel-rollback-a");
    await insertWorkflow(pool, workflowId, DEVICE_A, "queued");
    await arbiter.observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "server_workflow",
      externalId: workflowId,
      requestKey: workflowId,
    });
    await pool.query(`
      CREATE FUNCTION pnq_test_reject_workflow_cancel() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'cancelled' THEN
          RAISE EXCEPTION 'pnq_test_forced_cancel_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER pnq_test_reject_workflow_cancel
      BEFORE UPDATE ON workflows
      FOR EACH ROW EXECUTE FUNCTION pnq_test_reject_workflow_cancel();
    `);

    await expect(arbiter.cancelQueuedPersistedWorkflow({
      deviceId: DEVICE_A,
      workflowId,
      actor: "postgres-cancellation-rollback-test",
    })).rejects.toThrow("pnq_test_forced_cancel_failure");

    expect(await workflowStatus(pool, workflowId)).toBe("queued");
    expect(await stateForExternalId(pool, workflowId)).toBe("queued");
    expect((await operationFor(pool, "workflow", workflowId))?.state).toBe("registered");
    expect(await eventCount(pool, "persisted_workflow_and_root_cancelled")).toBe(0);
  });

  it("materializes the schema contract needed by PNQ queue authority", async () => {
    await expect(arbiter.validateSchema()).resolves.toBeUndefined();

    const rootColumns = await columnsFor(pool, "device_execution_roots");
    expect(rootColumns.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(rootColumns.get("device_id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(rootColumns.get("root_kind")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(rootColumns.get("state")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(rootColumns.get("fifo_sequence")).toMatchObject({ data_type: "bigint", is_nullable: "NO", is_identity: "YES" });
    expect(rootColumns.get("owner_generation")).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
    expect(rootColumns.get("metadata")).toMatchObject({ data_type: "jsonb", is_nullable: "NO" });

    const eventColumns = await columnsFor(pool, "device_execution_events");
    expect(eventColumns.get("id")).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
    expect(eventColumns.get("root_id")).toMatchObject({ data_type: "uuid" });
    expect(eventColumns.get("device_id")).toMatchObject({ data_type: "uuid" });
    expect(eventColumns.get("event_type")).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(eventColumns.get("metadata")).toMatchObject({ data_type: "jsonb", is_nullable: "NO" });

    const rootConstraints = await constraintsFor(pool, "device_execution_roots");
    expect(rootConstraints.some((constraint) => constraint.contype === "p")).toBe(true);
    expect(rootConstraints.some((constraint) => constraint.contype === "f" && constraint.definition.includes("REFERENCES devices(id)"))).toBe(true);
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_root_kind_check")?.definition).toContain("server_workflow");
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_state_check")?.definition).toContain("reconciling");
    expect(rootConstraints.find((constraint) => constraint.conname === "device_execution_roots_owner_generation_check")?.definition).toContain("owner_generation >= 0");

    const eventConstraints = await constraintsFor(pool, "device_execution_events");
    expect(eventConstraints.filter((constraint) => constraint.contype === "f")).toHaveLength(2);
    expect(eventConstraints.some((constraint) => constraint.definition.includes("REFERENCES device_execution_roots(id)"))).toBe(true);
    expect(eventConstraints.some((constraint) => constraint.definition.includes("REFERENCES devices(id)"))).toBe(true);

    const indexes = await indexesFor(pool);
    const activeSlot = indexes.get("idx_device_execution_active_slot");
    expect(activeSlot).toMatchObject({ indisunique: true });
    expect(activeSlot?.predicate).toContain("claimed");
    expect(activeSlot?.predicate).toContain("dispatched");
    expect(activeSlot?.predicate).toContain("reconciling");
    expect(activeSlot?.predicate).toContain("blocked");
    expect(activeSlot?.predicate).not.toContain("queued");

    const fifoIndex = indexes.get("idx_device_execution_roots_fifo");
    expect(fifoIndex?.predicate).toContain("queued");
    expect(indexes.get("idx_device_execution_roots_external")).toMatchObject({ indisunique: true });
    expect(indexes.has("idx_device_execution_events_root")).toBe(true);
    expect(indexes.has("idx_device_execution_events_device")).toBe(true);
    expect(indexes.has("idx_device_execution_events_type")).toBe(true);
  });

  it("fails closed when a required schema index is missing", async () => {
    await pool.query("DROP INDEX idx_device_execution_roots_fifo");

    await expect(arbiter.validateSchema()).rejects.toBeInstanceOf(DeviceExecutionSchemaError);
  });
});

function assertSafeTestDatabase(rawUrl: string): void {
  if (rawUrl === process.env.DATABASE_URL) {
    throw new Error("PNQ001_PG_URL must not be the production DATABASE_URL");
  }

  const parsed = new URL(rawUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(pnq.*test|test.*pnq|pnq001|pnq_001|vitest|tmp)/i.test(dbName)) {
    throw new Error(`Refusing to reset PostgreSQL database "${dbName}". Use a disposable PNQ/test database.`);
  }
}

async function assertRealPostgres(db: Pool): Promise<void> {
  const result = await db.query<{ version: string }>("SELECT version()");
  expect(result.rows[0]?.version).toContain("PostgreSQL");
}

async function resetPnqSchema(db: Pool): Promise<void> {
  await db.query(`
    DROP TABLE IF EXISTS command_log CASCADE;
    DROP TABLE IF EXISTS jobs CASCADE;
    DROP TABLE IF EXISTS workflows CASCADE;
    DROP FUNCTION IF EXISTS pnq_test_reject_workflow_cancel() CASCADE;
    DROP TABLE IF EXISTS device_execution_events CASCADE;
    DROP TABLE IF EXISTS device_execution_operations CASCADE;
    DROP TABLE IF EXISTS device_execution_roots CASCADE;
    DROP TABLE IF EXISTS devices CASCADE;
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE TABLE devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      friendly_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'online'
    );
    CREATE TABLE workflows (
      id UUID PRIMARY KEY,
      device_id UUID REFERENCES devices(id),
      status TEXT NOT NULL,
      completed_at TIMESTAMPTZ,
      error TEXT
    );
    CREATE TABLE jobs (
      id UUID PRIMARY KEY,
      device_id UUID REFERENCES devices(id),
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE command_log (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID REFERENCES jobs(id),
      command_raw TEXT NOT NULL
    );
  `);
  await db.query(fs.readFileSync(migrationPath, "utf8"));
}

async function insertDevice(db: Pool, deviceId: string, friendlyName: string): Promise<void> {
  await db.query(
    "INSERT INTO devices (id, friendly_name, status) VALUES ($1, $2, 'online')",
    [deviceId, friendlyName],
  );
}

async function insertWorkflow(
  db: Pool,
  workflowId: string,
  deviceId: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
): Promise<void> {
  await db.query(
    "INSERT INTO workflows (id, device_id, status) VALUES ($1, $2, $3)",
    [workflowId, deviceId, status],
  );
}

async function workflowStatus(db: Pool, workflowId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    "SELECT status FROM workflows WHERE id = $1",
    [workflowId],
  );
  return result.rows[0]?.status ?? null;
}

async function waitForWorkflowRowLockWait(db: Pool, workflowId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%FROM workflows%FOR UPDATE%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Cancellation did not reach the expected workflow row lock wait for ${workflowId}`);
}

async function rootExternalIdsByFifo(db: Pool, deviceId: string): Promise<string[]> {
  const result = await db.query<{ external_id: string }>(
    `SELECT external_id
     FROM device_execution_roots
     WHERE device_id = $1
     ORDER BY fifo_sequence ASC`,
    [deviceId],
  );
  return result.rows.map((row) => row.external_id);
}

async function rootRowsByFifo(db: Pool, deviceId: string): Promise<FifoRootRow[]> {
  const result = await db.query<{ external_id: string; fifo_sequence: string }>(
    `SELECT external_id, fifo_sequence::text AS fifo_sequence
     FROM device_execution_roots
     WHERE device_id = $1
     ORDER BY device_execution_roots.fifo_sequence ASC`,
    [deviceId],
  );
  return result.rows.map((row) => ({
    external_id: row.external_id,
    fifo_sequence: Number(row.fifo_sequence),
  }));
}

async function externalIdForRoot(db: Pool, rootId: string): Promise<string | null> {
  const result = await db.query<{ external_id: string | null }>(
    "SELECT external_id FROM device_execution_roots WHERE id = $1",
    [rootId],
  );
  return result.rows[0]?.external_id ?? null;
}

async function rootForExternalId(db: Pool, externalId: string): Promise<RootSummaryRow | null> {
  const result = await db.query<RootSummaryRow>(
    `SELECT id, device_id, external_id, state, owner_generation::int AS owner_generation
     FROM device_execution_roots
     WHERE external_id = $1`,
    [externalId],
  );
  return result.rows[0] ?? null;
}

async function operationFor(db: Pool, operationKind: string, operationId: string): Promise<OperationSummaryRow | null> {
  const result = await db.query<OperationSummaryRow>(
    `SELECT
       root_id,
       device_id,
       operation_id,
       owner_generation::int AS owner_generation,
       state,
       wire_type,
       wire_handle
     FROM device_execution_operations
     WHERE operation_kind = $1 AND operation_id = $2`,
    [operationKind, operationId],
  );
  return result.rows[0] ?? null;
}

async function stateForExternalId(db: Pool, externalId: string): Promise<DeviceExecutionState | null> {
  const result = await db.query<{ state: DeviceExecutionState }>(
    "SELECT state FROM device_execution_roots WHERE external_id = $1",
    [externalId],
  );
  return result.rows[0]?.state ?? null;
}

async function activeRootCount(db: Pool, deviceId?: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM device_execution_roots
     WHERE state = ANY($1::text[])
       AND ($2::uuid IS NULL OR device_id = $2::uuid)`,
    [ACTIVE_STATES, deviceId ?? null],
  );
  return result.rows[0]?.count ?? 0;
}

async function stateCount(db: Pool, state: DeviceExecutionState): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM device_execution_roots WHERE state = $1",
    [state],
  );
  return result.rows[0]?.count ?? 0;
}

async function eventCount(db: Pool, eventType: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM device_execution_events WHERE event_type = $1",
    [eventType],
  );
  return result.rows[0]?.count ?? 0;
}

async function eventTypes(db: Pool): Promise<string[]> {
  const result = await db.query<{ event_type: string }>(
    "SELECT event_type FROM device_execution_events ORDER BY id ASC",
  );
  return result.rows.map((row) => row.event_type);
}

async function columnsFor(db: Pool, tableName: string): Promise<Map<string, ColumnRow>> {
  const result = await db.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable, column_default, is_identity
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

async function constraintsFor(db: Pool, tableName: string): Promise<ConstraintRow[]> {
  const result = await db.query<ConstraintRow>(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = $1::regclass
     ORDER BY conname`,
    [tableName],
  );
  return result.rows;
}

async function indexesFor(db: Pool): Promise<Map<string, IndexRow>> {
  const result = await db.query<IndexRow>(
    `SELECT
       index_class.relname AS index_name,
       pg_index.indisunique,
       pg_get_expr(pg_index.indpred, pg_index.indrelid) AS predicate,
       pg_get_indexdef(pg_index.indexrelid) AS definition
     FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
     JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
     WHERE table_class.relname IN ('device_execution_roots', 'device_execution_events')
     ORDER BY index_class.relname`,
  );
  return new Map(result.rows.map((row) => [row.index_name, row]));
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
}

interface ConstraintRow {
  conname: string;
  contype: string;
  definition: string;
}

interface IndexRow {
  index_name: string;
  indisunique: boolean;
  predicate: string | null;
  definition: string;
}

interface FifoRootRow {
  external_id: string;
  fifo_sequence: number;
}

interface RootSummaryRow {
  id: string;
  device_id: string;
  external_id: string;
  state: DeviceExecutionState;
  owner_generation: number;
}

interface OperationSummaryRow {
  root_id: string;
  device_id: string;
  operation_id: string;
  owner_generation: number;
  state: string;
  wire_type: string | null;
  wire_handle: unknown;
}
