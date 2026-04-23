/**
 * api/accounts.ts
 * API client for device accounts management.
 */
import { api } from "./client";
// ─── API ──────────────────────────────────────────────────────────────────────
export const accountsApi = {
    list: (params) => {
        const query = new URLSearchParams();
        if (params?.deviceId)
            query.set("deviceId", params.deviceId);
        if (params?.clientId)
            query.set("clientId", params.clientId);
        if (params?.platform)
            query.set("platform", params.platform);
        if (params?.status)
            query.set("status", params.status);
        if (params?.page)
            query.set("page", String(params.page));
        if (params?.pageSize)
            query.set("pageSize", String(params.pageSize));
        return api.get(`/accounts?${query}`);
    },
    get: (id) => api.get(`/accounts/${id}`),
    create: (data) => api.post("/accounts", {
        deviceId: data.deviceId,
        platform: data.platform,
        username: data.username,
        type: data.type || "farming",
        clientId: data.clientId || null,
    }),
    updateStatus: (id, status, notes) => api.patch(`/accounts/${id}/status`, { status, notes }),
    delete: (id) => api.delete(`/accounts/${id}`),
};
