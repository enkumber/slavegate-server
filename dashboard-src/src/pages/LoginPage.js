import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * LoginPage.tsx
 * JWT login form — single admin user (Phase 4 adds proper user management).
 */
import { useState } from "react";
import { api } from "../api/client";
export function LoginPage({ onLogin }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await api.login(username, password);
            onLogin();
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { style: {
            display: "flex", alignItems: "center", justifyContent: "center",
            minHeight: "100vh", background: "#0f0f23", fontFamily: "monospace",
        }, children: _jsxs("form", { onSubmit: handleSubmit, style: {
                background: "#1a1a2e", border: "1px solid #334155", borderRadius: "10px",
                padding: "32px", width: "320px", color: "#e2e8f0",
            }, children: [_jsx("h1", { style: { margin: "0 0 24px", fontSize: "18px", textAlign: "center" }, children: "\u26A1 Phone Network" }), _jsx("label", { style: { fontSize: "12px", color: "#94a3b8" }, children: "Username" }), _jsx("input", { type: "text", value: username, onChange: e => setUsername(e.target.value), autoComplete: "username", required: true, style: inputStyle }), _jsx("label", { style: { fontSize: "12px", color: "#94a3b8", display: "block", marginTop: "12px" }, children: "Password" }), _jsx("input", { type: "password", value: password, onChange: e => setPassword(e.target.value), autoComplete: "current-password", required: true, style: inputStyle }), error && (_jsxs("div", { style: { marginTop: "10px", color: "#ef4444", fontSize: "12px" }, children: ["\u274C ", error] })), _jsx("button", { type: "submit", disabled: loading, style: {
                        display: "block", width: "100%", marginTop: "20px",
                        background: "#3b82f6", border: "none", color: "#fff",
                        padding: "10px", borderRadius: "6px", fontFamily: "monospace",
                        fontSize: "14px", cursor: loading ? "wait" : "pointer",
                    }, children: loading ? "Signing in..." : "Sign In" })] }) }));
}
const inputStyle = {
    display: "block", width: "100%", marginTop: "4px",
    background: "#0f0f23", border: "1px solid #334155", color: "#e2e8f0",
    padding: "8px", borderRadius: "4px", fontFamily: "monospace",
    fontSize: "13px", boxSizing: "border-box",
};
