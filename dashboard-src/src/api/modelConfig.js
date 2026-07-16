import { api } from "./client";
export const modelRoles = ["decision_llm", "vision_vlm"];
const forbiddenResponseKeys = ["apiKey", "api_key", "apiKeyEncrypted", "api_key_encrypted", "credentialRef", "credential_ref"];
export function roleLabel(role) {
    return role === "decision_llm" ? "Decision LLM" : "Vision VLM";
}
export function emptyDraft() {
    return {
        provider: "",
        endpoint: "",
        model: "",
        enabled: false,
        credentialMode: "retain",
        credential: "",
        credentialRef: "",
    };
}
export function draftFromConfig(config) {
    if (!config)
        return emptyDraft();
    return {
        provider: config.provider,
        endpoint: config.endpoint ?? "",
        model: config.model,
        enabled: config.enabled,
        credentialMode: "retain",
        credential: "",
        credentialRef: "",
    };
}
export function buildModelPatch(draft) {
    return {
        provider: draft.provider.trim(),
        endpoint: draft.endpoint.trim() || null,
        model: draft.model.trim(),
        enabled: draft.enabled,
    };
}
export function buildCredentialRequest(draft) {
    if (draft.credentialMode === "retain")
        return null;
    if (draft.credentialMode === "clear")
        return { credentialRef: null };
    if (draft.credentialMode === "replace") {
        const credential = draft.credential.trim();
        if (!credential)
            throw new Error("Enter a new API key/token or choose retain.");
        return { credential };
    }
    const credentialRef = draft.credentialRef.trim();
    if (!credentialRef)
        throw new Error("Enter an env: or file: credential reference, or choose retain.");
    return { credentialRef };
}
export function assertRedactedModelConfig(config) {
    const payload = config;
    for (const key of forbiddenResponseKeys) {
        if (payload[key] !== undefined)
            throw new Error(`Model config API returned forbidden secret field: ${key}`);
    }
    if (payload.credential !== undefined && payload.credential !== null && payload.credential !== "redacted") {
        throw new Error("Model config API returned an unredacted credential value");
    }
    return config;
}
export function credentialSummary(config) {
    if (!config)
        return "Missing config row";
    const configured = config.credentialConfigured ?? config.hasCredential ?? false;
    if (!configured)
        return "Missing credential";
    if (config.credentialRefType)
        return `Stored as ${config.credentialRefType}`;
    if (config.apiKeyFingerprint)
        return `Stored secret ${config.apiKeyFingerprint}`;
    if (config.lastFour)
        return `Stored secret ending ${config.lastFour}`;
    return "Stored secret";
}
export const modelConfigApi = {
    async list() {
        const rows = await api.get("/server/models");
        return rows.map(assertRedactedModelConfig);
    },
    async update(role, draft) {
        const config = await api.patch(`/server/models/${role}`, buildModelPatch(draft));
        return assertRedactedModelConfig(config);
    },
    async updateCredential(role, request) {
        const config = await api.post(`/server/models/${role}/credential`, request);
        return assertRedactedModelConfig(config);
    },
    async test(role) {
        const config = await api.post(`/server/models/${role}/test`);
        return assertRedactedModelConfig(config);
    },
};
