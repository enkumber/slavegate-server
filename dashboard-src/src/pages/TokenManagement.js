import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * pages/TokenManagement.tsx
 * Token management + Model configuration page.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { TokenTable } from "../components/TokenTable";
import { GenerateTokenModal } from "../components/GenerateTokenModal";
const modelRoles = ["decision_llm", "vision_vlm"];
export function TokenManagement() {
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    // Model config state
    const [modelConfigs, setModelConfigs] = useState({ decision_llm: null, vision_vlm: null });
    const [modelDrafts, setModelDrafts] = useState({ decision_llm: {}, vision_vlm: {} });
    const [modelLoading, setModelLoading] = useState(true);
    const [modelMsg, setModelMsg] = useState(null);
    const fetchTokens = useCallback(async () => {
        try {
            const data = await api.get("/device-tokens/list");
            setTokens(data);
        }
        catch (err) {
            console.error("Failed to fetch tokens:", err);
        }
        finally {
            setLoading(false);
        }
    }, []);
    const fetchModels = useCallback(async () => {
        setModelLoading(true);
        try {
            const rows = await api.get("/server/models");
            const next = { decision_llm: null, vision_vlm: null };
            const nextDrafts = { decision_llm: {}, vision_vlm: {} };
            for (const row of rows) {
                next[row.role] = row;
                nextDrafts[row.role] = { ...row, credential: "" };
            }
            setModelConfigs(next);
            setModelDrafts(nextDrafts);
        }
        catch (err) {
            console.error("Failed to fetch models:", err);
        }
        finally {
            setModelLoading(false);
        }
    }, []);
    useEffect(() => { fetchTokens(); fetchModels(); }, [fetchTokens, fetchModels]);
    async function saveModel(role) {
        setModelMsg(null);
        const draft = modelDrafts[role];
        try {
            const body = {
                provider: draft.provider,
                endpoint: draft.endpoint || null,
                model: draft.model,
                enabled: Boolean(draft.enabled),
            };
            let updated = await api.patch(`/server/models/${role}`, body);
            if (draft.credential) {
                updated = await api.post(`/server/models/${role}/credential`, { credential: draft.credential });
            }
            else if (draft.credentialRef) {
                updated = await api.post(`/server/models/${role}/credential`, { credentialRef: draft.credentialRef });
            }
            setModelConfigs((prev) => ({ ...prev, [role]: updated }));
            setModelDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
            setModelMsg(`${role === "decision_llm" ? "Decision LLM" : "Vision VLM"} saved ✓`);
        }
        catch (err) {
            setModelMsg(err.message);
        }
    }
    async function testModel(role) {
        setModelMsg(null);
        try {
            const updated = await api.post(`/server/models/${role}/test`);
            setModelConfigs((prev) => ({ ...prev, [role]: updated }));
            setModelDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
            setModelMsg(`${role === "decision_llm" ? "Decision LLM" : "Vision VLM"} connection OK ✓`);
        }
        catch (err) {
            await fetchModels();
            setModelMsg(err.message);
        }
    }
    function updateDraft(role, key, value) {
        setModelDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
    }
    return (_jsxs("div", { style: { padding: "24px", maxWidth: "1100px", margin: "0 auto" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", fontSize: "22px", fontFamily: "monospace", margin: 0 }, children: "\uD83D\uDD11 Tokens & Models" }), _jsx("button", { onClick: () => setShowModal(true), style: {
                            background: "#4a9eff", border: "none", color: "#fff",
                            padding: "8px 20px", borderRadius: "4px", cursor: "pointer",
                            fontFamily: "monospace", fontSize: "14px", fontWeight: 600,
                        }, children: "+ Generate Token" })] }), loading ? (_jsx("div", { style: { textAlign: "center", padding: "40px", color: "#666" }, children: "Loading\u2026" })) : (_jsx("div", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", overflow: "hidden", marginBottom: "32px" }, children: _jsx(TokenTable, { tokens: tokens, onRevoked: fetchTokens }) })), _jsx("h2", { style: { color: "#fff", fontSize: "20px", fontFamily: "monospace", margin: "0 0 6px", borderBottom: "1px solid #2a2a4a", paddingBottom: "10px" }, children: "\uD83E\uDDE0 Server Models" }), _jsx("p", { style: { color: "#aaa", fontSize: "13px", fontFamily: "monospace", marginTop: 0, marginBottom: "16px" }, children: "Configure LLM/VLM providers. Stored credentials are never shown to phones or returned by the API." }), modelMsg && (_jsx("div", { style: { background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: modelMsg.includes("OK") || modelMsg.includes("saved") || modelMsg.includes("✓") ? "#8be28b" : "#ff9a9a", fontFamily: "monospace", fontSize: "13px" }, children: modelMsg })), modelLoading ? (_jsx("div", { style: { color: "#777", fontFamily: "monospace" }, children: "Loading models\u2026" })) : (_jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }, children: modelRoles.map((role) => {
                    const draft = modelDrafts[role] ?? {};
                    const config = modelConfigs[role];
                    return (_jsxs("section", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }, children: [_jsx("h3", { style: { fontSize: "16px", marginTop: 0, color: "#fff", fontFamily: "monospace" }, children: role === "decision_llm" ? "🧠 Decision LLM" : "👁️ Vision VLM" }), _jsxs("label", { style: labelStyle, children: [_jsx("input", { type: "checkbox", checked: Boolean(draft.enabled), onChange: (e) => updateDraft(role, "enabled", e.target.checked) }), " Enabled"] }), _jsx(MField, { label: "Provider", value: draft.provider ?? "", onChange: (v) => updateDraft(role, "provider", v), placeholder: "openai_compatible" }), _jsx(MField, { label: "Endpoint", value: draft.endpoint ?? "", onChange: (v) => updateDraft(role, "endpoint", v), placeholder: "https://host/v1" }), _jsx(MField, { label: "Model", value: draft.model ?? "", onChange: (v) => updateDraft(role, "model", v), placeholder: "model name" }), _jsx(MField, { label: "Credential ref", value: draft.credentialRef ?? "", onChange: (v) => updateDraft(role, "credentialRef", v), placeholder: "env:VAR_NAME or file:/path" }), _jsx(MField, { label: "New API key/token", type: "password", value: draft.credential ?? "", onChange: (v) => updateDraft(role, "credential", v), placeholder: config?.hasCredential ? "stored — leave blank to keep" : "paste token" }), _jsxs("div", { style: { color: "#888", fontSize: "11px", margin: "8px 0 14px", fontFamily: "monospace" }, children: ["Credential: ", config?.hasCredential ? `stored (${config.apiKeyFingerprint ?? "ref"})` : "missing", " \u00B7 Version: ", config?.version ?? "—", _jsx("br", {}), "Last test: ", config?.lastTestStatus ?? "never", " ", config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : "", config?.lastTestMessage && _jsxs("span", { children: [_jsx("br", {}), config.lastTestMessage] })] }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { style: primaryBtn, onClick: () => saveModel(role), children: "Save" }), _jsx("button", { style: secondaryBtn, onClick: () => testModel(role), children: "Test" })] })] }, role));
                }) })), showModal && (_jsx(GenerateTokenModal, { onClose: () => setShowModal(false), onGenerated: fetchTokens }))] }));
}
function MField({ label, value, onChange, placeholder, type = "text" }) {
    return (_jsxs("label", { style: labelStyle, children: [label, _jsx("input", { type: type, value: value, placeholder: placeholder, onChange: (e) => onChange(e.target.value), style: inputStyle })] }));
}
const labelStyle = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px", fontFamily: "monospace" };
const inputStyle = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryBtn = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryBtn = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
