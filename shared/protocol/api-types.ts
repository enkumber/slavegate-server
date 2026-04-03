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

export type DeviceStatus =
  | "pending"    // registered, awaiting approval
  | "approved"   // approved, not yet connected
  | "online"     // connected and healthy
  | "offline"    // was online, lost connection
  | "maintenance"; // manually set, no jobs dispatched

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
  status?: Extract<DeviceStatus, "approved" | "maintenance">;
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
  verificationStrategy?: "local_only" | "local_with_screenshot" | "full_cascade" | "vlm_required";
  l1TimeoutMs?: number;
  l2SettleMs?: number;
}

export interface DispatchJobResponse {
  jobId: string;
  status: "queued";
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
