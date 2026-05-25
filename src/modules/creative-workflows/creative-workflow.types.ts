// Creative Workflow E2E types
export type CreativeWorkflowStatus =
  | "proposal"
  | "queued"
  | "executing"
  | "completed"
  | "failed"
  | "not_ready";

export type CreativeIntent =
  | "account_scan"
  | "content_post"
  | "engagement_boost"
  | "audience_research"
  | "health_check"
  | "strategy_review";

export type CreativeSafetyClass = "read_only" | "light" | "moderate";

export interface CreativeProposal {
  /** Objective provided by the operator. */
  objective: string;
  /** Selected intent based on objective/analysis. */
  intent: CreativeIntent;
  /** Safety class of the proposed workflow. */
  safetyClass: CreativeSafetyClass;
  /** Brief summary of the proposal. */
  summary: string;
  /** Client id used. */
  clientId: string;
  /** Account id used. */
  accountId: string;
  /** Device id used. */
  deviceId: string;
}

export interface CreativeWorkflowRun {
  id: string;
  /** Client id (optional, derived from account). */
  clientId: string | null;
  /** Target account id. */
  accountId: string;
  /** Device to execute on. */
  deviceId: string;
  /** Objective description. */
  objective: string;
  /** Proposal details. */
  proposal: CreativeProposal;
  /** Execution status. */
  status: CreativeWorkflowStatus;
  /** Linked agency_workflow_run id. */
  agencyWorkflowRunId: string | null;
  /** Linked task id. */
  taskId: string | null;
  /** Final report. */
  report: Record<string, unknown>;
  /** Error if failed. */
  error: string | null;
  /** Dry run flag. */
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreativeWorkflowCreateRequest {
  clientId?: string;
  accountId?: string;
  deviceId?: string;
  objective?: string;
  dryRun?: boolean;
}

export interface CreativeWorkflowCreateResponse {
  runId: string | null;
  proposal: CreativeProposal;
  status: CreativeWorkflowStatus;
  code?: string;
  agencyWorkflowRunId: string | null;
  taskId: string | null;
  cacheKey?: string | null;
  requestKey?: string | null;
  report?: Record<string, unknown>;
  message: string;
}
