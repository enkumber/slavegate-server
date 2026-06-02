/**
 * api/agency.ts
 * API client for Marketing Agency endpoints.
 */
import { api } from "./client";
// ─── API ──────────────────────────────────────────────────────────────────────
export const agencyApi = {
    humanWorkflow: {
        compile: (data) => api.post("/workflows/human/compile", data),
        run: (data) => api.post("/workflows/human/run", data),
        getRun: (id) => api.get(`/agency/workflow-runs/${id}`),
    },
    // Clients
    clients: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.active !== undefined)
                query.set("active", String(params.active));
            if (params?.type)
                query.set("type", params.type);
            return api.get(`/agency/clients?${query}`);
        },
        get: (id) => api.get(`/agency/clients/${id}`),
        create: (data) => api.post("/agency/clients", data),
        update: (id, data) => api.patch(`/agency/clients/${id}`, data),
    },
    // Materials
    materials: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.clientId)
                query.set("clientId", params.clientId);
            if (params?.used !== undefined)
                query.set("used", String(params.used));
            return api.get(`/agency/materials?${query}`);
        },
        upload: async (file, data) => {
            const formData = new FormData();
            formData.append("file", file);
            if (data?.clientId)
                formData.append("clientId", data.clientId);
            if (data?.accountId)
                formData.append("accountId", data.accountId);
            if (data?.description)
                formData.append("description", data.description);
            const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
            const token = localStorage.getItem("access_token");
            const res = await fetch(`${BASE_URL}/agency/materials`, {
                method: "POST",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                body: formData,
            });
            const json = await res.json();
            if (!json.ok)
                throw new Error(json.error ?? "Upload failed");
            return json.data;
        },
        update: (id, data) => api.patch(`/agency/materials/${id}`, data),
        delete: (id) => api.delete(`/agency/materials/${id}`),
    },
    // Posts
    posts: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.status)
                query.set("status", params.status);
            if (params?.accountId)
                query.set("accountId", params.accountId);
            if (params?.from)
                query.set("from", params.from);
            if (params?.to)
                query.set("to", params.to);
            return api.get(`/agency/posts?${query}`);
        },
        get: (id) => api.get(`/agency/posts/${id}`),
        approve: (id) => api.patch(`/agency/posts/${id}`, { status: "approved" }),
        reject: (id) => api.patch(`/agency/posts/${id}`, { status: "rejected" }),
        update: (id, data) => api.patch(`/agency/posts/${id}`, data),
    },
    // Tasks
    tasks: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.status)
                query.set("status", params.status);
            if (params?.deviceId)
                query.set("deviceId", params.deviceId);
            if (params?.accountId)
                query.set("accountId", params.accountId);
            if (params?.from)
                query.set("from", params.from);
            if (params?.to)
                query.set("to", params.to);
            return api.get(`/agency/tasks?${query}`);
        },
        pause: (id) => api.patch(`/agency/tasks/${id}`, { status: "paused" }),
        resume: (id) => api.patch(`/agency/tasks/${id}`, { status: "queued" }),
    },
    // Reports
    reports: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.type)
                query.set("type", params.type);
            if (params?.from)
                query.set("from", params.from);
            if (params?.to)
                query.set("to", params.to);
            return api.get(`/agency/reports?${query}`);
        },
        stats: () => api.get("/agency/reports/stats"),
    },
};
