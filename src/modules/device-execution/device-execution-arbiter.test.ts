import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  DeviceExecutionArbiter,
  DeviceExecutionSchemaError,
  decodeDeviceExecutionHandle,
  encodeDeviceExecutionHandle,
  getDeviceExecutionBoundaryPolicy,
  type DeviceExecutionRootKind,
  type DeviceExecutionOperationKind,
  type DeviceExecutionOperationState,
  type DeviceExecutionState,
} from "./device-execution-arbiter";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

const boundaryFixture = {
  standalone_job: { rootKind: "job", operationKind: "job", retainsRootUntilTerminal: true, requiresExistingRootHandle: false, egressLane: "device_execution", mayBypassDeviceQueue: false },
  edge_batch: { rootKind: "batch", operationKind: "batch", retainsRootUntilTerminal: true, requiresExistingRootHandle: false, egressLane: "device_execution", mayBypassDeviceQueue: false },
  edge_workflow: { rootKind: "edge_workflow", operationKind: "workflow", retainsRootUntilTerminal: true, requiresExistingRootHandle: false, egressLane: "device_execution", mayBypassDeviceQueue: false },
  server_workflow_root: { rootKind: "server_workflow", operationKind: "workflow", retainsRootUntilTerminal: true, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  server_workflow_batch_child: { rootKind: "server_workflow", operationKind: "batch", retainsRootUntilTerminal: false, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  generated_child: { rootKind: "server_workflow", operationKind: "job", retainsRootUntilTerminal: false, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  self_healing_child: { rootKind: "server_workflow", operationKind: "job", retainsRootUntilTerminal: false, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  prestep_child: { rootKind: "server_workflow", operationKind: "job", retainsRootUntilTerminal: false, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  recovery_child: { rootKind: "server_workflow", operationKind: "job", retainsRootUntilTerminal: false, requiresExistingRootHandle: true, egressLane: "device_execution", mayBypassDeviceQueue: false },
  control_egress: { rootKind: "control", operationKind: "control", retainsRootUntilTerminal: false, requiresExistingRootHandle: false, egressLane: "control", mayBypassDeviceQueue: true },
};

interface RootRow {
  id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  external_id: string | null;
  request_key: string | null;
  state: DeviceExecutionState;
  fifo_sequence: number;
  owner_generation: number;
  observe_mode: boolean;
  claimed_at: Date | null;
  dispatching_at: Date | null;
  dispatched_at: Date | null;
  terminal_at: Date | null;
  reconciliation_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  root_id: string | null;
  device_id: string | null;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  actor: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}

interface OperationRow {
  id: number;
  root_id: string;
  device_id: string;
  root_kind: DeviceExecutionRootKind;
  operation_kind: DeviceExecutionOperationKind;
  operation_id: string;
  owner_generation: number;
  state: DeviceExecutionOperationState;
  egress_lane: "device_execution" | "control" | "admin";
  wire_type: string | null;
  wire_handle: Record<string, unknown>;
  metadata: Record<string, unknown>;
  dispatching_at: Date | null;
  dispatched_at: Date | null;
  terminal_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowRow {
  id: string;
  device_id: string | null;
  status: "queued" | "running" | "cancelled";
}

function root(overrides: Partial<RootRow> = {}): RootRow {
  const state = overrides.state ?? "queued";
  const progressed = !["queued"].includes(state);
  const dispatching = ["dispatching", "dispatched", "reconciling", "blocked", "completed", "failed", "cancelled"].includes(state);
  const dispatched = ["dispatched", "reconciling", "blocked", "completed", "failed", "cancelled"].includes(state);
  const terminal = ["completed", "failed", "cancelled"].includes(state);
  return {
    id: overrides.id ?? `root-${Math.random().toString(16).slice(2)}`,
    device_id: overrides.device_id ?? DEVICE_A,
    root_kind: overrides.root_kind ?? "job",
    external_id: overrides.external_id ?? null,
    request_key: overrides.request_key ?? null,
    state,
    fifo_sequence: overrides.fifo_sequence ?? 1,
    owner_generation: overrides.owner_generation ?? 0,
    observe_mode: overrides.observe_mode ?? true,
    claimed_at: overrides.claimed_at ?? (progressed ? new Date("2026-07-15T19:30:10.000Z") : null),
    dispatching_at: overrides.dispatching_at ?? (dispatching ? new Date("2026-07-15T19:30:20.000Z") : null),
    dispatched_at: overrides.dispatched_at ?? (dispatched ? new Date("2026-07-15T19:30:30.000Z") : null),
    terminal_at: overrides.terminal_at ?? (terminal ? new Date("2026-07-15T19:30:40.000Z") : null),
    reconciliation_reason: overrides.reconciliation_reason ?? (["reconciling", "blocked"].includes(state) ? "fixture" : null),
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? new Date("2026-07-15T19:30:00.000Z"),
    updated_at: overrides.updated_at ?? new Date("2026-07-15T19:30:00.000Z"),
  };
}

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  const state = overrides.state ?? "registered";
  const dispatching = ["dispatching", "dispatched", "reconciling", "blocked", "completed", "failed", "cancelled", "rejected"].includes(state);
  const dispatched = ["dispatched", "reconciling", "blocked", "completed", "failed", "cancelled"].includes(state);
  const terminal = ["completed", "failed", "cancelled"].includes(state);
  return {
    id: overrides.id ?? 1,
    root_id: overrides.root_id ?? "root-1",
    device_id: overrides.device_id ?? DEVICE_A,
    root_kind: overrides.root_kind ?? "job",
    operation_kind: overrides.operation_kind ?? "job",
    operation_id: overrides.operation_id ?? "job-1",
    owner_generation: overrides.owner_generation ?? 0,
    state,
    egress_lane: overrides.egress_lane ?? "device_execution",
    wire_type: overrides.wire_type ?? null,
    wire_handle: overrides.wire_handle ?? {},
    metadata: overrides.metadata ?? {},
    dispatching_at: overrides.dispatching_at ?? (dispatching ? new Date("2026-07-15T19:30:20.000Z") : null),
    dispatched_at: overrides.dispatched_at ?? (dispatched ? new Date("2026-07-15T19:30:30.000Z") : null),
    terminal_at: overrides.terminal_at ?? (terminal ? new Date("2026-07-15T19:30:40.000Z") : null),
    created_at: overrides.created_at ?? new Date("2026-07-15T19:30:00.000Z"),
    updated_at: overrides.updated_at ?? new Date("2026-07-15T19:30:00.000Z"),
  };
}

class FakeClient {
  roots: RootRow[] = [];
  operations: OperationRow[] = [];
  events: EventRow[] = [];
  workflows: WorkflowRow[] = [];
  committed = false;
  rolledBack = false;
  private nextRoot = 1;
  private nextOperation = 1;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
    if (normalized === "COMMIT") {
      this.committed = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.rolledBack = true;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };

    if (normalized.startsWith("SELECT policy FROM lifecycle_resource_policies")) {
      return {
        rows: [{
          policy: {
            observeMode: true,
            boundaries: boundaryFixture,
            rootKinds: {
              job: { operationKind: "job", wireType: "JOB" },
              batch: { operationKind: "batch", wireType: "BATCH_START" },
              edge_workflow: { operationKind: "workflow", wireType: "WORKFLOW_START" },
              server_workflow: { operationKind: "workflow", wireType: "WORKFLOW_START" },
              control: { operationKind: "control", wireType: "CONTROL" },
            },
            control: {
              allowedKinds: ["kill_switch", "auth_revoke", "workflow_cancel", "model_config_update", "ota_update"],
              mayBypassDeviceQueue: true,
            },
          },
        }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith("SELECT state.lifecycle_key, state.status") &&
        normalized.includes("FROM lifecycle_resource_bindings binding")) {
      const [tableName, status] = params as [string, string];
      const initial = tableName === "device_execution_roots" ? status === "queued" : status === "registered";
      const terminal = ["completed", "failed", "cancelled"].includes(status);
      return {
        rows: [{
          lifecycle_key: tableName,
          status,
          initial,
          terminal,
          retryable: false,
          administrative: status === "cancelled",
          dispatchable: !terminal,
          manual: ["reconciling", "blocked"].includes(status),
          stale_after_ms: null,
          stale_action_key: null,
          description: null,
          metadata: {},
        }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith("SELECT transition.lifecycle_key, transition.action_key") &&
        normalized.includes("FROM lifecycle_resource_bindings binding")) {
      const [tableName, fromStatus, selectorJson] = params as [string, string, string];
      const selector = JSON.parse(selectorJson) as Record<string, unknown>;
      if (selector.targetTerminal !== true) return { rows: [], rowCount: 0 };
      const toStatus = selector.targetAdministrative === true
        ? "cancelled"
        : selector.targetRetryable === true
          ? "failed"
          : "completed";
      return {
        rows: [{
          lifecycle_key: tableName,
          action_key: `test_${fromStatus}_${toStatus}`,
          from_status: fromStatus,
          to_status: toStatus,
          manual_allowed: true,
          external_allowed: true,
          automatic: true,
          mark_started: false,
          mark_completed: true,
          clear_completed: false,
          clear_failure: selector.targetRetryable !== true,
          reset_retry: false,
          metadata: {},
        }],
        rowCount: 1,
      };
    }

    if (normalized.startsWith("SELECT id, device_id, status, lifecycle_key FROM workflows WHERE id = $1 FOR UPDATE")) {
      const [workflowId] = params as [string];
      const found = this.workflows.find((item) => item.id === workflowId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT 1 FROM lifecycle_transitions transition") &&
        normalized.includes("target.terminal") &&
        normalized.includes("target.administrative")) {
      const [, fromStatus] = params as [string, string];
      return fromStatus === "queued"
        ? { rows: [{ exists: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("WITH locked AS ( SELECT workflow.*") &&
        normalized.includes("UPDATE workflows workflow")) {
      const [workflowId, , selectorJson] = params as [string, string, string];
      const selector = JSON.parse(selectorJson) as Record<string, unknown>;
      const found = this.workflows.find((item) =>
        item.id === workflowId &&
        item.status === "queued" &&
        selector.targetTerminal === true &&
        selector.targetAdministrative === true &&
        selector.transitionManualAllowed === true
      );
      if (!found) return { rows: [], rowCount: 0 };
      found.status = "cancelled";
      return { rows: [{ ...found }], rowCount: 1 };
    }

    if (normalized.startsWith("SELECT * FROM device_execution_roots WHERE root_kind = $1 AND external_id = $2")) {
      const [rootKind, externalId] = params as [DeviceExecutionRootKind, string];
      const found = this.roots.find((item) => item.root_kind === rootKind && item.external_id === externalId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT * FROM device_execution_roots WHERE id = $1 LIMIT 1")) {
      const [rootId] = params as [string];
      const found = this.roots.find((item) => item.id === rootId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT * FROM device_execution_operations WHERE operation_kind = $1 AND operation_id = $2")) {
      const [operationKind, operationId] = params as [DeviceExecutionOperationKind, string];
      const found = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.includes("WHERE device_id = $1") &&
        normalized.includes("lifecycle_state_matches(") &&
        normalized.includes("'\"initial\":false,\"terminal\":false'".slice(1, -1))) {
      const [deviceId] = params as [string];
      const found = this.roots.find((item) => item.device_id === deviceId && ["claimed", "dispatching", "dispatched", "reconciling", "blocked"].includes(item.state));
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.includes("WHERE device_id = $1") &&
        normalized.includes("lifecycle_state_matches(") &&
        normalized.includes('"initial":true')) {
      const [deviceId] = params as [string];
      const found = this.roots
        .filter((item) => item.device_id === deviceId && item.state === "queued")
        .sort((a, b) => a.fifo_sequence - b.fifo_sequence)[0];
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_roots")) {
      const [deviceId, rootKind, externalId, requestKey, metadata] = params as [string, DeviceExecutionRootKind, string | null, string | null, string];
      const inserted = root({
        id: `root-${this.nextRoot++}`,
        device_id: deviceId,
        root_kind: rootKind,
        external_id: externalId,
        request_key: requestKey,
        fifo_sequence: this.nextRoot,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      this.roots.push(inserted);
      return { rows: [inserted], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_operations")) {
      const [
        rootId,
        deviceId,
        rootKind,
        operationKind,
        operationId,
        ownerGeneration,
        state,
        egressLane,
        wireType,
        wireHandle,
        metadata,
      ] = params as [string, string, DeviceExecutionRootKind, DeviceExecutionOperationKind, string, number, DeviceExecutionOperationState, "device_execution", string | null, string, string];
      const existing = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId);
      if (existing) {
        if (existing.root_id === rootId) {
          if (existing.state === "registered") {
            existing.owner_generation = Number(ownerGeneration);
            existing.state = state ?? "registered";
            existing.wire_handle = JSON.parse(wireHandle) as Record<string, unknown>;
          }
          existing.egress_lane = egressLane;
          existing.wire_type = wireType ?? existing.wire_type;
          existing.metadata = { ...existing.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
          existing.updated_at = new Date("2026-07-15T19:31:00.000Z");
          return { rows: [existing], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      const inserted = operation({
        id: this.nextOperation++,
        root_id: rootId,
        device_id: deviceId,
        root_kind: rootKind,
        operation_kind: operationKind,
        operation_id: operationId,
        owner_generation: Number(ownerGeneration),
        state: state ?? "registered",
        egress_lane: egressLane,
        wire_type: wireType,
        wire_handle: JSON.parse(wireHandle) as Record<string, unknown>,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      this.operations.push(inserted);
      return { rows: [inserted], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("SET state = 'cancelled'") && normalized.includes("AND state = 'queued'")) {
      const [reason, metadata, rootId, deviceId, ownerGeneration] = params as [string, string, string, string, number];
      const found = this.roots.find((item) => item.id === rootId && item.device_id === deviceId && item.owner_generation === ownerGeneration && item.state === "queued");
      if (!found) return { rows: [], rowCount: 0 };
      found.state = "cancelled";
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.terminalReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("terminal_reason = $2")) {
      const [toState, reason, metadata, rootId, deviceId, ownerGeneration] = params as [DeviceExecutionState, string, string, string, string, number];
      const found = this.roots.find((item) => item.id === rootId && item.device_id === deviceId && item.owner_generation === ownerGeneration && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      if (toState === "dispatching") {
        found.dispatching_at = new Date("2026-07-15T19:31:00.000Z");
      }
      if (toState === "dispatched") {
        found.dispatching_at ??= new Date("2026-07-15T19:31:00.000Z");
        found.dispatched_at = new Date("2026-07-15T19:31:00.000Z");
      }
      found.terminal_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.terminalReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") &&
        normalized.includes("state = lifecycle_transition_target(") &&
        normalized.includes("terminal_reason = $1")) {
      const [reason, metadata, rootId, deviceId, ownerGeneration] = params as [string, string, string, string, number];
      const found = this.roots.find((item) =>
        item.id === rootId &&
        item.device_id === deviceId &&
        item.owner_generation === ownerGeneration &&
        item.state === "queued"
      );
      if (!found) return { rows: [], rowCount: 0 };
      found.state = "cancelled";
      found.terminal_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.metadata.terminalReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots") && normalized.includes("reconciliation_reason = $2")) {
      const [toState, reason, metadata, rootId, deviceId, ownerGeneration] = params as [DeviceExecutionState, string, string, string, string, number];
      const found = this.roots.find((item) => item.id === rootId && item.device_id === deviceId && item.owner_generation === ownerGeneration && !["completed", "failed", "cancelled"].includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      found.reconciliation_reason = reason;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      found.metadata.reconciliationReason = reason;
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_operations") &&
        normalized.includes("WHERE root_id = $1") &&
        normalized.includes('"initial":true')) {
      const [rootId, ownerGeneration, metadata] = params as [string, number, string];
      const found = this.operations.filter((item) => item.root_id === rootId && item.state === "registered");
      for (const item of found) {
        item.state = "cancelled";
        item.terminal_at = new Date("2026-07-15T19:31:00.000Z");
        item.owner_generation = ownerGeneration;
        item.metadata = { ...item.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
        item.updated_at = new Date("2026-07-15T19:31:00.000Z");
      }
      return { rows: found, rowCount: found.length };
    }

    if (normalized.startsWith("UPDATE device_execution_operations")) {
      const [toState, ownerGeneration, metadata, wireHandle, operationKind, operationId, fromStates] = params as [
        DeviceExecutionOperationState,
        number | null,
        string,
        string | null,
        DeviceExecutionOperationKind,
        string,
        DeviceExecutionOperationState[],
      ];
      const found = this.operations.find((item) => item.operation_kind === operationKind && item.operation_id === operationId && fromStates.includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      if (toState === "dispatching") {
        found.dispatching_at = new Date("2026-07-15T19:31:00.000Z");
      }
      if (toState === "dispatched") {
        found.dispatching_at ??= new Date("2026-07-15T19:31:00.000Z");
        found.dispatched_at = new Date("2026-07-15T19:31:00.000Z");
      }
      if (["completed", "failed", "cancelled"].includes(toState)) {
        found.terminal_at = new Date("2026-07-15T19:31:00.000Z");
      }
      if (ownerGeneration !== null) found.owner_generation = ownerGeneration;
      if (wireHandle !== null) found.wire_handle = JSON.parse(wireHandle) as Record<string, unknown>;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE device_execution_roots")) {
      const [toState, increment, metadata, rootId, fromStates] = params as [DeviceExecutionState, number, string, string, DeviceExecutionState[]];
      const found = this.roots.find((item) => item.id === rootId && fromStates.includes(item.state));
      if (!found) return { rows: [], rowCount: 0 };
      found.state = toState;
      if (toState === "claimed") found.claimed_at = new Date("2026-07-15T19:31:00.000Z");
      if (toState === "dispatching") found.dispatching_at = new Date("2026-07-15T19:31:00.000Z");
      if (toState === "dispatched") found.dispatched_at = new Date("2026-07-15T19:31:00.000Z");
      found.owner_generation += increment;
      found.metadata = { ...found.metadata, ...(JSON.parse(metadata) as Record<string, unknown>) };
      found.updated_at = new Date("2026-07-15T19:31:00.000Z");
      return { rows: [found], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO device_execution_events")) {
      const [rootId, deviceId, eventType, previousState, newState, actor, reason, metadata] = params as [
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
      ];
      this.events.push({
        root_id: rootId,
        device_id: deviceId,
        event_type: eventType,
        previous_state: previousState,
        new_state: newState,
        actor,
        reason,
        metadata: JSON.parse(metadata) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("WITH candidates AS ( SELECT id, device_id, state AS previous_state") &&
        normalized.includes("lifecycle_transition_target(") &&
        normalized.includes("startup_reconciled_root")) {
      const [reason, actor, metadata] = params as [string, string, string];
      const patch = JSON.parse(metadata) as Record<string, unknown>;
      const candidates = this.roots.filter((item) => ["claimed", "dispatching", "dispatched"].includes(item.state));
      for (const item of candidates) {
        const previous = item.state;
        item.state = "reconciling";
        item.metadata = { ...item.metadata, ...patch };
        item.metadata.reconciliationReason = reason;
        for (const op of this.operations.filter((entry) => entry.root_id === item.id && ["registered", "dispatching", "dispatched"].includes(entry.state))) {
          op.state = "reconciling";
          op.metadata = { ...op.metadata, ...patch };
        }
        this.events.push({
          root_id: item.id,
          device_id: item.device_id,
          event_type: "startup_reconciled_root",
          previous_state: previous,
          new_state: "reconciling",
          actor,
          reason,
          metadata: patch,
        });
      }
      return { rows: candidates.map((item) => ({ id: item.id })), rowCount: candidates.length };
    }

    if (normalized.startsWith("SELECT COUNT(*)::text AS count FROM device_execution_roots WHERE") &&
        normalized.includes('"manual":true,"terminal":false')) {
      const count = this.roots.filter((item) => ["reconciling", "blocked"].includes(item.state)).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in fake client: ${normalized}`);
  }

  release(): void {
    return undefined;
  }
}

function arbiterFor(client: FakeClient): DeviceExecutionArbiter {
  return new DeviceExecutionArbiter(() => ({
    connect: async () => client as any,
    query: client.query.bind(client) as any,
  }) as any);
}

describe("DeviceExecutionArbiter observe mode", () => {
  it("admits a root but reports that it would wait when the device already has an active root", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "active-root", external_id: "job-active", state: "dispatched" }));

    const result = await arbiterFor(client).observeAdmission({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-next",
      metadata: { jobType: "open_app" },
    });

    expect(result.decision).toBe("would_wait");
    expect(result.activeRootId).toBe("active-root");
    expect(client.roots.find((item) => item.external_id === "job-next")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["root_admitted", "observe_would_wait"]);
    expect(client.committed).toBe(true);
  });

  it("claims only the oldest queued root and leaves later roots queued", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "later", external_id: "job-later", fifo_sequence: 20 }),
      root({ id: "oldest", external_id: "job-oldest", fifo_sequence: 10 }),
    );

    const permit = await arbiterFor(client).claimNextRoot({ deviceId: DEVICE_A });

    expect(permit).toMatchObject({ rootId: "oldest", deviceId: DEVICE_A, ownerGeneration: 1, state: "claimed" });
    expect(client.roots.find((item) => item.id === "oldest")?.state).toBe("claimed");
    expect(client.roots.find((item) => item.id === "later")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["root_claimed"]);

    await expect(arbiterFor(client).claimNextRoot({ deviceId: DEVICE_A })).resolves.toBeNull();
  });

  it("records a would-block dispatch without advancing a second active root in observe mode", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "active-root", external_id: "job-active", state: "dispatched" }),
      root({ id: "queued-root", external_id: "job-next", state: "queued", fifo_sequence: 2 }),
    );

    const result = await arbiterFor(client).observeDispatch({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-next",
      sent: true,
      metadata: { jobType: "screenshot" },
    });

    expect(result.decision).toBe("would_wait");
    expect(client.roots.find((item) => item.id === "queued-root")?.state).toBe("queued");
    expect(client.events.map((event) => event.event_type)).toEqual(["observe_would_block_dispatch"]);
  });

  it("rejects wrong-device results and ignores duplicate terminal results", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-1", external_id: "job-1", state: "dispatched", device_id: DEVICE_A }));

    const wrongDevice = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_B,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(wrongDevice.decision).toBe("rejected");
    expect(client.roots[0].state).toBe("dispatched");

    const completed = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(completed.decision).toBe("terminal");
    expect(client.roots[0].state).toBe("completed");

    const duplicate = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "failed",
    });
    expect(duplicate.decision).toBe("rejected");
    expect(client.roots[0].state).toBe("completed");
    expect(client.events.map((event) => event.event_type)).toEqual([
      "result_rejected_wrong_device",
      "root_terminal",
      "duplicate_or_late_result",
    ]);
  });

  it("moves ambiguous non-terminal roots to blocked but leaves terminal roots untouched", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "root-1", external_id: "job-1", state: "dispatched", device_id: DEVICE_A }),
      root({ id: "root-2", external_id: "job-2", state: "completed", device_id: DEVICE_A }),
    );

    const blocked = await arbiterFor(client).markAmbiguous({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      reason: "job_timeout",
    });
    expect(blocked.decision).toBe("ambiguous");
    expect(client.roots.find((item) => item.id === "root-1")?.state).toBe("blocked");

    const ignored = await arbiterFor(client).markAmbiguous({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-2",
      reason: "late_timeout",
    });
    expect(ignored.decision).toBe("ignored");
    expect(client.roots.find((item) => item.id === "root-2")?.state).toBe("completed");
  });

  it("uses the operation ledger handle for terminal generation CAS", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-1", external_id: "job-1", state: "dispatched", owner_generation: 2 }));
    client.operations.push(operation({
      id: 10,
      root_id: "root-1",
      operation_id: "job-1",
      owner_generation: 2,
      state: "dispatched",
      wire_handle: encodeDeviceExecutionHandle({
        rootId: "root-1",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 2,
        operationKind: "job",
        operationId: "job-1",
      }) as unknown as Record<string, unknown>,
    }));

    const stale = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      ownerGeneration: 1,
      status: "completed",
    });
    expect(stale.decision).toBe("rejected");
    expect(stale.reason).toBe("owner_generation_mismatch");
    expect(client.roots[0].state).toBe("dispatched");

    const completed = await arbiterFor(client).observeTerminal({
      deviceId: DEVICE_A,
      rootKind: "job",
      externalId: "job-1",
      status: "completed",
    });
    expect(completed.decision).toBe("terminal");
    expect(client.roots[0].state).toBe("completed");
    expect(client.operations[0].state).toBe("completed");
    expect(decodeDeviceExecutionHandle(completed.operation?.wireHandle)).toMatchObject({
      rootId: "root-1",
      ownerGeneration: 2,
      operationId: "job-1",
    });
  });

  it("runs the observed async egress path with dispatching before waiter and wire completion", async () => {
    const client = new FakeClient();
    const order: string[] = [];

    const result = await arbiterFor(client).runObservedEgress({
      deviceId: DEVICE_A,
      rootKind: "job",
      operationId: "job-egress",
      wireType: "JOB",
      registerWaiter: (handle) => {
        order.push(`waiter:${handle.ownerGeneration}`);
      },
      wireDispatch: (handle) => {
        order.push(`wire:${handle.ownerGeneration}`);
        return true;
      },
      metadata: { jobType: "screenshot" },
    });

    expect(result.decision).toBe("dispatched");
    expect(result.sent).toBe(true);
    expect(order).toEqual(["waiter:1", "wire:1"]);
    expect(client.roots[0]).toMatchObject({ external_id: "job-egress", state: "dispatched", owner_generation: 1 });
    expect(client.operations[0]).toMatchObject({ operation_id: "job-egress", state: "dispatched", owner_generation: 1 });
    expect(client.events.map((event) => event.event_type)).toEqual([
      "implicit_admission",
      "root_dispatching",
      "root_dispatched",
    ]);
  });

  it("keeps observed BATCH/WORKFLOW roots FIFO-ordered before waiter and wire", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "batch-older-root", root_kind: "batch", external_id: "batch-older", fifo_sequence: 1 }),
      root({ id: "batch-later-root", root_kind: "batch", external_id: "batch-later", fifo_sequence: 2 }),
    );
    const registerWaiter = vi.fn();
    const wireDispatch = vi.fn(() => true);

    const result = await arbiterFor(client).runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "edge_batch",
      operationId: "batch-later",
      wireType: "BATCH_START",
      registerWaiter,
      wireDispatch,
    });

    expect(result).toMatchObject({
      decision: "would_wait",
      sent: false,
      activeRootId: "batch-older-root",
      reason: "older_queued_root_exists",
    });
    expect(registerWaiter).not.toHaveBeenCalled();
    expect(wireDispatch).not.toHaveBeenCalled();
  });

  it("fails observed egress closed when waiter registration collides", async () => {
    const client = new FakeClient();
    const wireDispatch = vi.fn(() => true);
    const result = await arbiterFor(client).runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "edge_batch",
      operationId: "batch-waiter-collision",
      wireType: "BATCH_START",
      registerWaiter: () => { throw new Error("collision"); },
      wireDispatch,
    });

    expect(result).toMatchObject({
      decision: "offline",
      sent: false,
      reason: "waiter_registration_failed: collision",
    });
    expect(wireDispatch).not.toHaveBeenCalled();
    expect(client.roots[0].state).toBe("blocked");
    expect(client.operations[0].state).toBe("blocked");
    expect(client.events.at(-1)?.event_type).toBe("egress_not_sent_fail_closed");
  });

  it("does not regress a fast BATCH terminal result after wireDispatch returns", async () => {
    const client = new FakeClient();
    const arbiter = arbiterFor(client);
    const result = await arbiter.runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "edge_batch",
      operationId: "batch-fast",
      wireType: "BATCH_START",
      registerWaiter: () => undefined,
      wireDispatch: async (handle) => {
        const terminal = await arbiter.observeTerminal({
          deviceId: DEVICE_A,
          handle,
          status: "completed",
          actor: "test.fast_batch",
        });
        expect(terminal.decision).toBe("terminal");
        return true;
      },
    });

    expect(result).toMatchObject({ decision: "terminal", sent: true, reason: "result_already_terminal" });
    expect(client.roots[0].state).toBe("completed");
    expect(client.operations[0].state).toBe("completed");
    expect(client.events.at(-1)?.event_type).toBe("dispatch_completion_after_terminal");
  });

  it("authorizes standalone job egress only for the FIFO head and sends with a typed permit", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "older-root", external_id: "job-older", fifo_sequence: 1 }),
      root({ id: "later-root", external_id: "job-later", fifo_sequence: 2 }),
    );
    const order: string[] = [];

    const later = await arbiterFor(client).runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "job-later",
      registerWaiter: () => {
        order.push("later-waiter");
      },
      wireDispatch: () => {
        order.push("later-wire");
        return true;
      },
    });
    expect(later).toMatchObject({ decision: "would_wait", sent: false, reason: "older_queued_root_exists" });
    expect(order).toEqual([]);
    expect(client.roots.find((item) => item.id === "later-root")?.state).toBe("queued");

    const older = await arbiterFor(client).runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "job-older",
      registerWaiter: (permit) => {
        order.push(`waiter:${permit.kind}:${permit.handle.ownerGeneration}`);
        expect(permit.wireHandle).toEqual(encodeDeviceExecutionHandle(permit.handle));
      },
      wireDispatch: (permit) => {
        order.push(`wire:${permit.handle.operationId}:${permit.handle.ownerGeneration}`);
        return true;
      },
    });

    expect(older.decision).toBe("dispatched");
    expect(older.sent).toBe(true);
    expect(order).toEqual([
      "waiter:device_execution_job_dispatch_permit:1",
      "wire:job-older:1",
    ]);
    expect(client.roots.find((item) => item.id === "older-root")).toMatchObject({ state: "dispatched", owner_generation: 1 });
    expect(decodeDeviceExecutionHandle(client.operations.find((item) => item.operation_id === "job-older")?.wire_handle)).toMatchObject({
      rootId: "older-root",
      operationId: "job-older",
      ownerGeneration: 1,
    });
  });

  it("blocks a standalone job root when raw dispatch fails after the waiter is registered", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-1", external_id: "job-1", fifo_sequence: 1 }));
    const order: string[] = [];

    const result = await arbiterFor(client).runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "job-1",
      registerWaiter: () => {
        order.push("waiter");
      },
      wireDispatch: () => {
        order.push("wire");
        return false;
      },
    });

    expect(result).toMatchObject({ decision: "offline", sent: false });
    expect(order).toEqual(["waiter", "wire"]);
    expect(client.roots[0].state).toBe("blocked");
    expect(client.operations[0].state).toBe("blocked");
    expect(client.events.map((event) => event.event_type)).toEqual([
      "root_dispatching",
      "egress_not_sent_fail_closed",
    ]);
  });

  it("accepts a job result only for the current dispatched owner", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "root-accepted",
      external_id: "job-accepted",
      state: "dispatched",
      owner_generation: 3,
    }));
    client.operations.push(operation({
      root_id: "root-accepted",
      operation_id: "job-accepted",
      state: "dispatched",
      owner_generation: 3,
      wire_handle: encodeDeviceExecutionHandle({
        rootId: "root-accepted",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 3,
        operationKind: "job",
        operationId: "job-accepted",
      }) as unknown as Record<string, unknown>,
    }));

    const result = await arbiterFor(client).acceptJobResult({
      deviceId: DEVICE_A,
      jobId: "job-accepted",
      reportedHandle: {
        rootId: "root-accepted",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 3,
        operationKind: "job",
        operationId: "job-accepted",
      },
      success: true,
      actor: "test",
    });

    expect(result).toMatchObject({ accepted: true, decision: "terminal" });
    expect(client.roots[0]).toMatchObject({ state: "completed", owner_generation: 3 });
    expect(client.operations[0]).toMatchObject({ state: "completed", owner_generation: 3 });
    expect(client.events.map((event) => event.event_type)).toEqual(["job_result_accepted"]);
  });

  it("rejects duplicate, late, or wrong-device job results without mutating root and operation ledgers", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "root-late",
      device_id: DEVICE_A,
      external_id: "job-late",
      state: "completed",
      owner_generation: 2,
    }));
    client.operations.push(operation({
      root_id: "root-late",
      device_id: DEVICE_A,
      operation_id: "job-late",
      state: "completed",
      owner_generation: 2,
    }));

    const before = JSON.stringify({ roots: client.roots, operations: client.operations });
    const result = await arbiterFor(client).acceptJobResult({
      deviceId: DEVICE_B,
      jobId: "job-late",
      reportedHandle: {
        rootId: "root-late",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 2,
        operationKind: "job",
        operationId: "job-late",
      },
      success: false,
      actor: "test",
    });
    const after = JSON.stringify({ roots: client.roots, operations: client.operations });

    expect(result).toMatchObject({
      accepted: false,
      decision: "rejected",
      reason: "job_result_not_current_dispatch_owner",
    });
    expect(after).toBe(before);
    expect(client.events.map((event) => event.event_type)).toEqual(["job_result_rejected_not_current_owner"]);
  });

  it("accepts a current-owner result that arrives synchronously before wireDispatch returns", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-fast", external_id: "job-fast", fifo_sequence: 1 }));
    const arbiter = arbiterFor(client);

    const result = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "job-fast",
      registerWaiter: () => undefined,
      wireDispatch: async (permit) => {
        const accepted = await arbiter.acceptJobResult({
          deviceId: DEVICE_A,
          jobId: "job-fast",
          handle: permit.handle,
          reportedHandle: permit.handle,
          success: true,
          actor: "test.fast_result",
        });
        expect(accepted.accepted, JSON.stringify(accepted)).toBe(true);
        return true;
      },
    });

    expect(result).toMatchObject({ decision: "terminal", sent: true, reason: "result_already_terminal" });
    expect(client.roots[0].state).toBe("completed");
    expect(client.operations[0].state).toBe("completed");
    expect(client.events.map((event) => event.event_type)).toEqual([
      "root_dispatching",
      "job_result_accepted",
      "dispatch_completion_after_terminal",
    ]);
  });

  it("requires the exact device-reported handle on the enforced result path", async () => {
    const makeCurrentOwner = () => {
      const client = new FakeClient();
      client.roots.push(root({
        id: "root-handle",
        external_id: "job-handle",
        state: "dispatched",
        owner_generation: 4,
      }));
      client.operations.push(operation({
        root_id: "root-handle",
        operation_id: "job-handle",
        state: "dispatched",
        owner_generation: 4,
      }));
      return client;
    };

    const missingClient = makeCurrentOwner();
    const missing = await arbiterFor(missingClient).acceptJobResult({
      deviceId: DEVICE_A,
      jobId: "job-handle",
      success: true,
    });
    expect(missing).toMatchObject({ accepted: false, reason: "job_result_handle_required" });
    expect(missingClient.roots[0].state).toBe("dispatched");
    expect(missingClient.events[0]).toMatchObject({
      event_type: "job_result_rejected_handle",
      reason: "job_result_handle_required",
    });

    const wrongClient = makeCurrentOwner();
    const wrong = await arbiterFor(wrongClient).acceptJobResult({
      deviceId: DEVICE_A,
      jobId: "job-handle",
      reportedHandle: {
        rootId: "root-handle",
        deviceId: DEVICE_A,
        rootKind: "job",
        ownerGeneration: 99,
        operationKind: "job",
        operationId: "job-handle",
      },
      success: true,
    });
    expect(wrong).toMatchObject({ accepted: false, reason: "job_result_reported_handle_mismatch" });
    expect(wrongClient.roots[0].state).toBe("dispatched");
    expect(wrongClient.events[0]).toMatchObject({
      event_type: "job_result_rejected_handle",
      reason: "job_result_reported_handle_mismatch",
    });
  });

  it("fails closed and audits when typed waiter registration throws", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "root-waiter", external_id: "job-waiter", fifo_sequence: 1 }));
    const wireDispatch = vi.fn(() => true);

    const result = await arbiterFor(client).runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "job-waiter",
      registerWaiter: () => {
        throw new Error("collision");
      },
      wireDispatch,
    });

    expect(result).toMatchObject({
      decision: "offline",
      sent: false,
      reason: "waiter_registration_failed: collision",
    });
    expect(wireDispatch).not.toHaveBeenCalled();
    expect(client.roots[0].state).toBe("blocked");
    expect(client.operations[0].state).toBe("blocked");
    expect(client.events.at(-1)).toMatchObject({
      event_type: "egress_not_sent_fail_closed",
      reason: "waiter_registration_failed: collision",
    });
  });

  it("dispatches a JOB child under the canonical server-workflow root and keeps the root active on result", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "workflow-root",
      root_kind: "server_workflow",
      external_id: "workflow-1",
      request_key: "workflow-1",
      fifo_sequence: 1,
    }));
    const arbiter = arbiterFor(client);

    const result = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "workflow-child-1",
      boundary: "generated_child",
      rootExternalId: "workflow-1",
      registerWaiter: () => undefined,
      wireDispatch: async (permit) => {
        expect(permit.handle).toMatchObject({
          rootId: "workflow-root",
          rootKind: "server_workflow",
          operationKind: "job",
          operationId: "workflow-child-1",
          ownerGeneration: 1,
        });
        const accepted = await arbiter.acceptJobResult({
          deviceId: DEVICE_A,
          jobId: "workflow-child-1",
          handle: permit.handle,
          reportedHandle: permit.handle,
          success: true,
        });
        expect(accepted.accepted).toBe(true);
        return true;
      },
    });

    expect(result).toMatchObject({ decision: "terminal", sent: true });
    expect(client.roots[0]).toMatchObject({ id: "workflow-root", state: "dispatched", owner_generation: 1 });
    expect(client.operations[0]).toMatchObject({
      root_id: "workflow-root",
      operation_id: "workflow-child-1",
      state: "completed",
      owner_generation: 1,
    });
    expect(client.events.map((event) => event.event_type)).toEqual([
      "root_dispatching",
      "child_job_result_accepted",
      "dispatch_completion_after_terminal",
    ]);
  });

  it("releases a server-workflow root when its root JOB result is accepted", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "workflow-root-job",
      root_kind: "server_workflow",
      external_id: "workflow-root-job",
      fifo_sequence: 1,
    }));
    const arbiter = arbiterFor(client);

    const result = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "workflow-root-wire-job",
      boundary: "server_workflow_root",
      operationKind: "job",
      rootExternalId: "workflow-root-job",
      registerWaiter: () => undefined,
      wireDispatch: async (permit) => {
        const accepted = await arbiter.acceptJobResult({
          deviceId: DEVICE_A,
          jobId: "workflow-root-wire-job",
          handle: permit.handle,
          reportedHandle: permit.handle,
          success: true,
        });
        expect(accepted.accepted).toBe(true);
        return true;
      },
    });

    expect(result).toMatchObject({ decision: "terminal", sent: true });
    expect(client.roots[0].state).toBe("completed");
    expect(client.operations[0].state).toBe("completed");
    expect(client.events.map((event) => event.event_type)).toEqual([
      "root_dispatching",
      "job_result_accepted",
      "dispatch_completion_after_terminal",
    ]);
  });

  it("rejects child egress without an existing canonical root before waiter or wire", async () => {
    const client = new FakeClient();
    const registerWaiter = vi.fn();
    const wireDispatch = vi.fn(() => true);

    const result = await arbiterFor(client).runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "orphan-child",
      boundary: "recovery_child",
      rootExternalId: "missing-workflow",
      registerWaiter,
      wireDispatch,
    });

    expect(result).toMatchObject({
      decision: "rejected",
      sent: false,
      reason: "existing_root_not_found",
    });
    expect(registerWaiter).not.toHaveBeenCalled();
    expect(wireDispatch).not.toHaveBeenCalled();
    expect(client.roots).toHaveLength(0);
    expect(client.events[0]).toMatchObject({
      event_type: "child_egress_rejected_missing_root",
      reason: "existing_root_not_found",
    });
  });

  it("retains one canonical server-workflow root across JOB then BATCH then JOB children", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "workflow-mixed-root",
      root_kind: "server_workflow",
      external_id: "workflow-mixed",
      request_key: "workflow-mixed",
      fifo_sequence: 1,
    }));
    const arbiter = arbiterFor(client);

    const sendJobChild = async (jobId: string) => arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId,
      boundary: "generated_child",
      rootExternalId: "workflow-mixed",
      registerWaiter: () => undefined,
      wireDispatch: async (permit) => {
        const terminal = await arbiter.acceptJobResult({
          deviceId: DEVICE_A,
          jobId,
          handle: permit.handle,
          reportedHandle: permit.handle,
          success: true,
        });
        expect(terminal.accepted).toBe(true);
        return true;
      },
    });

    await expect(sendJobChild("mixed-job-1")).resolves.toMatchObject({ decision: "terminal", sent: true });
    expect(client.roots[0]).toMatchObject({ id: "workflow-mixed-root", state: "dispatched", owner_generation: 1 });

    const batch = await arbiter.runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "server_workflow_batch_child",
      rootExternalId: "workflow-mixed",
      operationId: "mixed-batch-1",
      wireType: "BATCH_START",
      registerWaiter: () => undefined,
      wireDispatch: async (handle) => {
        const terminal = await arbiter.observeTerminal({
          deviceId: DEVICE_A,
          handle,
          status: "completed",
          actor: "test.batch_result",
        });
        expect(terminal).toMatchObject({ decision: "terminal" });
        return true;
      },
    });
    expect(batch).toMatchObject({ decision: "terminal", sent: true });
    expect(client.roots[0]).toMatchObject({ id: "workflow-mixed-root", state: "dispatched", owner_generation: 1 });
    expect(client.operations.find((item) => item.operation_id === "mixed-batch-1")).toMatchObject({
      operation_kind: "batch",
      state: "completed",
      root_id: "workflow-mixed-root",
    });

    await expect(sendJobChild("mixed-job-2")).resolves.toMatchObject({ decision: "terminal", sent: true });
    expect(client.roots[0]).toMatchObject({ id: "workflow-mixed-root", state: "dispatched", owner_generation: 1 });

    await expect(arbiter.finishServerWorkflowRoot({
      deviceId: DEVICE_A,
      workflowId: "workflow-mixed",
      successful: true,
    })).resolves.toMatchObject({ decision: "terminal", root: { state: "completed" } });
  });

  it("rejects a server-workflow BATCH child without canonical root identity before waiter or wire", async () => {
    const client = new FakeClient();
    const registerWaiter = vi.fn();
    const wireDispatch = vi.fn(() => true);

    const result = await arbiterFor(client).runObservedEgress({
      deviceId: DEVICE_A,
      boundary: "server_workflow_batch_child",
      operationId: "orphan-batch",
      wireType: "BATCH_START",
      registerWaiter,
      wireDispatch,
    });

    expect(result).toMatchObject({
      decision: "rejected",
      sent: false,
      reason: "existing_root_identity_required",
    });
    expect(registerWaiter).not.toHaveBeenCalled();
    expect(wireDispatch).not.toHaveBeenCalled();
    expect(client.roots).toHaveLength(0);
  });

  it("expires only a timed-out server-workflow child and keeps the canonical root usable", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "workflow-timeout-root",
      root_kind: "server_workflow",
      external_id: "workflow-timeout",
      request_key: "workflow-timeout",
      fifo_sequence: 1,
    }));
    const arbiter = arbiterFor(client);

    const first = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "readiness-job",
      boundary: "generated_child",
      rootExternalId: "workflow-timeout",
      registerWaiter: () => undefined,
      wireDispatch: () => true,
    });
    expect(first).toMatchObject({ decision: "dispatched", sent: true });

    const expired = await arbiter.expireServerWorkflowChild({
      deviceId: DEVICE_A,
      jobId: "readiness-job",
      handle: first.permit!.handle,
      actor: "test.timeout",
    });
    expect(expired).toMatchObject({
      decision: "terminal",
      reason: "child_timed_out_root_retained",
      root: { state: "dispatched" },
      operation: { state: "failed" },
    });
    expect(client.roots[0]).toMatchObject({ state: "dispatched", owner_generation: 1 });

    const next = await arbiter.runStandaloneJobEgress({
      deviceId: DEVICE_A,
      jobId: "next-readiness-job",
      boundary: "generated_child",
      rootExternalId: "workflow-timeout",
      registerWaiter: () => undefined,
      wireDispatch: () => true,
    });
    expect(next).toMatchObject({ decision: "dispatched", sent: true });
  });

  it.each(["blocked", "reconciling"] as const)(
    "does not terminalize an ambiguous %s server-workflow root during normal finish cleanup",
    async (state) => {
      const client = new FakeClient();
      client.roots.push(root({
        id: `workflow-${state}-root`,
        root_kind: "server_workflow",
        external_id: `workflow-${state}`,
        request_key: `workflow-${state}`,
        state,
        owner_generation: 2,
      }));
      client.operations.push(operation({
        root_id: `workflow-${state}-root`,
        root_kind: "server_workflow",
        operation_kind: "workflow",
        operation_id: `workflow-${state}`,
        state,
        owner_generation: 2,
      }));

      const result = await arbiterFor(client).finishServerWorkflowRoot({
        deviceId: DEVICE_A,
        workflowId: `workflow-${state}`,
        successful: false,
        actor: "test.cleanup",
      });

      expect(result).toMatchObject({ decision: "rejected", reason: "root_ambiguous_not_finishable" });
      expect(client.roots[0]).toMatchObject({ state, owner_generation: 2 });
      expect(client.operations[0]).toMatchObject({ state, owner_generation: 2 });
    },
  );

  it("cancels a queued server workflow without releasing an in-flight device slot", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "active-root", external_id: "active-job", state: "dispatched", owner_generation: 1 }),
      root({
        id: "queued-workflow-root",
        root_kind: "server_workflow",
        external_id: "workflow-queued",
        request_key: "workflow-queued",
        state: "queued",
        fifo_sequence: 2,
      }),
    );
    client.operations.push(
      operation({
        id: 1,
        root_id: "queued-workflow-root",
        root_kind: "server_workflow",
        operation_kind: "workflow",
        operation_id: "workflow-queued",
        state: "registered",
        owner_generation: 0,
      }),
      operation({
        id: 2,
        root_id: "queued-workflow-root",
        root_kind: "server_workflow",
        operation_kind: "job",
        operation_id: "workflow-execute-job",
        state: "registered",
        owner_generation: 0,
      }),
    );

    const result = await arbiterFor(client).cancelQueuedServerWorkflowRoot({
      deviceId: DEVICE_A,
      workflowId: "workflow-queued",
    });

    expect(result).toMatchObject({ decision: "terminal", root: { state: "cancelled" } });
    expect(client.roots.find((item) => item.id === "active-root")).toMatchObject({
      state: "dispatched",
      owner_generation: 1,
    });
    expect(client.operations).toHaveLength(2);
    expect(client.operations.every((item) => item.state === "cancelled")).toBe(true);
    expect(client.events.some((event) => event.event_type === "queued_server_workflow_cancelled")).toBe(true);
  });

  it("rejects queued-only cancellation after dispatch without terminalizing or releasing the slot", async () => {
    const client = new FakeClient();
    client.roots.push(root({
      id: "workflow-inflight-root",
      root_kind: "server_workflow",
      external_id: "workflow-inflight",
      request_key: "workflow-inflight",
      state: "dispatched",
      owner_generation: 3,
    }));
    client.operations.push(operation({
      root_id: "workflow-inflight-root",
      root_kind: "server_workflow",
      operation_kind: "workflow",
      operation_id: "workflow-inflight",
      state: "dispatched",
      owner_generation: 3,
    }));

    const result = await arbiterFor(client).cancelQueuedServerWorkflowRoot({
      deviceId: DEVICE_A,
      workflowId: "workflow-inflight",
    });

    expect(result).toMatchObject({
      decision: "rejected",
      reason: "root_not_queued",
      root: { state: "dispatched", ownerGeneration: 3 },
    });
    expect(client.roots[0]).toMatchObject({ state: "dispatched", owner_generation: 3 });
    expect(client.operations[0]).toMatchObject({ state: "dispatched", owner_generation: 3 });
    expect(client.events.some((event) => event.event_type === "queued_server_workflow_cancel_rejected")).toBe(true);
  });

  it("atomically cancels a persisted workflow row and its queued PNQ root", async () => {
    const client = new FakeClient();
    client.workflows.push({ id: "workflow-persisted", device_id: DEVICE_A, status: "queued" });
    client.roots.push(root({
      id: "workflow-persisted-root",
      root_kind: "server_workflow",
      external_id: "workflow-persisted",
      request_key: "workflow-persisted",
      state: "queued",
    }));
    client.operations.push(operation({
      root_id: "workflow-persisted-root",
      root_kind: "server_workflow",
      operation_kind: "workflow",
      operation_id: "workflow-persisted",
      state: "registered",
    }));

    const result = await arbiterFor(client).cancelQueuedPersistedWorkflow({
      deviceId: DEVICE_A,
      workflowId: "workflow-persisted",
    });

    expect(result).toMatchObject({ decision: "terminal", root: { state: "cancelled" } });
    expect(client.workflows[0]?.status).toBe("cancelled");
    expect(client.operations[0]?.state).toBe("cancelled");
    expect(client.events.some((event) => event.event_type === "persisted_workflow_and_root_cancelled")).toBe(true);
    expect(client.committed).toBe(true);
  });

  it("leaves a queued PNQ root untouched when the worker already won queued-to-running", async () => {
    const client = new FakeClient();
    client.workflows.push({ id: "workflow-running", device_id: DEVICE_A, status: "running" });
    client.roots.push(root({
      id: "workflow-running-root",
      root_kind: "server_workflow",
      external_id: "workflow-running",
      request_key: "workflow-running",
      state: "queued",
    }));

    const result = await arbiterFor(client).cancelQueuedPersistedWorkflow({
      deviceId: DEVICE_A,
      workflowId: "workflow-running",
    });

    expect(result).toMatchObject({ decision: "rejected", reason: "workflow_not_queued" });
    expect(client.workflows[0]?.status).toBe("running");
    expect(client.roots[0]?.state).toBe("queued");
    expect(client.events.some((event) => event.reason === "workflow_not_queued")).toBe(true);
  });

  it("cancels a persisted workflow safely before its PNQ root is admitted", async () => {
    const client = new FakeClient();
    client.workflows.push({ id: "workflow-no-root", device_id: DEVICE_A, status: "queued" });

    const result = await arbiterFor(client).cancelQueuedPersistedWorkflow({
      deviceId: DEVICE_A,
      workflowId: "workflow-no-root",
    });

    expect(result).toEqual(expect.objectContaining({ decision: "terminal", root: null }));
    expect(client.workflows[0]?.status).toBe("cancelled");
    expect(client.events.some((event) => event.event_type === "persisted_workflow_cancelled_before_root_admission")).toBe(true);
  });

  it("blocks and audits a corrupt queued replay head instead of silently stalling FIFO", async () => {
    const client = new FakeClient();
    client.roots.push(root({ id: "corrupt-root", external_id: "job-corrupt", state: "queued" }));
    client.operations.push(operation({
      root_id: "corrupt-root",
      operation_id: "job-corrupt",
      state: "registered",
    }));

    await arbiterFor(client).markCorruptQueueHead({
      deviceId: DEVICE_A,
      rootId: "corrupt-root",
      rootKind: "job",
      ownerGeneration: 0,
      operationId: "job-corrupt",
      actor: "test.queue_replay",
      reason: "invalid_or_mismatched_dispatch_envelope",
    });

    expect(client.roots[0].state).toBe("blocked");
    expect(client.operations[0].state).toBe("blocked");
    expect(client.events[0]).toMatchObject({
      event_type: "queue_replay_corrupt_head_blocked",
      previous_state: "queued",
      new_state: "blocked",
      reason: "invalid_or_mismatched_dispatch_envelope",
    });
  });

  it("fails closed by reconciling in-flight roots at startup", async () => {
    const client = new FakeClient();
    client.roots.push(
      root({ id: "claimed-root", external_id: "job-claimed", state: "claimed", owner_generation: 1 }),
      root({ id: "dispatched-root", external_id: "job-dispatched", state: "dispatched", owner_generation: 2 }),
      root({ id: "queued-root", external_id: "job-queued", state: "queued" }),
    );
    client.operations.push(
      operation({ root_id: "claimed-root", operation_id: "job-claimed", owner_generation: 1, state: "dispatching" }),
      operation({ root_id: "dispatched-root", operation_id: "job-dispatched", owner_generation: 2, state: "dispatched" }),
    );

    const result = await arbiterFor(client).reconcileInFlightAtStartup();

    expect(result).toEqual({ reconciledRoots: 2, activeAmbiguousRoots: 2 });
    expect(client.roots.map((item) => [item.id, item.state])).toEqual([
      ["claimed-root", "reconciling"],
      ["dispatched-root", "reconciling"],
      ["queued-root", "queued"],
    ]);
    expect(client.operations.map((item) => item.state)).toEqual(["reconciling", "reconciling"]);
    expect(client.events.filter((event) => event.event_type === "startup_reconciled_root")).toHaveLength(2);
  });

  it("only auto-reconciles server workflows whose child jobs timed out before device start", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      expect(normalized).toContain("JOIN lifecycle_state_definitions job_state");
      expect(normalized).toContain("NOT job_state.terminal");
      expect(normalized).not.toContain("jobs.status NOT IN");
      expect(normalized).toContain("jobs.completed_at IS NULL");
      expect(normalized).toContain("jobs.started_at IS NOT NULL");
      expect(normalized).toContain("JOIN lifecycle_state_definitions workflow_state");
      expect(normalized).toContain("JOIN lifecycle_transitions workflow_failure");
      expect(normalized).toContain("workflow_failure_state.terminal");
      expect(normalized).toContain("workflow_failure_state.retryable");
      expect(normalized).toContain("NOT workflow_failure_state.administrative");
      expect(normalized).not.toContain("workflow_failure.action_key =");
      expect(normalized).toContain("jobs.completed_at > NOW() - INTERVAL '5 minutes'");
      expect(normalized).not.toContain("workflows.status IN");
      expect(normalized).toContain("WHERE workflows.id::text = candidates.external_id");
      expect(normalized).toContain("undispatched_timed_out_workflow_reconciled");
      return { rows: [{ id: "reconciled-root" }], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const arbiter = new DeviceExecutionArbiter(() => ({
      connect: async () => client as any,
      query: query as any,
    }) as any);

    await expect(arbiter.reconcileUndispatchedTimedOutServerWorkflows()).resolves.toEqual({
      reconciledRoots: 1,
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("loads root boundary, control, and child policies from PostgreSQL", async () => {
    const client = new FakeClient();
    await expect(getDeviceExecutionBoundaryPolicy("standalone_job", client as any)).resolves.toMatchObject({
      rootKind: "job",
      retainsRootUntilTerminal: true,
      mayBypassDeviceQueue: false,
    });
    await expect(getDeviceExecutionBoundaryPolicy("generated_child", client as any)).resolves.toMatchObject({
      requiresExistingRootHandle: true,
      egressLane: "device_execution",
    });
    await expect(getDeviceExecutionBoundaryPolicy("control_egress", client as any)).resolves.toMatchObject({
      rootKind: "control",
      egressLane: "control",
      mayBypassDeviceQueue: true,
    });
  });
});

describe("DeviceExecutionArbiter schema gate and migration", () => {
  it("fails closed when required schema pieces are missing", async () => {
    const goodPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          roots_table: true,
          events_table: true,
          operations_table: true,
          missing_columns: [],
          wrong_column_types: [],
          missing_constraints: [],
          missing_foreign_keys: [],
          missing_indexes: [],
          invalid_index_predicates: [],
        }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => goodPool as any).validateSchema()).resolves.toBeUndefined();

    const badPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          roots_table: true,
          events_table: false,
          operations_table: false,
          missing_columns: ["device_execution_events.event_type"],
          wrong_column_types: [],
          missing_constraints: ["device_execution_roots.device_execution_roots_state_check"],
          missing_foreign_keys: [],
          missing_indexes: ["idx_device_execution_active_slot"],
          invalid_index_predicates: [],
        }],
      }),
      connect: vi.fn(),
    };
    await expect(new DeviceExecutionArbiter(() => badPool as any).validateSchema()).rejects.toBeInstanceOf(DeviceExecutionSchemaError);
  });

  it("keeps the production migration idempotent and backed by an active-slot unique index plus event ledger", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "src/db/migrations/081_device_execution_queue.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_roots");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_events");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS device_execution_operations");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("DROP INDEX IF EXISTS idx_device_execution_active_slot");
    expect(sql).toContain("idx_device_execution_roots_state_fifo");
    expect(sql).not.toContain("WHERE state IN");
    expect(sql).toContain("idx_device_execution_operations_identity");
  });
});
