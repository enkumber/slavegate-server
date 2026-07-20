/**
 * api/agency.ts
 * API client for Marketing Agency endpoints.
 */
import { api } from "./client";
// ─── API ──────────────────────────────────────────────────────────────────────
export const agencyApi = {
    humanWorkflow: {
        compile: (data) => api.post("/workflows/human/compile", data),
        getCompileJob: (id) => api.get(`/workflows/human/compile-jobs/${id}`),
        retryCompileJob: (id) => api.post(`/workflows/human/compile-jobs/${id}/retry`, {}),
        run: (data) => {
            const { device_id, account_id, intent, requestKey, cacheKey, compileJobId } = data;
            return api.post("/workflows/human/run", {
                device_id,
                account_id,
                intent,
                requestKey,
                cacheKey,
                compileJobId,
            });
        },
        getRun: (id) => api.get(`/agency/workflow-runs/${id}`),
    },
    workflowRuns: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.status)
                query.set("status", params.status);
            if (params?.requestKey)
                query.set("requestKey", params.requestKey);
            if (params?.cacheKey)
                query.set("cacheKey", params.cacheKey);
            if (params?.deviceId)
                query.set("deviceId", params.deviceId);
            return api.get(`/agency/workflow-runs?${query}`);
        },
        get: (id) => api.get(`/agency/workflow-runs/${id}`),
        submitFeedback: (id, data) => api.post(`/agency/workflow-runs/${id}/feedback`, data),
        listStepCandidates: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.state)
                query.set("state", params.state);
            return api.get(`/agency/workflow-step-candidates?${query}`);
        },
        reviewStepCandidate: (id, data) => api.patch(`/agency/workflow-step-candidates/${id}/review`, data),
        validateStepCandidate: (id, data) => api.patch(`/agency/workflow-step-candidates/${id}/validate`, data),
    },
    stepLibrary: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.action)
                query.set("action", params.action);
            if (params?.intent)
                query.set("intent", params.intent);
            return api.get(`/agency/step-library?${query}`);
        },
        updatePromotion: (id, data) => api.patch(`/agency/step-library/${id}/promotion`, data),
        listPromotionEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.entryId)
                query.set("entryId", params.entryId);
            if (params?.action)
                query.set("action", params.action);
            if (params?.actor)
                query.set("actor", params.actor);
            if (params?.scope)
                query.set("scope", params.scope);
            return api.get(`/agency/step-library/promotion-events?${query}`);
        },
    },
    toolCatalog: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.category)
                query.set("category", params.category);
            if (params?.risk)
                query.set("risk", params.risk);
            if (params?.source)
                query.set("source", params.source);
            return api.get(`/agency/tool-catalog?${query}`);
        },
    },
    compilerKnowledge: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.type)
                query.set("type", params.type);
            if (params?.domain)
                query.set("domain", params.domain);
            if (params?.risk)
                query.set("risk", params.risk);
            if (params?.source)
                query.set("source", params.source);
            return api.get(`/agency/compiler-knowledge?${query}`);
        },
    },
    compilerPolicyGates: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.category)
                query.set("category", params.category);
            if (params?.state)
                query.set("state", params.state);
            if (params?.risk)
                query.set("risk", params.risk);
            if (params?.owner)
                query.set("owner", params.owner);
            return api.get(`/agency/compiler-policy-gates?${query}`);
        },
        update: (gateId, data) => api.patch(`/agency/compiler-policy-gates/${gateId}`, data),
        listEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.gateId)
                query.set("gateId", params.gateId);
            return api.get(`/agency/compiler-policy-gates/events?${query}`);
        },
    },
    compilerAwareness: {
        get: (params) => {
            const query = new URLSearchParams();
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.action)
                query.set("action", params.action);
            return api.get(`/agency/compiler-awareness?${query}`);
        },
        listEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.action)
                query.set("action", params.action);
            if (params?.source)
                query.set("source", params.source);
            return api.get(`/agency/compiler-awareness/events?${query}`);
        },
    },
    compilerControlPlane: {
        get: (params) => {
            const query = new URLSearchParams();
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.action)
                query.set("action", params.action);
            if (params?.deviceId)
                query.set("deviceId", params.deviceId);
            if (params?.scope)
                query.set("scope", params.scope);
            return api.get(`/agency/compiler-control-plane?${query}`);
        },
        listEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.action)
                query.set("action", params.action);
            if (params?.deviceId)
                query.set("deviceId", params.deviceId);
            return api.get(`/agency/compiler-control-plane/events?${query}`);
        },
    },
    workflowDefinitions: {
        list: (params) => {
            const query = new URLSearchParams();
            if (params?.status)
                query.set("status", params.status);
            if (params?.platform)
                query.set("platform", params.platform);
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.key)
                query.set("key", params.key);
            return api.get(`/agency/workflow-definitions?${query}`);
        },
        resolve: (params) => {
            const query = new URLSearchParams();
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.platform)
                query.set("platform", params.platform);
            if (params?.key)
                query.set("key", params.key);
            if (params?.scope)
                query.set("scope", params.scope);
            return api.get(`/agency/workflow-definitions/resolve?${query}`);
        },
        versions: (id) => api.get(`/agency/workflow-definitions/${id}/versions`),
        createVersion: (id, data) => api.post(`/agency/workflow-definitions/${id}/versions`, data),
        diff: (id, targetId) => {
            const query = new URLSearchParams();
            if (targetId)
                query.set("targetId", targetId);
            return api.get(`/agency/workflow-definitions/${id}/diff?${query}`);
        },
        impactPreview: (id) => api.get(`/agency/workflow-definitions/${id}/impact-preview`),
        hardening: (id, scope) => {
            const query = new URLSearchParams();
            if (scope)
                query.set("scope", scope);
            return api.get(`/agency/workflow-definitions/${id}/promotion-hardening?${query}`);
        },
        lifecycle: (id, data) => api.patch(`/agency/workflow-definitions/${id}/lifecycle`, data),
        promote: (id, data) => api.patch(`/agency/workflow-definitions/${id}/promotion`, data),
        rollback: (id, data) => api.post(`/agency/workflow-definitions/${id}/rollback`, data),
        rollbackPreview: (id) => api.get(`/agency/workflow-definitions/${id}/rollback-preview`),
        listPromotionEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.definitionId)
                query.set("definitionId", params.definitionId);
            if (params?.key)
                query.set("key", params.key);
            if (params?.action)
                query.set("action", params.action);
            if (params?.actor)
                query.set("actor", params.actor);
            return api.get(`/agency/workflow-definitions/promotion-events?${query}`);
        },
        listVersionEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.definitionId)
                query.set("definitionId", params.definitionId);
            if (params?.key)
                query.set("key", params.key);
            if (params?.action)
                query.set("action", params.action);
            if (params?.actor)
                query.set("actor", params.actor);
            return api.get(`/agency/workflow-definitions/version-events?${query}`);
        },
    },
    workflowValidationPipeline: {
        get: (params) => {
            const query = new URLSearchParams();
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.platform)
                query.set("platform", params.platform);
            if (params?.key)
                query.set("key", params.key);
            return api.get(`/agency/workflow-validation-pipeline?${query}`);
        },
        listEvents: (params) => {
            const query = new URLSearchParams();
            if (params?.page)
                query.set("page", String(params.page));
            if (params?.pageSize)
                query.set("pageSize", String(params.pageSize));
            if (params?.intent)
                query.set("intent", params.intent);
            if (params?.platform)
                query.set("platform", params.platform);
            if (params?.key)
                query.set("key", params.key);
            return api.get(`/agency/workflow-validation-pipeline/events?${query}`);
        },
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
