import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * components/GenerateTokenModal.tsx
 * Modal dialog for generating a new API token with purpose selection.
 */
import { useState } from "react";
import { api } from "../api/client";
export function GenerateTokenModal({ onClose, onGenerated }) {
    const [purpose, setPurpose] = useState("openclaw_agent");
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [copied, setCopied] = useState(false);
    const handleGenerate = async () => {
        setLoading(true);
        try {
            const data = await api.post("/device-tokens/generate", { purpose });
            setResult(data);
            onGenerated();
        }
        catch (err) {
            alert(err.message || "Failed to generate token");
        }
        finally {
            setLoading(false);
        }
    };
    const handleCopy = () => {
        if (result) {
            navigator.clipboard.writeText(result.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };
    return (_jsx("div", { style: {
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
        }, onClick: onClose, children: _jsxs("div", { style: {
                background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px",
                padding: "24px", width: "480px", maxWidth: "90vw",
            }, onClick: (e) => e.stopPropagation(), children: [_jsx("h2", { style: { color: "#fff", margin: "0 0 20px 0", fontSize: "18px", fontFamily: "monospace" }, children: "\uD83D\uDD11 Generate API Token" }), !result ? (_jsxs(_Fragment, { children: [_jsx("label", { style: { color: "#888", fontSize: "13px", display: "block", marginBottom: "6px", fontFamily: "monospace" }, children: "Purpose" }), _jsxs("select", { value: purpose, onChange: (e) => setPurpose(e.target.value), style: {
                                width: "100%", padding: "8px 12px", background: "#0f0f23", border: "1px solid #2a2a4a",
                                color: "#fff", borderRadius: "4px", fontSize: "14px", fontFamily: "monospace",
                                marginBottom: "20px",
                            }, children: [_jsx("option", { value: "openclaw_agent", children: "openclaw_agent" }), _jsx("option", { value: "admin", children: "admin" }), _jsx("option", { value: "monitoring", children: "monitoring" })] }), _jsxs("div", { style: { display: "flex", gap: "12px", justifyContent: "flex-end" }, children: [_jsx("button", { onClick: onClose, style: cancelBtnStyle, children: "Cancel" }), _jsx("button", { onClick: handleGenerate, disabled: loading, style: genBtnStyle, children: loading ? "Generating…" : "Generate" })] })] })) : (_jsxs(_Fragment, { children: [_jsx("p", { style: { color: "#51cf66", fontSize: "13px", fontFamily: "monospace", marginBottom: "12px" }, children: "\u2705 Token generated! Copy it now \u2014 it won't be shown again." }), _jsx("div", { style: {
                                background: "#0f0f23", border: "1px solid #2a2a4a", borderRadius: "4px",
                                padding: "12px", fontFamily: "monospace", fontSize: "13px", color: "#ccc",
                                wordBreak: "break-all", marginBottom: "12px", position: "relative",
                            }, children: result.token }), _jsxs("div", { style: { display: "flex", gap: "12px", justifyContent: "space-between", alignItems: "center" }, children: [_jsxs("span", { style: { color: "#888", fontSize: "12px" }, children: ["Expires: ", new Date(result.expires_at).toLocaleDateString()] }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { onClick: handleCopy, style: genBtnStyle, children: copied ? "✓ Copied!" : "📋 Copy" }), _jsx("button", { onClick: onClose, style: cancelBtnStyle, children: "Close" })] })] })] }))] }) }));
}
const genBtnStyle = {
    background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px",
    borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "13px",
};
const cancelBtnStyle = {
    background: "transparent", border: "1px solid #2a2a4a", color: "#888", padding: "8px 16px",
    borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "13px",
};
