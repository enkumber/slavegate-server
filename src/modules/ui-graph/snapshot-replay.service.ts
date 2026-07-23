import crypto from "crypto";
import { getDb } from "../../db/client";

export interface StateRule {
  state: string;
  all?: string[];
  any?: string[];
  none?: string[];
  caseSensitive?: boolean;
}

export interface ReplayMachine {
  goalStates: string[];
  unknownStates?: string[];
  transitions: Array<{ from: string; to?: string[] }>;
}

function normalized(value: string, caseSensitive = false): string {
  return caseSensitive ? value : value.toLocaleLowerCase();
}

export function classifySnapshot(uiTree: string, rules: StateRule[]): string | null {
  for (const rule of rules) {
    const tree = normalized(uiTree, rule.caseSensitive);
    const values = (items: string[] | undefined) => (items ?? []).map((item) => normalized(item, rule.caseSensitive));
    if (!values(rule.all).every((item) => tree.includes(item))) continue;
    if (values(rule.any).length > 0 && !values(rule.any).some((item) => tree.includes(item))) continue;
    if (values(rule.none).some((item) => tree.includes(item))) continue;
    return rule.state;
  }
  return null;
}

export function replayStateMachine(
  uiTree: string,
  rules: StateRule[],
  machine: ReplayMachine,
): { ok: boolean; state: string | null; reason: string; reachable: string[] } {
  const state = classifySnapshot(uiTree, rules);
  if (!state) return { ok: false, state: null, reason: "unclassified_snapshot", reachable: [] };
  if (machine.unknownStates?.includes(state)) {
    return { ok: false, state, reason: "unknown_state_is_fail_closed", reachable: [] };
  }
  if (machine.goalStates.includes(state)) return { ok: true, state, reason: "goal_state", reachable: [state] };
  const transition = machine.transitions.find((item) => item.from === state);
  if (!transition) return { ok: false, state, reason: "missing_transition", reachable: [] };
  return { ok: true, state, reason: "transition_available", reachable: transition.to ?? [] };
}

export async function persistStateSnapshot(input: {
  appId: string;
  stateKey: string;
  uiTree: string;
  appVersion?: string | null;
  androidVersion?: string | null;
  locale?: string | null;
  deviceClass?: string | null;
  deviceId?: string | null;
  workflowId?: string | null;
  branchKey?: string | null;
  source?: "edge_workflow" | "canary" | "manual_gate" | "fixture";
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; uiTreeHash: string }> {
  if (!input.appId.trim() || !input.stateKey.trim() || !input.uiTree.trim()) {
    throw new Error("UI_GRAPH_SNAPSHOT_FIELDS_REQUIRED");
  }
  const uiTreeHash = crypto.createHash("sha256").update(input.uiTree).digest("hex");
  const result = await getDb().query(
    `INSERT INTO ui_graph_state_snapshots
       (app_id, state_key, ui_tree_hash, ui_tree, app_version, android_version, locale,
        device_class, device_id, workflow_id, branch_key, source, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (app_id, state_key, ui_tree_hash) DO UPDATE SET
       metadata=ui_graph_state_snapshots.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      input.appId, input.stateKey, uiTreeHash, input.uiTree.slice(0, 100_000),
      input.appVersion ?? null, input.androidVersion ?? null, input.locale ?? null,
      input.deviceClass ?? null, input.deviceId ?? null, input.workflowId ?? null,
      input.branchKey ?? null, input.source ?? "edge_workflow", JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { id: result.rows[0].id, uiTreeHash };
}

export async function replaySnapshotCorpus(input: {
  appId: string;
  rules: StateRule[];
  machine: ReplayMachine;
}): Promise<{
  total: number;
  passed: number;
  failed: number;
  branchCoverage: string[];
  results: Array<Record<string, unknown>>;
}> {
  const snapshots = await getDb().query(
    `SELECT id, state_key, ui_tree_hash, ui_tree, app_version, android_version, branch_key
       FROM ui_graph_state_snapshots WHERE app_id=$1 ORDER BY created_at DESC LIMIT 1000`,
    [input.appId],
  );
  const results = snapshots.rows.map((row) => ({
    snapshotId: row.id,
    expectedState: row.state_key,
    uiTreeHash: row.ui_tree_hash,
    appVersion: row.app_version,
    androidVersion: row.android_version,
    branchKey: row.branch_key,
    ...replayStateMachine(row.ui_tree, input.rules, input.machine),
  }));
  const passed = results.filter((item) => item.ok && item.state === item.expectedState).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    branchCoverage: [...new Set(results.map((item) => String(item.branchKey ?? "default")))].sort(),
    results,
  };
}
