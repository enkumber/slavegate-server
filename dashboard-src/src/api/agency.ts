/**
 * api/agency.ts
 * API client for Marketing Agency endpoints.
 */

import { api } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  active: boolean;
  strategy: Record<string, unknown>;
  type: 'client' | 'farming';
  created_at: string;
  updated_at: string;
}

export interface Material {
  id: string;
  client_id: string | null;
  account_id: string | null;
  type: "image" | "video" | "text";
  url: string;
  description: string | null;
  uploaded_at: string;
  used: boolean;
  client_name?: string;
}

export interface Post {
  id: string;
  account_id: string;
  platform: string;
  status: "pending_approval" | "approved" | "rejected" | "published";
  content: {
    media_url?: string;
    caption?: string;
    hashtags?: string[];
    thumbnail_url?: string;
  };
  created_by: string;
  brief_id: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
  account_username?: string;
  account_platform?: string;
}

export interface Task {
  id: string;
  batch_id: string | null;
  account_id: string;
  device_id: string;
  scheduled_time: string;
  status: "queued" | "running" | "completed" | "failed" | "paused";
  routine: string;
  params: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  account_username?: string;
  account_platform?: string;
  device_name?: string;
}

export interface Report {
  id: string;
  type: "daily_analytics" | "weekly" | "anomaly";
  period: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AgencyStats {
  clients: { total: number; active: number };
  posts: { total: number; pending: number; approved: number; published: number; rejected: number };
  tasks: { total: number; queued: number; running: number; completed: number; failed: number };
  materials: { total: number; used: number; unused: number };
}

export interface HumanWorkflowCompileRequest {
  device_id: string;
  account_id?: string | null;
  intent: string;
}

export interface HumanWorkflowRunRequest extends HumanWorkflowCompileRequest {
  requestKey?: string;
  cacheKey?: string;
  compileJobId?: string;
}

export interface HumanWorkflowTarget {
  device_id: string;
  device_model: string | null;
  device_name: string | null;
  account_id: string | null;
  account_username: string | null;
  account_platform: string;
  client_id: string | null;
}

export interface HumanWorkflowCompileReadyResult {
  status?: "ready";
  requestKey: string;
  cacheHit: boolean;
  cacheKey?: string;
  source?: "cache" | "shortcut" | "llm";
  plan: {
    templateId?: string;
    version?: string;
    steps?: unknown[];
    actions?: unknown[];
    compiledPlan?: {
      steps?: unknown[];
      llmBudget?: Record<string, unknown>;
    };
  };
  safetyClass: "read_only" | "standard" | "destructive";
  platform: string;
  target: HumanWorkflowTarget;
  llmBudget?: Record<string, unknown>;
}

export interface HumanWorkflowCompileCompilingResult {
  status: "compiling";
  requestKey: string;
  compileJobId: string;
  retryAfterMs?: number;
  source: "llm";
}

export type HumanWorkflowCompileResult =
  | HumanWorkflowCompileReadyResult
  | HumanWorkflowCompileCompilingResult;

export interface HumanWorkflowCompileJobPendingResult {
  status: "queued" | "running";
  requestKey: string;
  compileJobId: string;
  retryAfterMs?: number;
}

export interface HumanWorkflowCompileJobFailedResult {
  status: "failed";
  requestKey: string;
  compileJobId: string;
  error: string;
  retryable: boolean;
  nextAction?: string;
}

export type HumanWorkflowCompileJobResult =
  | (HumanWorkflowCompileReadyResult & { status: "ready"; compileJobId?: string; retryAfterMs?: number })
  | HumanWorkflowCompileJobPendingResult
  | HumanWorkflowCompileJobFailedResult;

export interface HumanWorkflowRunResult {
  id: string;
  status: "queued" | "compiling" | "running" | "completed" | "failed" | "paused";
  taskId?: string;
  requestKey?: string;
  cacheKey?: string;
}

export interface AgencyWorkflowRun {
  id: string;
  client_id: string;
  account_id: string | null;
  device_id: string | null;
  platform: string;
  intent: string;
  safety_class: string;
  request_key: string;
  cache_key: string | null;
  status: "queued" | "compiling" | "running" | "completed" | "failed" | "cancelled";
  task_id: string | null;
  error: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export const agencyApi = {
  humanWorkflow: {
    compile: (data: HumanWorkflowCompileRequest) =>
      api.post<HumanWorkflowCompileResult>("/workflows/human/compile", data),
    getCompileJob: (id: string) =>
      api.get<HumanWorkflowCompileJobResult>(`/workflows/human/compile-jobs/${id}`),
    run: (data: HumanWorkflowRunRequest) => {
      const { device_id, account_id, intent, requestKey, cacheKey, compileJobId } = data;
      return api.post<HumanWorkflowRunResult>("/workflows/human/run", {
        device_id,
        account_id,
        intent,
        requestKey,
        cacheKey,
        compileJobId,
      });
    },
    getRun: (id: string) => api.get<AgencyWorkflowRun>(`/agency/workflow-runs/${id}`),
  },

  // Clients
  clients: {
    list: (params?: { page?: number; pageSize?: number; active?: boolean; type?: 'client' | 'farming' }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.active !== undefined) query.set("active", String(params.active));
      if (params?.type) query.set("type", params.type);
      return api.get<PaginatedResponse<Client>>(`/agency/clients?${query}`);
    },
    get: (id: string) => api.get<Client>(`/agency/clients/${id}`),
    create: (data: { name: string; strategy?: Record<string, unknown>; type?: 'client' | 'farming' }) =>
      api.post<Client>("/agency/clients", data),
    update: (id: string, data: { name?: string; active?: boolean; strategy?: Record<string, unknown> }) =>
      api.patch<Client>(`/agency/clients/${id}`, data),
  },

