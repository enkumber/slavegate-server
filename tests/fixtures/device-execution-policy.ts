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
