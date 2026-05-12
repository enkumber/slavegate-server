import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * AccountsModal.tsx
 * Modal for managing accounts on a device — list, add, edit status, delete.
 */
import { useState, useEffect, useCallback } from "react";
import { accountsApi } from "../api/accounts";
import { agencyApi } from "../api/agency";
// ─── Platform Config ──────────────────────────────────────────────────────────
const PLATFORMS = [
    { value: "instagram", label: "Instagram", icon: "📸", color: "#E1306C" },
    { value: "tiktok", label: "TikTok", icon: "🎵", color: "#00f2ea" },
    { value: "facebook", label: "Facebook", icon: "📘", color: "#1877F2" },
    { value: "twitter", label: "Twitter", icon: "🐦", color: "#1DA1F2" },
    { value: "reddit", label: "Reddit", icon: "🔗", color: "#FF4500" },
];
const STATUS_CONFIG = {
    created: { color: "#9ca3af", bg: "#1f1f1f", label: "Created" },
    active: { color: "#4ade80", bg: "#0d3320", label: "Active" },
    paused: { color: "#fbbf24", bg: "#3d3d00", label: "Paused" },
    blocked: { color: "#f87171", bg: "#3d1515", label: "Blocked" },
    warming: { color: "#60a5fa", bg: "#1e3a5f", label: "Warming" },
    cooldown: { color: "#c4b5fd", bg: "#2e1065", label: "Cooldown" },
};
// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.active;
    return (_jsx("span", { style: {
            padding: "2px 8px",
            borderRadius: "4px",
            fontSize: "10px",
            fontWeight: 500,
            background: config.bg,
            color: config.color,
            textTransform: "uppercase",
        }, children: config.label }));
}
// ─── Platform Badge ───────────────────────────────────────────────────────────
function PlatformBadge({ platform }) {
    const p = PLATFORMS.find((x) => x.value === platform) || PLATFORMS[0];
    return (_jsxs("span", { style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 8px",
            borderRadius: "4px",
            fontSize: "10px",
            background: `${p.color}20`,
            color: p.color,
        }, children: [p.icon, " ", p.label] }));
}
function AddAccountForm({ deviceId, clients, onAdd, onCancel }) {
    const [platform, setPlatform] = useState("instagram");
    const [username, setUsername] = useState("");
    const [type, setType] = useState("farming");
    const [clientId, setClientId] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!username.trim()) {
            setError("Username is required");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await accountsApi.create({
                deviceId,
                platform,
                username: username.trim().replace(/^@/, ""),
                type,
                clientId: clientId || undefined,
            });
            onAdd();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("form", { onSubmit: handleSubmit, style: { padding: "16px", background: "#0a0a0a", borderRadius: "8px" }, children: [_jsx("h4", { style: { color: "#fff", margin: "0 0 16px 0", fontSize: "14px" }, children: "Add Account" }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }, children: [_jsxs("div", { children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }, children: "Platform" }), _jsx("select", { value: platform, onChange: (e) => setPlatform(e.target.value), style: {
                                    width: "100%",
                                    padding: "8px",
                                    background: "#1a1a1a",
                                    border: "1px solid #333",
                                    borderRadius: "4px",
                                    color: "#fff",
                                    fontSize: "12px",
                                }, children: PLATFORMS.map((p) => (_jsxs("option", { value: p.value, children: [p.icon, " ", p.label] }, p.value))) })] }), _jsxs("div", { children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }, children: "Type" }), _jsxs("select", { value: type, onChange: (e) => setType(e.target.value), style: {
                                    width: "100%",
                                    padding: "8px",
                                    background: "#1a1a1a",
                                    border: "1px solid #333",
                                    borderRadius: "4px",
                                    color: "#fff",
                                    fontSize: "12px",
                                }, children: [_jsx("option", { value: "farming", children: "\uD83C\uDF31 Farming" }), _jsx("option", { value: "business", children: "\uD83D\uDCBC Business" })] })] })] }), _jsxs("div", { style: { marginBottom: "12px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }, children: "Username" }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), placeholder: "@username", style: {
                            width: "100%",
                            padding: "8px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "4px",
                            color: "#fff",
                            fontSize: "12px",
                            fontFamily: "monospace",
                        } })] }), _jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }, children: "Client (optional)" }), _jsxs("select", { value: clientId, onChange: (e) => setClientId(e.target.value), style: {
                            width: "100%",
                            padding: "8px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "4px",
                            color: "#fff",
                            fontSize: "12px",
                        }, children: [_jsx("option", { value: "", children: "No client" }), clients.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id)))] })] }), error && (_jsxs("div", { style: { color: "#f87171", fontSize: "12px", marginBottom: "12px" }, children: ["\u26A0\uFE0F ", error] })), _jsxs("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" }, children: [_jsx("button", { type: "button", onClick: onCancel, style: {
                            padding: "8px 16px",
                            background: "#333",
                            border: "none",
                            borderRadius: "4px",
                            color: "#ccc",
                            cursor: "pointer",
                            fontSize: "12px",
                        }, children: "Cancel" }), _jsx("button", { type: "submit", disabled: saving, style: {
                            padding: "8px 16px",
                            background: saving ? "#444" : "#2563eb",
                            border: "none",
                            borderRadius: "4px",
                            color: "#fff",
                            cursor: saving ? "not-allowed" : "pointer",
                            fontSize: "12px",
                        }, children: saving ? "Adding..." : "Add Account" })] })] }));
}
function AccountRow({ account, onStatusChange, onDelete }) {
    const [acting, setActing] = useState(false);
    const handleStatusChange = async (newStatus) => {
        setActing(true);
        try {
            await onStatusChange(account.id, newStatus);
        }
        finally {
            setActing(false);
        }
    };
    const handleDelete = async () => {
        if (!confirm(`Delete account @${account.username}?`))
            return;
        setActing(true);
        try {
            await onDelete(account.id);
        }
        finally {
            setActing(false);
        }
    };
    return (_jsxs("div", { style: {
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            gap: "12px",
            alignItems: "center",
            padding: "12px",
            background: "#111",
            borderRadius: "6px",
            border: "1px solid #222",
            opacity: acting ? 0.6 : 1,
        }, children: [_jsxs("div", { children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }, children: [_jsxs("span", { style: { color: "#fff", fontSize: "13px", fontFamily: "monospace" }, children: ["@", account.username] }), _jsx(PlatformBadge, { platform: account.platform })] }), _jsxs("div", { style: { display: "flex", gap: "8px", alignItems: "center" }, children: [_jsx(StatusBadge, { status: account.status }), _jsxs("span", { style: { color: "#666", fontSize: "10px" }, children: [account.type === "business" ? "💼" : "🌱", " ", account.type] })] })] }), _jsxs("select", { value: account.status, onChange: (e) => handleStatusChange(e.target.value), disabled: acting, style: {
                    padding: "6px 10px",
                    background: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: "4px",
                    color: "#ccc",
                    fontSize: "11px",
                    cursor: acting ? "not-allowed" : "pointer",
                }, children: [_jsx("option", { value: "active", children: "Active" }), _jsx("option", { value: "paused", children: "Paused" }), _jsx("option", { value: "warming", children: "Warming" }), _jsx("option", { value: "cooldown", children: "Cooldown" }), _jsx("option", { value: "blocked", children: "Blocked" })] }), _jsx("button", { onClick: handleDelete, disabled: acting, style: {
                    padding: "6px 10px",
                    background: "transparent",
                    border: "1px solid #7f1d1d",
                    borderRadius: "4px",
                    color: "#f87171",
                    cursor: acting ? "not-allowed" : "pointer",
                    fontSize: "11px",
                }, children: "\uD83D\uDDD1\uFE0F" })] }));
}
export function AccountsModal({ deviceId, deviceName, onClose }) {
    const [accounts, setAccounts] = useState([]);
    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showAddForm, setShowAddForm] = useState(false);
    const fetchData = useCallback(async () => {
        try {
            const [accountsData, clientsData] = await Promise.all([
                accountsApi.list({ deviceId, pageSize: 50 }),
                agencyApi.clients.list({ active: true, pageSize: 100 }),
            ]);
            setAccounts(accountsData.items);
            setClients(clientsData.items);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [deviceId]);
    useEffect(() => {
        fetchData();
    }, [fetchData]);
    const handleStatusChange = async (id, status) => {
        try {
            await accountsApi.updateStatus(id, status);
            await fetchData();
        }
        catch (e) {
            alert(`Failed to update status: ${e.message}`);
        }
    };
    const handleDelete = async (id) => {
        try {
            await accountsApi.delete(id);
            await fetchData();
        }
        catch (e) {
            alert(`Failed to delete: ${e.message}`);
        }
    };
    const handleAdd = () => {
        setShowAddForm(false);
        fetchData();
    };
    return (_jsx("div", { style: {
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
        }, onClick: onClose, children: _jsxs("div", { style: {
                background: "#0a0a0a",
                borderRadius: "12px",
                border: "1px solid #333",
                width: "600px",
                maxHeight: "80vh",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
            }, onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { style: {
                        padding: "16px 20px",
                        borderBottom: "1px solid #222",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                    }, children: [_jsxs("div", { children: [_jsx("h3", { style: { color: "#fff", margin: 0, fontSize: "16px" }, children: "\uD83D\uDCF1 Accounts" }), _jsx("div", { style: { color: "#666", fontSize: "12px", marginTop: "4px" }, children: deviceName })] }), _jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [_jsx("button", { onClick: () => setShowAddForm(!showAddForm), style: {
                                        padding: "6px 14px",
                                        background: showAddForm ? "#333" : "#2563eb",
                                        border: "none",
                                        borderRadius: "4px",
                                        color: "#fff",
                                        cursor: "pointer",
                                        fontSize: "12px",
                                    }, children: showAddForm ? "Cancel" : "+ Add" }), _jsx("button", { onClick: onClose, style: {
                                        background: "none",
                                        border: "none",
                                        color: "#666",
                                        fontSize: "20px",
                                        cursor: "pointer",
                                    }, children: "\u00D7" })] })] }), _jsxs("div", { style: { padding: "16px 20px", overflowY: "auto", flex: 1 }, children: [showAddForm && (_jsx("div", { style: { marginBottom: "16px" }, children: _jsx(AddAccountForm, { deviceId: deviceId, clients: clients, onAdd: handleAdd, onCancel: () => setShowAddForm(false) }) })), error && (_jsxs("div", { style: { color: "#f87171", fontSize: "12px", marginBottom: "16px" }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "24px" }, children: "Loading..." })) : accounts.length === 0 ? (_jsxs("div", { style: { color: "#666", textAlign: "center", padding: "24px" }, children: ["No accounts on this device yet.", _jsx("br", {}), _jsx("button", { onClick: () => setShowAddForm(true), style: {
                                        marginTop: "12px",
                                        padding: "8px 16px",
                                        background: "#2563eb",
                                        border: "none",
                                        borderRadius: "4px",
                                        color: "#fff",
                                        cursor: "pointer",
                                        fontSize: "12px",
                                    }, children: "+ Add first account" })] })) : (_jsx("div", { style: { display: "flex", flexDirection: "column", gap: "8px" }, children: accounts.map((account) => (_jsx(AccountRow, { account: account, onStatusChange: handleStatusChange, onDelete: handleDelete }, account.id))) }))] }), accounts.length > 0 && (_jsxs("div", { style: {
                        padding: "12px 20px",
                        borderTop: "1px solid #222",
                        display: "flex",
                        gap: "16px",
                        fontSize: "11px",
                        color: "#666",
                    }, children: [_jsxs("span", { children: ["Total: ", accounts.length] }), _jsxs("span", { style: { color: "#4ade80" }, children: ["Active: ", accounts.filter((a) => a.status === "active").length] }), _jsxs("span", { style: { color: "#fbbf24" }, children: ["Paused: ", accounts.filter((a) => a.status === "paused").length] }), _jsxs("span", { style: { color: "#f87171" }, children: ["Blocked: ", accounts.filter((a) => a.status === "blocked").length] })] }))] }) }));
}