  // Materials
  materials: {
    list: (params?: { page?: number; pageSize?: number; clientId?: string; used?: boolean }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.clientId) query.set("clientId", params.clientId);
      if (params?.used !== undefined) query.set("used", String(params.used));
      return api.get<PaginatedResponse<Material>>(`/agency/materials?${query}`);
    },
    upload: async (file: File, data?: { clientId?: string; accountId?: string; description?: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (data?.clientId) formData.append("clientId", data.clientId);
      if (data?.accountId) formData.append("accountId", data.accountId);
      if (data?.description) formData.append("description", data.description);

      const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
      const token = localStorage.getItem("access_token");
      const res = await fetch(`${BASE_URL}/agency/materials`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Upload failed");
      return json.data as Material;
    },
    update: (id: string, data: { used?: boolean; description?: string }) =>
      api.patch<Material>(`/agency/materials/${id}`, data),
    delete: (id: string) => api.delete<{ deleted: boolean }>(`/agency/materials/${id}`),
  },

  // Posts
  posts: {
    list: (params?: { page?: number; pageSize?: number; status?: string; accountId?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.status) query.set("status", params.status);
      if (params?.accountId) query.set("accountId", params.accountId);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Post>>(`/agency/posts?${query}`);
    },
    get: (id: string) => api.get<Post>(`/agency/posts/${id}`),
    approve: (id: string) => api.patch<Post>(`/agency/posts/${id}`, { status: "approved" }),
    reject: (id: string) => api.patch<Post>(`/agency/posts/${id}`, { status: "rejected" }),
    update: (id: string, data: { status?: Post["status"]; content?: Post["content"] }) =>
      api.patch<Post>(`/agency/posts/${id}`, data),
  },

  // Tasks
  tasks: {
    list: (params?: { page?: number; pageSize?: number; status?: string; deviceId?: string; accountId?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.status) query.set("status", params.status);
      if (params?.deviceId) query.set("deviceId", params.deviceId);
      if (params?.accountId) query.set("accountId", params.accountId);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Task>>(`/agency/tasks?${query}`);
    },
    pause: (id: string) => api.patch<Task>(`/agency/tasks/${id}`, { status: "paused" }),
    resume: (id: string) => api.patch<Task>(`/agency/tasks/${id}`, { status: "queued" }),
  },

  // Reports
  reports: {
    list: (params?: { page?: number; pageSize?: number; type?: string; from?: string; to?: string }) => {
      const query = new URLSearchParams();
      if (params?.page) query.set("page", String(params.page));
      if (params?.pageSize) query.set("pageSize", String(params.pageSize));
      if (params?.type) query.set("type", params.type);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      return api.get<PaginatedResponse<Report>>(`/agency/reports?${query}`);
    },
    stats: () => api.get<AgencyStats>("/agency/reports/stats"),
  },
};
