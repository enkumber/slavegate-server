/**
 * shared/protocol/api-types.ts
 * REST API types shared between server and dashboard.
 */

import type { DeviceHealth, JobStatus, JobType, JobParams } from "./messages";

// ─── Common ───────────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

export type DeviceStatus = string;

export interface LifecycleCapabilities {
  initial: boolean;
  terminal: boolean;
  retryable: boolean;
  administrative: boolean;
  dispatchable: boolean;
  manual: boolean;
}

export interface Device {
  id: string;
  hardwareUuid: string;
  friendlyName: string;
  model: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  /** Physical location identifier — e.g. "loc_a", "loc_b". Different WiFi per location = different IP. */
  locationId: string | null;
  isCanary: boolean;
  status: DeviceStatus;
  statusCapabilities: LifecycleCapabilities;
  lastSeenAt: string | null; // ISO 8601
  lastIp: string | null;
  health: DeviceHealth | null;
  createdAt: string;
}

export interface ApproveDeviceRequest {
  friendlyName?: string;
}

export interface UpdateDeviceRequest {
  friendlyName?: string;
  locationId?: string;
  isCanary?: boolean;
  status?: DeviceStatus;
}

// GET /api/devices
export type ListDevicesResponse = PaginatedResponse<Device>;

// GET /api/devices/:id
export type GetDeviceResponse = Device;

// POST /api/devices/:id/approve
export type ApproveDeviceResponse = Device;

// PATCH /api/devices/:id
export type UpdateDeviceResponse = Device;

