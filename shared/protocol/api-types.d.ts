/**
 * shared/protocol/api-types.ts
 * REST API types shared between server and dashboard.
 */
import type { DeviceHealth, JobStatus, JobType, JobParams } from "./messages";
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
export type DeviceStatus = "pending" | "approved" | "online" | "offline" | "maintenance";
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
    lastSeenAt: string | null;
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
export type ListDevicesResponse = PaginatedResponse<Device>;
export type GetDeviceResponse = Device;
export type ApproveDeviceResponse = Device;
export type UpdateDeviceResponse = Device;
export interface DeleteDeviceResponse {
    deleted: true;
}
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
export type ListJobsResponse = PaginatedResponse<Job>;
export type GetJobResponse = Job;
export type CreateJobResponse = DispatchJobResponse;
export interface CancelJobResponse {
    cancelled: true;
}
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
    deviceIds: string[];
    mandatory?: boolean;
}
export interface DeployOtaResponse {
    dispatched: number;
    skipped: number;
}
export type ListReleasesResponse = PaginatedResponse<AgentRelease>;
export type OtaDeployResponse = DeployOtaResponse;
export interface CommandLogEntry {
    id: number;
    deviceId: string;
    commandType: JobType;
    commandParams: JobParams;
    resultStatus: JobStatus;
    executedAt: string;
}
export type ListAuditLogResponse = PaginatedResponse<CommandLogEntry>;
//# sourceMappingURL=api-types.d.ts.map