import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * components/TokenTable.tsx
 * Displays API tokens in a table with revoke buttons.
 */
import { useState } from "react";
import { api } from "../api/client";
export function TokenTable({ tokens, onRevoked }) {
    const [revoking, setRevoking] = useState(null);
    const handleRevoke = async (id) => {
        if (!confirm("Revoke this token? This cannot be undone."))
            return;
        setRevoking(id);
        try {
            await api.delete(`/device-tokens/${id}`);
            onRevoked();
        }
        catch (err) {
            alert(err.message || "Failed to revoke");
        }
        finally {
            setRevoking(null);
        }
    };
    const purposeColors = {
        openclaw_agent: "#4a9eff",
        admin: "#ff6b6b",
        monitoring: "#51cf66",
    };
    if (tokens.length === 0) {
        return (_jsx("div", { style: { textAlign: "center", padding: "40px", color: "#666" }, children: "No tokens found. Generate one above." }));
    }
    return (_jsxs("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "14px" }, children: [_jsx("thead", { children: _jsxs("tr", { style: { borderBottom: "1px solid #2a2a4a" }, children: [_jsx("th", { style: thStyle, children: "Hash" }), _jsx("th", { style: thStyle, children: "Purpose" }), _jsx("th", { style: thStyle, children: "Created" }), _jsx("th", { style: thStyle, children: "Expires" }), _jsx("th", { style: thStyle, children: "Status" }), _jsx("th", { style: thStyle, children: "Action" })] }) }), _jsx("tbody", { children: tokens.map((t) => (_jsxs("tr", { style: { borderBottom: "1px solid #1a1a2e" }, children: [_jsx("td", { style: tdStyle, children: _jsx("code", { style: { color: "#aaa" }, children: t.token_hash_truncated }) }), _jsx("td", { style: tdStyle, children: _jsx("span", { style: {
                                    background: purposeColors[t.purpose] ?? "#888",
                                    color: "#fff",
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    fontSize: "12px",
                                    fontWeight: 600,
                                }, children: t.purpose }) }), _jsx("td", { style: tdStyle, children: new Date(t.created_at).toLocaleDateString() }), _jsx("td", { style: tdStyle, children: new Date(t.expires_at).toLocaleDateString() }), _jsx("td", { style: tdStyle, children: t.revoked
                                ? _jsx("span", { style: { color: "#ff6b6b" }, children: "Revoked" })
                                : new Date(t.expires_at) < new Date()
                                    ? _jsx("span", { style: { color: "#888" }, children: "Expired" })
                                    : _jsx("span", { style: { color: "#51cf66" }, children: "Active" }) }), _jsx("td", { style: tdStyle, children: !t.revoked && (_jsx("button", { onClick: () => handleRevoke(t.id), disabled: revoking === t.id, style: {
                                    background: "transparent",
                                    border: "1px solid #ff6b6b",
                                    color: "#ff6b6b",
                                    padding: "4px 12px",
                                    borderRadius: "4px",
                                    cursor: revoking === t.id ? "wait" : "pointer",
                                    fontSize: "12px",
                                    fontFamily: "monospace",
                                }, children: revoking === t.id ? "Revoking…" : "Revoke" })) })] }, t.id))) })] }));
}
const thStyle = {
    textAlign: "left",
    padding: "10px 12px",
    color: "#888",
    fontWeight: 500,
    fontFamily: "monospace",
    fontSize: "12px",
    textTransform: "uppercase",
};
const tdStyle = {
    padding: "10px 12px",
    color: "#ccc",
};
