import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * pages/TokenManagement.tsx
 * Token management page — list, generate, revoke API tokens.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { TokenTable } from "../components/TokenTable";
import { GenerateTokenModal } from "../components/GenerateTokenModal";
export function TokenManagement() {
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
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
    useEffect(() => { fetchTokens(); }, [fetchTokens]);
    return (_jsxs("div", { style: { padding: "24px", maxWidth: "960px", margin: "0 auto" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", fontSize: "22px", fontFamily: "monospace", margin: 0 }, children: "\uD83D\uDD11 API Tokens" }), _jsx("button", { onClick: () => setShowModal(true), style: {
                            background: "#4a9eff", border: "none", color: "#fff",
                            padding: "8px 20px", borderRadius: "4px", cursor: "pointer",
                            fontFamily: "monospace", fontSize: "14px", fontWeight: 600,
                        }, children: "+ Generate Token" })] }), loading ? (_jsx("div", { style: { textAlign: "center", padding: "40px", color: "#666" }, children: "Loading\u2026" })) : (_jsx("div", { style: { background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", overflow: "hidden" }, children: _jsx(TokenTable, { tokens: tokens, onRevoked: fetchTokens }) })), showModal && (_jsx(GenerateTokenModal, { onClose: () => setShowModal(false), onGenerated: fetchTokens }))] }));
}