// DELETE /api/devices/:id  (soft delete — marks as disabled)
export interface DeleteDeviceResponse {
  deleted: true;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  deviceId: string;
  type: JobType;
  params: JobParams;
  status: JobStatus;
  output?: unknown;
  error?: string;
  durationMs?: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DispatchJobRequest {
  deviceId: string;
  type: JobType;
  params: JobParams;
  timeoutMs?: number;
  /** Dashboard user must confirm root commands */
  confirmRoot?: boolean;
  /** Set by workflow executor — skips duplicate audit log INSERT in dispatcher */
  workflowId?: string;
  stepIndex?: number;
  /** Passed through to JOB_DISPATCH WebSocket message */
  verificationStrategy?: string;
  l1TimeoutMs?: number;
  l2SettleMs?: number;
}

export interface DispatchJobResponse {
  jobId: string;
  status: string;
}

// GET /api/jobs
export type ListJobsResponse = PaginatedResponse<Job>;

// GET /api/jobs/:id
export type GetJobResponse = Job;

// POST /api/jobs
export type CreateJobResponse = DispatchJobResponse;

// DELETE /api/jobs/:id (cancel if pending/running)
export interface CancelJobResponse {
  cancelled: true;
}

// ─── OTA ─────────────────────────────────────────────────────────────────────

export interface AgentRelease {
  id: string;
  version: string;
  versionCode: number;
  apkUrl: string;
  apkSha256: string;
  apkSignature: string;
  changelog: string;
  createdAt: string;
}

export interface DeployOtaRequest {
  releaseId: string;
  deviceIds: string[]; // empty = deploy to all approved/online devices
  mandatory?: boolean;
}

export interface DeployOtaResponse {
  dispatched: number;
  skipped: number;
}

// GET /api/ota/releases
export type ListReleasesResponse = PaginatedResponse<AgentRelease>;

// POST /api/ota/deploy
export type OtaDeployResponse = DeployOtaResponse;

// ─── Generated Workflows ─────────────────────────────────────────────────────

export type GeneratedWorkflowPlatform = string;

export type GeneratedWorkflowVerificationStrategy = string;

export type GeneratedWorkflowIntent = string;

export type GeneratedWorkflowSafetyClass = string;

export type GeneratedWorkflowAllowedAction = string;

export type GeneratedWorkflowAllowedRecoveryRequest = string;

export interface GeneratedWorkflowOutputSchema {
  required: string[];
  properties: Record<string, GeneratedWorkflowOutputSchemaProperty>;
}

export interface GeneratedWorkflowOutputSchemaProperty {
  type: "boolean" | "string" | "number" | "object" | "array" | "null";
}

export interface GeneratedWorkflowStep {
  type: "action" | "wait" | "condition" | "loop" | "checkpoint";
  id?: string;
  action?: GeneratedWorkflowAllowedAction;
  target?: string;
  x?: number;
  y?: number;
  params?: Record<string, unknown>;
  verification?: GeneratedWorkflowVerificationStrategy;
  retries?: number;
  timeoutMs?: number;
  expectedScreen?: string;
  duration?: number;
  condition?: string;
  element?: string;
  check?: string;
  probability?: number;
  if_true?: GeneratedWorkflowStep[];
  if_false?: GeneratedWorkflowStep[];
  count?: number;
  steps?: GeneratedWorkflowStep[];
  breakOn?: string;
  reason?: string;
}

export interface GeneratedWorkflowTemplate {
  id: string;
  name: string;
  platform: GeneratedWorkflowPlatform;
  description: string;
  version: string;
  intent?: GeneratedWorkflowIntent;
  safetyClass?: GeneratedWorkflowSafetyClass;
  outputSchema?: GeneratedWorkflowOutputSchema;
  allowedRecoveryRequests?: GeneratedWorkflowAllowedRecoveryRequest[];
  defaultVerificationStrategy?: GeneratedWorkflowVerificationStrategy;
  dataRetentionDays?: number;
  compatibleAppVersions?: string[];
  steps: GeneratedWorkflowStep[];
}

export interface GeneratedWorkflowCompiledStep {
  path: string;
  type: GeneratedWorkflowStep["type"];
  id?: string;
  action?: string;
  verification?: string;
}

export interface GeneratedWorkflowCompiledPlanSummary {
  planVersion: "generated-workflow-plan/v1";
  cacheKey: string;
  templateId: string;
  platform: GeneratedWorkflowPlatform;
  templateVersion: string;
  metadata: {
    intent: GeneratedWorkflowIntent | null;
    safetyClass: GeneratedWorkflowSafetyClass | null;
    outputSchema: GeneratedWorkflowOutputSchema | null;
    allowedRecoveryRequests: GeneratedWorkflowAllowedRecoveryRequest[];
  };
  stepCount: number;
  actionCount: number;
  checkpointCount: number;
  maxDepth: number;
  llmBudget: {
    happyPathRequests: number;
    recoveryRequests: "only_on_failure";
  };
  steps: GeneratedWorkflowCompiledStep[];
}

export interface GeneratedWorkflowPlanCacheRecordDto {
  cacheKey: string;
  requestKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string;
  sourceMetadata: Record<string, unknown>;
  templateId: string;
  platform: GeneratedWorkflowPlatform;
  templateVersion: string;
  workflow: GeneratedWorkflowTemplate;
  compiledPlan: GeneratedWorkflowCompiledPlanSummary;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface GeneratedWorkflowPromptRequest {
  platform: GeneratedWorkflowPlatform;
  packageName?: string;
  appId?: string;
  goal: string;
  clientContext?: string;
  availableScreens?: string[];
  appMapHints?: string[];
}

export type GeneratedWorkflowPromptResponse =
  | (GeneratedWorkflowPlanCacheRecordDto & {
      cacheHit: true;
      cacheMiss: false;
      canExecuteFromCache: true;
      nextAction: "reuse_cached_workflow";
    })
  | {
      requestKey: string;
      cacheHit: false;
      cacheMiss: true;
      canExecuteFromCache: false;
      nextAction: "generate_validate_and_cache_workflow";
      appMapLoaded: boolean;
      screenCount: number;
      prompt: string;
    };

export interface GeneratedWorkflowValidateRequest {
  workflow: GeneratedWorkflowTemplate;
}

export interface GeneratedWorkflowSummary {
  generated: true;
  dryRun?: boolean;
  persisted?: boolean;
  templateId: string;
  platform: GeneratedWorkflowPlatform;
  version: string;
  intent: GeneratedWorkflowIntent | null;
  safetyClass: GeneratedWorkflowSafetyClass | null;
  outputSchema: GeneratedWorkflowOutputSchema | null;
  allowedRecoveryRequests: GeneratedWorkflowAllowedRecoveryRequest[];
  stepCount: number;
  compiledPlan: GeneratedWorkflowCompiledPlanSummary;
}

export type GeneratedWorkflowValidateResponse = {
  valid: true;
} & GeneratedWorkflowSummary;

export type GeneratedWorkflowCacheResolveRequest =
  | { cacheKey: string; requestKey?: never; workflow?: never; persist?: boolean }
  | { requestKey: string; cacheKey?: never; workflow?: never; persist?: boolean }
  | { workflow: GeneratedWorkflowTemplate; cacheKey?: string; requestKey?: string; persist?: boolean };

export type GeneratedWorkflowCacheResolveResponse =
  | (GeneratedWorkflowPlanCacheRecordDto & {
      cacheHit: true;
      cacheMiss: false;
      canExecuteFromCache: true;
      nextAction: "reuse_cached_workflow";
    })
  | {
      cacheHit: false;
      cacheMiss: true;
      canExecuteFromCache: false;
      cacheKey?: string;
      requestKey?: string;
      nextAction: "generate_validate_and_cache_workflow";
    }
  | ({
      cacheHit: false;
      cacheMiss: boolean;
      canExecuteFromCache: boolean;
      requestedCacheKey: string | null;
      requestedRequestKey: string | null;
      requestKey: string | null;
      nextAction: string;
      persisted: boolean;
    } & GeneratedWorkflowSummary);

export type GeneratedWorkflowExecuteRequest =
  | {
      workflow: GeneratedWorkflowTemplate;
      cacheKey?: never;
      requestKey?: never;
      deviceId?: string;
      accountId?: string;
      clientId?: string;
      campaignId?: string;
      variables?: Record<string, unknown>;
      dryRun: true;
      persist?: boolean;
    }
  | {
      cacheKey: string;
      requestKey?: never;
      workflow?: never;
      deviceId?: string;
      accountId?: string;
      clientId?: string;
      campaignId?: string;
      variables?: Record<string, unknown>;
      dryRun?: boolean;
      persist?: boolean;
    }
  | {
      requestKey: string;
      cacheKey?: never;
      workflow?: never;
      deviceId?: string;
      accountId?: string;
      clientId?: string;
      campaignId?: string;
      variables?: Record<string, unknown>;
      dryRun?: boolean;
      persist?: boolean;
    };

export type GeneratedWorkflowControlPlaneContext = {
  source: "api" | "task_runner";
  accountId?: string;
  clientId?: string;
  campaignId?: string;
  deviceId?: string;
  taskId?: string;
  platform?: string;
  routine?: string;
};

export type GeneratedWorkflowDryRunResponse = {
  cacheHit: boolean;
  canonicalHit: boolean;
  canExecuteFromCache: boolean;
  cacheKey: string;
  requestKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string | null;
  controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
} & GeneratedWorkflowSummary;

export type GeneratedWorkflowExecuteResponse = {
  workflowId: string;
  status: string;
  mode: "edge" | "server";
  templateId: string;
  generated: true;
  cacheHit: boolean;
  canonicalHit: boolean;
  canExecuteFromCache: true;
  cacheKey: string;
  requestKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string | null;
  controlPlaneContext?: GeneratedWorkflowControlPlaneContext;
  compiledPlan: GeneratedWorkflowCompiledPlanSummary;
};

export type CreateGeneratedWorkflowResponse =
  | GeneratedWorkflowDryRunResponse
  | GeneratedWorkflowExecuteResponse;

// ─── Agency Workflow Runs ────────────────────────────────────────────────────

export type AgencyWorkflowRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

interface CreateAgencyWorkflowRunBase {
  clientId: string;
  accountId: string;
  deviceId: string;
  intent: GeneratedWorkflowIntent;
  scheduledTime?: string;
  context?: Record<string, unknown>;
  workflow?: never;
}

export type CreateAgencyWorkflowRunRequest =
  | (CreateAgencyWorkflowRunBase & { requestKey: string; cacheKey?: never })
  | (CreateAgencyWorkflowRunBase & { cacheKey: string; requestKey?: never });

export interface AgencyWorkflowRun {
  id: string;
  clientId: string;
  accountId: string;
  deviceId: string;
  shortDeviceId: string;
  taskId: string | null;
  workflowId: string | null;
  platform: GeneratedWorkflowPlatform;
  intent: GeneratedWorkflowIntent;
  safetyClass: GeneratedWorkflowSafetyClass;
  requestKey: string | null;
  cacheKey: string | null;
  canonicalWorkflowId: string;
  canonicalWorkflowVersion: string;
  compiledPlanHash: string;
  status: AgencyWorkflowRunStatus;
  context: Record<string, unknown>;
  output: Record<string, unknown>;
  tokenUsage: Record<string, unknown>;
  recoveryRequests: number;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  accountUsername?: string | null;
  accountPlatform?: string | null;
  clientName?: string | null;
  deviceName?: string | null;
}

export type CreateAgencyWorkflowRunResponse = AgencyWorkflowRun;
export type GetAgencyWorkflowRunResponse = AgencyWorkflowRun;
export type ListAgencyWorkflowRunsResponse = PaginatedResponse<AgencyWorkflowRun>;

// ─── Audit log ───────────────────────────────────────────────────────────────

export interface CommandLogEntry {
  id: number;
  deviceId: string;
  commandType: JobType;
  commandParams: JobParams;
  resultStatus: JobStatus;
  executedAt: string;
}

// GET /api/audit
export type ListAuditLogResponse = PaginatedResponse<CommandLogEntry>;
