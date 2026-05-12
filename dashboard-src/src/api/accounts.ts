/**
 * api/accounts.ts
 * API client for device accounts management.
 */

import { api } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  deviceId: string | null;
  platform: "instagram" | "tiktok" | "facebook" | "twitter" | "reddit";
  username: string;
  status: "active" | "paused" | "blocked" | "warming" | "cooldown" | "created";
  type?: "business" | "farming";
  clientId?: string | null;
  strategy?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateAccountData {
  deviceId: string;
  platform: Account["platform"];
  username: string;
  type?: Account["type"];
  clientId?: string;
}

export interface UpdateAccountData {
  status?: Account["status"];
  type?: Account["type"];
  clientId?: string | null;
  notes?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export const accountsApi = {
  list: (params?: { deviceId?: string; clientId?: string; platform?: string; status?: string; page?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params?.deviceId) query.set("deviceId", params.deviceId);
    if (params?.clientId) query.set("clientId", params.clientId);
    if (params?.platform) query.set("platform", params.platform);
    if (params?.status) query.set("status", params.status);
    if (params?.page) query.set("page", String(params.page));
    if (params?.pageSize) query.set("pageSize", String(params.pageSize));
    return api.get<PaginatedResponse<Account>>(`/accounts?${query}`);
  },

  get: (id: string) => api.get<Account>(`/accounts/${id}`),

  create: (data: CreateAccountData) =>
    api.post<Account>("/accounts", {
      deviceId: data.deviceId,
      platform: data.platform,
      username: data.username,
      type: data.type || "farming",
      clientId: data.clientId || null,
    }),

  updateStatus: (id: string, status: Account["status"], notes?: string) =>
    api.patch<Account>(`/accounts/${id}/status`, { status, notes }),

  delete: (id: string) => api.delete<{ deleted: boolean }>(`/accounts/${id}`),
};
