import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../api/client";
const roles = ["decision_llm", "vision_vlm"];
export function ModelConfigPage() {
    const [configs, setConfigs] = useState({ decision_llm: null, vision_vlm: null });
    const [drafts, setDrafts] = useState({ decision_llm: {}, vision_vlm: {} });
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState(null);
    async function load() {
        setLoading(true);
        try {
            const rows = await api.get("/server/models");
            const next = { decision_llm: null, vision_vlm: null };
            const nextDrafts = { decision_llm: {}, vision_vlm: {} };
            for (const row of rows) {
                next[row.role] = row;
                nextDrafts[row.role] = { ...row, credential: "" };
            }
            setConfigs(next);
            setDrafts(nextDrafts);
        }
        catch (err) {
            setMessage(err.message);
        }
        finally {
            setLoading(false);
        }
    }
    useEffect(() => { load(); }, []);
    async function save(role) {
        setMessage(null);
        const draft = drafts[role];
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
            setConfigs((prev) => ({ ...prev, [role]: updated }));
            setDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
            setMessage(`${role} saved`);
        }
        catch (err) {
            setMessage(err.message);
        }
    }
    async function test(role) {
        setMessage(null);
        try {
            const updated = await api.post(`/server/models/${role}/test`);
            setConfigs((prev) => ({ ...prev, [role]: updated }));
            setDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
            setMessage(`${role} connection OK`);
        }
        catch (err) {
            await load();
            setMessage(err.message);
        }
    }
    function updateDraft(role, key, value) {
        setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
    }
    return (_jsxs("div", { style: { padding: "24px", maxWidth: "1100px", margin: "0 auto", color: "#fff", fontFamily: "monospace" }, children: [_jsx("h1", { style: { fontSize: "22px", marginBottom: "6px" }, children: "\uD83D\uDD11 Tokens / Models" }), _jsx("p", { style: { color: "#aaa", marginTop: 0 }, children: "Configure server-side LLM/VLM providers. Stored credentials are never shown to phones or returned by the API." }), message && _jsx("div", { style: { background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: message.includes("OK") || message.includes("saved") ? "#8be28b" : "#ff9a9a" }, children: message }), loading ? _jsx("div", { style: { color: "#777" }, children: "Loading\u2026" }) : (_jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }, children: roles.map((role) => {
                    const draft = drafts[role] ?? {};
                    const config = configs[role];
                    return (_jsxs("section", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }, children: [_jsx("h2", { style: { fontSize: "18px", marginTop: 0 }, children: role === "decision_llm" ? "🧠 Decision LLM" : "👁️ Vision VLM" }), _jsxs("label", { style: labelStyle, children: [_jsx("input", { type: "checkbox", checked: Boolean(draft.enabled), onChange: (e) => updateDraft(role, "enabled", e.target.checked) }), " Enabled"] }), _jsx(Field, { label: "Provider", value: draft.provider ?? "", onChange: (v) => updateDraft(role, "provider", v), placeholder: "openai_compatible" }), _jsx(Field, { label: "Endpoint", value: draft.endpoint ?? "", onChange: (v) => updateDraft(role, "endpoint", v), placeholder: "https://host/v1 or .../chat/completions" }), _jsx(Field, { label: "Model", value: draft.model ?? "", onChange: (v) => updateDraft(role, "model", v), placeholder: "model name" }), _jsx(Field, { label: "Credential ref", value: draft.credentialRef ?? "", onChange: (v) => updateDraft(role, "credentialRef", v), placeholder: "env:VAR_NAME or file:/path/to/token" }), _jsx(Field, { label: "New API key/token", type: "password", value: draft.credential ?? "", onChange: (v) => updateDraft(role, "credential", v), placeholder: config?.hasCredential ? "stored — leave blank to keep" : "paste token" }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", margin: "8px 0 14px" }, children: ["Credential: ", config?.hasCredential ? `stored (${config.apiKeyFingerprint ?? "ref"})` : "missing", _jsx("br", {}), "Version: ", config?.version ?? "—", " \u00B7 Last test: ", config?.lastTestStatus ?? "never", " ", config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : "", _jsx("br", {}), config?.lastTestMessage && _jsx("span", { children: config.lastTestMessage })] }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { style: primaryButton, onClick: () => save(role), children: "Save" }), _jsx("button", { style: secondaryButton, onClick: () => test(role), children: "Test connection" })] })] }, role));
                }) }))] }));
}
function Field({ label, value, onChange, placeholder, type = "text" }) {
    return _jsxs("label", { style: labelStyle, children: [label, _jsx("input", { type: type, value: value, placeholder: placeholder, onChange: (e) => onChange(e.target.value), style: inputStyle })] });
}
const labelStyle = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px" };
const inputStyle = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryButton = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryButton = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
