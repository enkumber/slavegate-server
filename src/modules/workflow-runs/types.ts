import type { AppMap } from "../app-mapping/schema";
import type { CompiledWorkflow } from "../workflow-compiler/types";
import type { RunCompiledResult } from "../workflow-compiler/runner.service";

export const MAX_WORKFLOW_RUN_INSTRUCTION_LENGTH = 2000;

export type WorkflowRunStatus =
  | "accepted"
  | "discovering"
  | "compiling"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type WorkflowArtifactState = "candidate" | "promoted" | "quarantined" | "unknown";

export interface WorkflowRunTimelineItem {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error?: string | null;
  state?: Record<string, unknown>;
}

export interface CreateWorkflowRunRequest {
  instruction?: unknown;
  appId?: unknown;
  deviceId?: unknown;
}

export interface WorkflowRunRecord {
  id: string;
  instruction: string;
  appId: string;
  deviceId: string;
  status: WorkflowRunStatus;
  artifactState: WorkflowArtifactState;
  discoveryRan: boolean;
  appMapVersion: string | null;
  workflowId: string | null;
  result: Record<string, unknown>;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  timeline?: WorkflowRunTimelineItem[];
}

export interface ListWorkflowRunsOptions {
  status?: unknown;
  artifactState?: unknown;
  limit?: unknown;
}

export interface ListWorkflowRunsResult {
  items: WorkflowRunRecord[];
  total: number;
  limit: number;
}

export interface GetWorkflowRunResult {
  run: WorkflowRunRecord;
}

export interface CreateWorkflowRunResult {
  ok: boolean;
  code?: string;
  status: WorkflowRunStatus | "validation_failed";
  httpStatus: number;
  data?: WorkflowRunRecord & {
    appMap?: Pick<AppMap, "appId" | "version" | "pageCount" | "transitionCount">;
    compiledWorkflow?: CompiledWorkflow;
    execution?: RunCompiledResult;
    fromCache?: boolean;
  };
  error?: string;
}
