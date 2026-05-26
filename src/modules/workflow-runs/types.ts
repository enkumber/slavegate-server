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
  discoveryRan: boolean;
  appMapVersion: string | null;
  workflowId: string | null;
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
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
