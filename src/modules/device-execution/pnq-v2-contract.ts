export const PNQ_V2_TERMINAL_JOB_STATUSES = ["DONE", "STUCK"] as const;
export const PNQ_V2_ACTIVE_JOB_STATUSES = ["PENDING", "DISPATCHING", "RUNNING"] as const;
export const PNQ_V2_JOB_STATUSES = [
  ...PNQ_V2_ACTIVE_JOB_STATUSES,
  ...PNQ_V2_TERMINAL_JOB_STATUSES,
] as const;

export type PnqV2JobStatus = typeof PNQ_V2_JOB_STATUSES[number];
export type PnqV2TerminalJobStatus = typeof PNQ_V2_TERMINAL_JOB_STATUSES[number];

export interface PnqV2Node {
  id: string;
  nodeKey: string;
  status: "active" | "draining" | "disabled";
  nextNodeSeq: number;
  connectionEpoch: number;
  metadata: Record<string, unknown>;
}

export interface PnqV2Job {
  id: string;
  nodeId: string;
  nodeSeq: number;
  requestKey: string;
  requestPayload: Record<string, unknown>;
  status: PnqV2JobStatus;
  jobVersion: number;
  dispatchGeneration: number;
  executionId: string | null;
  claimedConnectionEpoch: number | null;
  queueDeadlineAt: Date;
  dispatchDeadlineAt: Date;
  executionDeadlineAt: Date;
  resultDeadlineAt: Date;
  terminalAt: Date | null;
  terminalReason: string | null;
}

export interface PnqV2ResolutionAudit {
  id: number;
  jobId: string | null;
  nodeId: string | null;
  eventType:
    | "enqueue_idempotent_replay"
    | "payload_conflict"
    | "epoch_rejected"
    | "cas_lost"
    | "stale_result"
    | "late_result"
    | "result_mismatch"
    | "recovery_required"
    | "marked_stuck"
    | "explicit_resolution";
  decision: "ignored" | "rejected" | "stuck" | "resolved" | "requires_recovery";
  evidence: Record<string, unknown>;
}
