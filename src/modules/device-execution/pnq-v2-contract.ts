export interface PnqV2Node {
  id: string;
  nodeKey: string;
  status: string;
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
  status: string;
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
  eventType: string;
  decision: string;
  evidence: Record<string, unknown>;
}
