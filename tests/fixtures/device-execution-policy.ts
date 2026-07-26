export const TEST_DEVICE_EXECUTION_BOUNDARIES = {
  standalone_job: boundary("job", "job", true, false, "device_execution", false),
  edge_batch: boundary("batch", "batch", true, false, "device_execution", false),
  edge_workflow: boundary("edge_workflow", "workflow", true, false, "device_execution", false),
  server_workflow_root: boundary("server_workflow", "workflow", true, true, "device_execution", false),
  server_workflow_batch_child: boundary("server_workflow", "batch", false, true, "device_execution", false),
  generated_child: boundary("server_workflow", "job", false, true, "device_execution", false),
  self_healing_child: boundary("server_workflow", "job", false, true, "device_execution", false),
  prestep_child: boundary("server_workflow", "job", false, true, "device_execution", false),
  recovery_child: boundary("server_workflow", "job", false, true, "device_execution", false),
  control_egress: boundary("control", "control", false, false, "control", true),
} as const;

export const TEST_DEVICE_EXECUTION_MULTI_WORKER_POLICY = {
  authority: "postgres",
  ownershipToken: "root_id_device_id_owner_generation",
  terminalCas: "device_root_generation",
  websocketOwnership: "single_active_connection_observed",
} as const;

export const TEST_DEVICE_EXECUTION_RESOURCE_POLICY = {
  observeMode: false,
  boundaries: TEST_DEVICE_EXECUTION_BOUNDARIES,
  rootKinds: {
    job: { operationKind: "job", wireType: "JOB" },
    batch: { operationKind: "batch", wireType: "BATCH_START" },
    edge_workflow: { operationKind: "workflow", wireType: "WORKFLOW_START" },
    server_workflow: { operationKind: "workflow", wireType: "WORKFLOW_START" },
    control: { operationKind: "control", wireType: "CONTROL" },
    unknown: { operationKind: "job", wireType: null },
  },
} as const;

function boundary(
  rootKind: string,
  operationKind: string,
  retainsRootUntilTerminal: boolean,
  requiresExistingRootHandle: boolean,
  egressLane: string,
  mayBypassDeviceQueue: boolean,
) {
  return {
    rootKind,
    operationKind,
    retainsRootUntilTerminal,
    requiresExistingRootHandle,
    egressLane,
    mayBypassDeviceQueue,
  };
}

export async function configureDeviceExecutionLifecycleFixture(
  pool: Pool,
  repoRoot: string,
  fixturePrefix = "device_execution",
): Promise<void> {
  for (const relativePath of [
    "src/db/migrations/105_generic_resource_lifecycle.sql",
    "src/db/migrations/107_lifecycle_resource_bindings.sql",
    "src/db/migrations/110_generic_lifecycle_queries.sql",
    "src/db/migrations/111_multi_column_lifecycle_bindings.sql",
    "src/db/migrations/114_lifecycle_resource_policies.sql",
  ]) {
    await pool.query(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
  }

  const rootLifecycle = `${fixturePrefix}_root`;
  const operationLifecycle = `${fixturePrefix}_operation`;
  await pool.query(
    `INSERT INTO lifecycle_state_definitions
       (lifecycle_key, status, initial, terminal, retryable, administrative,
        dispatchable, manual, sort_order)
     VALUES
       ($1, 'queued', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 10),
       ($1, 'claimed', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
       ($1, 'dispatching', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 30),
       ($1, 'dispatched', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 40),
       ($1, 'blocked', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 50),
       ($1, 'reconciling', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 60),
       ($1, 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 70),
       ($1, 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 80),
       ($1, 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 90),
       ($2, 'registered', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 10),
       ($2, 'dispatching', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 20),
       ($2, 'dispatched', FALSE, FALSE, FALSE, FALSE, TRUE, FALSE, 30),
       ($2, 'rejected', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE, 40),
       ($2, 'blocked', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 50),
       ($2, 'reconciling', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, 60),
       ($2, 'completed', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 70),
       ($2, 'failed', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 80),
       ($2, 'cancelled', FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, 90)
     ON CONFLICT (lifecycle_key, status) DO NOTHING`,
    [rootLifecycle, operationLifecycle],
  );
  await pool.query(
    `INSERT INTO lifecycle_transitions
       (lifecycle_key, action_key, from_status, to_status, manual_allowed,
        external_allowed, automatic, mark_started, mark_completed, clear_failure)
     VALUES
       ($1, 'claim', 'queued', 'claimed', FALSE, FALSE, TRUE, TRUE, FALSE, FALSE),
       ($1, 'begin_dispatch', 'queued', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'observe_dispatch', 'queued', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'dispatch_claimed', 'claimed', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'observe_claimed_dispatch', 'claimed', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'finish_dispatch', 'dispatching', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'reconcile_claimed', 'claimed', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'block_dispatching', 'dispatching', 'blocked', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'reconcile_dispatched', 'dispatched', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($1, 'complete_claimed', 'claimed', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'fail_claimed', 'claimed', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'complete_dispatching', 'dispatching', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'fail_dispatching', 'dispatching', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'complete_dispatched', 'dispatched', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'fail_dispatched', 'dispatched', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($1, 'cancel_queued', 'queued', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE),
       ($2, 'begin_dispatch', 'registered', 'dispatching', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'observe_dispatch', 'registered', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'reject_send', 'registered', 'rejected', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'finish_dispatch', 'dispatching', 'dispatched', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'block_dispatching', 'dispatching', 'blocked', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'reconcile_dispatched', 'dispatched', 'reconciling', FALSE, FALSE, TRUE, FALSE, FALSE, FALSE),
       ($2, 'complete_dispatching', 'dispatching', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($2, 'fail_dispatching', 'dispatching', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($2, 'complete_dispatched', 'dispatched', 'completed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($2, 'fail_dispatched', 'dispatched', 'failed', FALSE, TRUE, TRUE, FALSE, TRUE, FALSE),
       ($2, 'cancel_registered', 'registered', 'cancelled', TRUE, FALSE, FALSE, FALSE, TRUE, FALSE)
     ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING`,
    [rootLifecycle, operationLifecycle],
  );
  await pool.query(
    `SELECT configure_lifecycle_resource_binding(
       'device_execution_roots'::regclass, $1, 'state'
     )`,
    [rootLifecycle],
  );
  await pool.query(
    `SELECT configure_lifecycle_resource_binding(
       'device_execution_operations'::regclass, $1, 'state'
     )`,
    [operationLifecycle],
  );
  await pool.query(
    `INSERT INTO lifecycle_resource_policies
       (resource_table, state_column, policy, updated_by)
     VALUES ('device_execution_roots'::regclass, 'state', $1::jsonb, 'test-fixture')
     ON CONFLICT (resource_table, state_column) DO UPDATE
       SET policy = EXCLUDED.policy,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [JSON.stringify(TEST_DEVICE_EXECUTION_RESOURCE_POLICY)],
  );
}
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
