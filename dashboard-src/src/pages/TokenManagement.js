import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * pages/TokenManagement.tsx
 * Token management + Model configuration page.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { buildCredentialRequest, credentialSummary, draftFromConfig, modelConfigApi, modelRoles, roleLabel, } from "../api/modelConfig";
import { TokenTable } from "../components/TokenTable";
import { GenerateTokenModal } from "../components/GenerateTokenModal";
export function TokenManagement() {
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    // Model config state
    const [modelConfigs, setModelConfigs] = useState({ decision_llm: null, vision_vlm: null });
    const [modelDrafts, setModelDrafts] = useState({ decision_llm: draftFromConfig(null), vision_vlm: draftFromConfig(null) });
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
            const rows = await modelConfigApi.list();
            const next = { decision_llm: null, vision_vlm: null };
            const nextDrafts = { decision_llm: draftFromConfig(null), vision_vlm: draftFromConfig(null) };
            for (const row of rows) {
                next[row.role] = row;
                nextDrafts[row.role] = draftFromConfig(row);
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
            let updated = await modelConfigApi.update(role, draft);
            const credentialRequest = buildCredentialRequest(draft);
            if (credentialRequest)
                updated = await modelConfigApi.updateCredential(role, credentialRequest);
            setModelConfigs((prev) => ({ ...prev, [role]: updated }));
            setModelDrafts((prev) => ({ ...prev, [role]: draftFromConfig(updated) }));
            setModelMsg(`${roleLabel(role)} saved`);
        }
        catch (err) {
            setModelMsg(err.message);
        }
    }
    async function testModel(role) {
        setModelMsg(null);
        try {
            const updated = await modelConfigApi.test(role);
            setModelConfigs((prev) => ({ ...prev, [role]: updated }));
            setModelDrafts((prev) => ({ ...prev, [role]: draftFromConfig(updated) }));
            setModelMsg(`${roleLabel(role)} connection OK`);
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
                        }, children: "+ Generate Token" })] }), loading ? (_jsx("div", { style: { textAlign: "center", padding: "40px", color: "#666" }, children: "Loading\u2026" })) : (_jsx("div", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", overflow: "hidden", marginBottom: "32px" }, children: _jsx(TokenTable, { tokens: tokens, onRevoked: fetchTokens }) })), _jsx("h2", { style: { color: "#fff", fontSize: "20px", fontFamily: "monospace", margin: "0 0 6px", borderBottom: "1px solid #2a2a4a", paddingBottom: "10px" }, children: "\uD83E\uDDE0 Server Models" }), _jsx("p", { style: { color: "#aaa", fontSize: "13px", fontFamily: "monospace", marginTop: 0, marginBottom: "16px" }, children: "Configure LLM/VLM providers. Stored credentials are never shown to phones or returned by the API." }), modelMsg && (_jsx("div", { style: { background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: modelMsg.includes("OK") || modelMsg.includes("saved") ? "#8be28b" : "#ff9a9a", fontFamily: "monospace", fontSize: "13px" }, children: modelMsg })), modelLoading ? (_jsx("div", { style: { color: "#777", fontFamily: "monospace" }, children: "Loading models\u2026" })) : (_jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }, children: modelRoles.map((role) => {
                    const draft = modelDrafts[role];
                    const config = modelConfigs[role];
                    const testStatus = config?.lastTestStatus ?? "never";
                    return (_jsxs("section", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", marginBottom: "12px" }, children: [_jsx("h3", { style: { fontSize: "16px", margin: 0, color: "#fff", fontFamily: "monospace" }, children: role === "decision_llm" ? "Decision LLM" : "Vision VLM" }), _jsx("span", { style: statusPill(config), children: statusLabel(config) })] }), !config && _jsx("div", { style: warningBox, children: "Missing server row. Saving creates the role with disabled-safe defaults." }), config && !config.enabled && _jsx("div", { style: warningBox, children: "Disabled. Runtime calls fail closed until this role is enabled." }), _jsxs("label", { style: labelStyle, children: [_jsx("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => updateDraft(role, "enabled", e.target.checked) }), " Enabled"] }), _jsx(MField, { label: "Provider", value: draft.provider, onChange: (v) => updateDraft(role, "provider", v), placeholder: "openai_compatible" }), _jsx(MField, { label: "Endpoint", value: draft.endpoint, onChange: (v) => updateDraft(role, "endpoint", v), placeholder: "https://host/v1" }), _jsx(MField, { label: "Model", value: draft.model, onChange: (v) => updateDraft(role, "model", v), placeholder: "model name" }), _jsx(CredentialModePicker, { value: draft.credentialMode, onChange: (mode) => updateDraft(role, "credentialMode", mode) }), draft.credentialMode === "replace" && (_jsx(MField, { label: "New API key/token", type: "password", value: draft.credential, onChange: (v) => updateDraft(role, "credential", v), placeholder: "paste token; it is never shown again" })), draft.credentialMode === "reference" && (_jsx(MField, { label: "Credential reference", value: draft.credentialRef, onChange: (v) => updateDraft(role, "credentialRef", v), placeholder: "env:VAR_NAME or file:/path" })), draft.credentialMode === "clear" && _jsx("div", { style: dangerBox, children: "Saving clears the server-side credential for this role." }), _jsxs("div", { style: { color: "#888", fontSize: "11px", margin: "8px 0 14px", fontFamily: "monospace" }, children: ["Credential: ", credentialSummary(config), " \u00B7 Version: ", config?.version ?? "-", _jsx("br", {}), "Last test: ", testStatus, " ", config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : "", config?.lastTestMessage && _jsxs("span", { children: [_jsx("br", {}), config.lastTestMessage] })] }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { style: primaryBtn, onClick: () => saveModel(role), children: "Save" }), _jsx("button", { style: secondaryBtn, onClick: () => testModel(role), disabled: !config, title: !config ? "Save the role before testing" : "Test provider connection", children: "Test" })] })] }, role));
                }) })), showModal && (_jsx(GenerateTokenModal, { onClose: () => setShowModal(false), onGenerated: fetchTokens }))] }));
}
function MField({ label, value, onChange, placeholder, type = "text" }) {
    return (_jsxs("label", { style: labelStyle, children: [label, _jsx("input", { type: type, value: value, placeholder: placeholder, onChange: (e) => onChange(e.target.value), style: inputStyle })] }));
}
function CredentialModePicker({ value, onChange }) {
    const options = [
        { mode: "retain", label: "Retain" },
        { mode: "replace", label: "Replace" },
        { mode: "reference", label: "Reference" },
        { mode: "clear", label: "Clear" },
    ];
    return (_jsxs("fieldset", { style: fieldsetStyle, children: [_jsx("legend", { style: legendStyle, children: "Credential action" }), _jsx("div", { style: segmentedStyle, children: options.map((option) => {
                    const selected = value === option.mode;
                    return (_jsx("button", { type: "button", onClick: () => onChange(option.mode), "aria-pressed": selected, style: selected ? segmentActive : segmentButton, children: option.label }, option.mode));
                }) })] }));
}
const labelStyle = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px", fontFamily: "monospace" };
const inputStyle = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryBtn = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryBtn = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
const fieldsetStyle = { border: "0", padding: 0, margin: "0 0 10px" };
const legendStyle = { color: "#ccc", fontSize: "13px", marginBottom: "5px", fontFamily: "monospace", padding: 0 };
const segmentedStyle = { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "4px" };
const segmentButton = { background: "#0f0f23", border: "1px solid #33385a", color: "#c8d2ef", padding: "8px 6px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px" };
const segmentActive = { ...segmentButton, background: "#27456f", border: "1px solid #4a9eff", color: "#fff" };
const warningBox = { background: "#2a2412", border: "1px solid #6b5520", color: "#ffd783", padding: "8px", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace", marginBottom: "12px" };
const dangerBox = { background: "#32181e", border: "1px solid #7a2e3d", color: "#ffb4bf", padding: "8px", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace", marginBottom: "10px" };
function statusLabel(config) {
    if (!config)
        return "missing";
    if (!config.enabled)
        return "disabled";
    if (!(config.credentialConfigured ?? config.hasCredential))
        return "credential missing";
    if (config.lastTestStatus === "ok")
        return "test ok";
    if (config.lastTestStatus === "error")
        return "test error";
    return "not tested";
}
function statusPill(config) {
    const label = statusLabel(config);
    const color = label === "test ok" ? "#8be28b" : label === "test error" || label.includes("missing") ? "#ff9a9a" : "#ffd783";
    return {
        border: `1px solid ${color}`,
        color,
        borderRadius: "999px",
        padding: "3px 8px",
        fontFamily: "monospace",
        fontSize: "11px",
        whiteSpace: "nowrap",
    };
}
