import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * AccountsPage.tsx
 * Agency accounts management — list, filter, add, edit status, delete.
 */
import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { accountsApi } from "../api/accounts";
import { agencyApi } from "../api/agency";
import { api } from "../api/client";
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
// ─── Badges ───────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.active;
    return (_jsx("span", { style: {
            padding: "3px 10px",
            borderRadius: "12px",
            fontSize: "10px",
            fontWeight: 500,
            background: config.bg,
            color: config.color,
            textTransform: "uppercase",
        }, children: config.label }));
}
function PlatformBadge({ platform }) {
    const p = PLATFORMS.find((x) => x.value === platform) || PLATFORMS[0];
    return (_jsx("span", { style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "12px",
            color: p.color,
        }, children: p.icon }));
}
function TypeBadge({ type }) {
    const config = type === "business"
        ? { icon: "💼", label: "Business", color: "#a78bfa" }
        : { icon: "🌱", label: "Farming", color: "#4ade80" };
    return (_jsxs("span", { style: { fontSize: "11px", color: config.color }, children: [config.icon, " ", config.label] }));
}
function AddAccountModal({ clients, devices, onAdd, onClose }) {
    const [platform, setPlatform] = useState("instagram");
    const [username, setUsername] = useState("");
    const [clientId, setClientId] = useState("");
    const [deviceId, setDeviceId] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    // Type is derived from client selection and client type
    const selectedClient = clients.find(c => c.id === clientId);
    const type = selectedClient?.type === 'client' ? 'business' : 'farming';
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!username.trim()) {
            setError("Username is required");
            return;
        }
        if (!deviceId) {
            setError("Device is required");
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
            onClose();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setSaving(false);
        }
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
                background: "#111",
                borderRadius: "12px",
                border: "1px solid #333",
                width: "450px",
                padding: "24px",
            }, onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { style: { color: "#fff", margin: "0 0 20px 0", fontSize: "16px" }, children: "Add Account" }), _jsxs("form", { onSubmit: handleSubmit, children: [_jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }, children: "Device *" }), _jsxs("select", { value: deviceId, onChange: (e) => setDeviceId(e.target.value), style: {
                                        width: "100%",
                                        padding: "10px 12px",
                                        background: "#1a1a1a",
                                        border: "1px solid #333",
                                        borderRadius: "6px",
                                        color: "#fff",
                                        fontSize: "13px",
                                    }, children: [_jsx("option", { value: "", children: "Select device..." }), devices.map((d) => (_jsxs("option", { value: d.id, children: [d.friendlyName || d.model, " ", d.status === "online" ? "🟢" : "⚫"] }, d.id)))] })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }, children: [_jsxs("div", { children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }, children: "Platform" }), _jsx("select", { value: platform, onChange: (e) => setPlatform(e.target.value), style: {
                                                width: "100%",
                                                padding: "10px 12px",
                                                background: "#1a1a1a",
                                                border: "1px solid #333",
                                                borderRadius: "6px",
                                                color: "#fff",
                                                fontSize: "13px",
                                            }, children: PLATFORMS.map((p) => (_jsxs("option", { value: p.value, children: [p.icon, " ", p.label] }, p.value))) })] }), _jsxs("div", { children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }, children: "Type" }), _jsxs("div", { style: {
                                                padding: "10px 12px",
                                                background: "#1a1a1a",
                                                borderRadius: "6px",
                                                color: type === 'business' ? "#60a5fa" : "#4ade80",
                                                fontSize: "13px",
                                            }, children: [type === 'business' ? "💼 Business" : "🌱 Farming", _jsxs("span", { style: { color: "#666", marginLeft: "8px", fontSize: "11px" }, children: ["(auto: ", selectedClient ? `${selectedClient.type} selected` : "no client", ")"] })] })] })] }), _jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }, children: "Username *" }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), placeholder: "@username", style: {
                                        width: "100%",
                                        padding: "10px 12px",
                                        background: "#1a1a1a",
                                        border: "1px solid #333",
                                        borderRadius: "6px",
                                        color: "#fff",
                                        fontSize: "13px",
                                        fontFamily: "monospace",
                                    } })] }), _jsxs("div", { style: { marginBottom: "20px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }, children: "Client (optional)" }), _jsxs("select", { value: clientId, onChange: (e) => setClientId(e.target.value), style: {
                                        width: "100%",
                                        padding: "10px 12px",
                                        background: "#1a1a1a",
                                        border: "1px solid #333",
                                        borderRadius: "6px",
                                        color: "#fff",
                                        fontSize: "13px",
                                    }, children: [_jsx("option", { value: "", children: "\uD83C\uDF31 No client (Farming)" }), _jsx("optgroup", { label: "\uD83D\uDC65 Clients", children: clients.filter(c => c.type === 'client').map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id))) }), _jsx("optgroup", { label: "\uD83C\uDF31 Farming Profiles", children: clients.filter(c => c.type === 'farming').map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id))) })] })] }), error && (_jsxs("div", { style: { color: "#f87171", fontSize: "12px", marginBottom: "16px" }, children: ["\u26A0\uFE0F ", error] })), _jsxs("div", { style: { display: "flex", gap: "12px", justifyContent: "flex-end" }, children: [_jsx("button", { type: "button", onClick: onClose, style: {
                                        padding: "10px 20px",
                                        background: "#333",
                                        border: "none",
                                        borderRadius: "6px",
                                        color: "#ccc",
                                        cursor: "pointer",
                                        fontSize: "13px",
                                    }, children: "Cancel" }), _jsx("button", { type: "submit", disabled: saving, style: {
                                        padding: "10px 20px",
                                        background: saving ? "#444" : "#2563eb",
                                        border: "none",
                                        borderRadius: "6px",
                                        color: "#fff",
                                        cursor: saving ? "not-allowed" : "pointer",
                                        fontSize: "13px",
                                    }, children: saving ? "Adding..." : "Add Account" })] })] })] }) }));
}
function AccountRow({ account, onStatusChange, onDelete }) {
    const handleDelete = () => {
        if (confirm(`Delete account @${account.username}?`)) {
            onDelete(account.id);
        }
    };
    return (_jsxs("div", { style: {
            display: "grid",
            gridTemplateColumns: "200px 140px 140px 100px 100px 100px auto",
            gap: "12px",
            alignItems: "center",
            padding: "14px 16px",
            background: "#111",
            borderRadius: "6px",
            border: "1px solid #222",
        }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [_jsx(PlatformBadge, { platform: account.platform }), _jsxs("span", { style: { color: "#fff", fontSize: "13px", fontFamily: "monospace" }, children: ["@", account.username] })] }), _jsx("div", { style: { color: account.client_name ? "#ccc" : "#555", fontSize: "12px" }, children: account.client_name || "—" }), _jsx("div", { style: { color: "#888", fontSize: "12px" }, children: account.device_name || account.deviceId?.slice(0, 8) || "—" }), _jsx("div", { children: _jsx(StatusBadge, { status: account.status }) }), _jsx("div", { children: _jsx(TypeBadge, { type: account.type }) }), _jsx("div", { style: { color: "#666", fontSize: "11px" }, children: new Date(account.createdAt).toLocaleDateString() }), _jsxs("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" }, children: [_jsxs("select", { value: account.status, onChange: (e) => onStatusChange(account.id, e.target.value), style: {
                            padding: "6px 10px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "4px",
                            color: "#ccc",
                            fontSize: "11px",
                            cursor: "pointer",
                        }, children: [_jsx("option", { value: "active", children: "Active" }), _jsx("option", { value: "paused", children: "Paused" }), _jsx("option", { value: "warming", children: "Warming" }), _jsx("option", { value: "cooldown", children: "Cooldown" }), _jsx("option", { value: "blocked", children: "Blocked" })] }), _jsx("button", { onClick: handleDelete, style: {
                            padding: "6px 10px",
                            background: "transparent",
                            border: "1px solid #7f1d1d",
                            borderRadius: "4px",
                            color: "#f87171",
                            cursor: "pointer",
                            fontSize: "11px",
                        }, children: "\uD83D\uDDD1\uFE0F" })] })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function AccountsPage() {
    const [accounts, setAccounts] = useState([]);
    const [clients, setClients] = useState([]);
    const [devices, setDevices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showAddModal, setShowAddModal] = useState(false);
    // Filters
    const [clientFilter, setClientFilter] = useState("");
    const [deviceFilter, setDeviceFilter] = useState("");
    const [platformFilter, setPlatformFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    // Stats
    const stats = {
        total: accounts.length,
        active: accounts.filter((a) => a.status === "active").length,
        paused: accounts.filter((a) => a.status === "paused").length,
        blocked: accounts.filter((a) => a.status === "blocked").length,
        warming: accounts.filter((a) => a.status === "warming").length,
    };
    const fetchData = useCallback(async () => {
        try {
            const [accountsData, clientsData, farmingData, devicesData] = await Promise.all([
                accountsApi.list({
                    clientId: clientFilter || undefined,
                    deviceId: deviceFilter || undefined,
                    platform: platformFilter || undefined,
                    status: statusFilter || undefined,
                    pageSize: 200,
                }),
                agencyApi.clients.list({ pageSize: 100, type: 'client' }),
                agencyApi.clients.list({ pageSize: 100, type: 'farming' }),
                api.get("/devices"),
            ]);
            // Combine clients and farming profiles for the dropdown
            const allClients = [...clientsData.items, ...farmingData.items];
            // Extract devices from paginated response
            const devicesList = devicesData?.items || [];
            // Map client and device names to accounts
            const clientMap = new Map(allClients.map((c) => [c.id, c.name]));
            const deviceMap = new Map(devicesList.map((d) => [
                d.id,
                d.friendlyName || d.model,
            ]));
            const enrichedAccounts = accountsData.items.map((a) => ({
                ...a,
                client_name: a.clientId ? clientMap.get(a.clientId) : undefined,
                device_name: a.deviceId ? deviceMap.get(a.deviceId) : undefined,
            }));
            setAccounts(enrichedAccounts);
            setClients(allClients);
            setDevices(devicesList);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [clientFilter, deviceFilter, platformFilter, statusFilter]);
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
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/accounts", children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }, children: [_jsxs("div", { children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\uD83D\uDCF1 Accounts" }), _jsx("p", { style: { color: "#666", margin: "8px 0 0", fontSize: "13px" }, children: "Manage social media accounts across all devices" })] }), _jsx("button", { onClick: () => setShowAddModal(true), style: {
                            padding: "10px 20px",
                            background: "#2563eb",
                            border: "none",
                            borderRadius: "6px",
                            color: "#fff",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                        }, children: "+ Add Account" })] }), _jsx("div", { style: {
                    display: "flex",
                    gap: "12px",
                    marginBottom: "24px",
                    flexWrap: "wrap",
                }, children: [
                    { key: "", label: "All", count: stats.total, color: "#a78bfa" },
                    { key: "active", label: "Active", count: stats.active, color: "#4ade80" },
                    { key: "paused", label: "Paused", count: stats.paused, color: "#fbbf24" },
                    { key: "blocked", label: "Blocked", count: stats.blocked, color: "#f87171" },
                    { key: "warming", label: "Warming", count: stats.warming, color: "#60a5fa" },
                ].map((stat) => (_jsxs("div", { onClick: () => setStatusFilter(stat.key), style: {
                        padding: "12px 24px",
                        background: statusFilter === stat.key ? "#1a1a2e" : "#111",
                        border: `1px solid ${statusFilter === stat.key ? "#333" : "#222"}`,
                        borderRadius: "8px",
                        cursor: "pointer",
                        textAlign: "center",
                        minWidth: "90px",
                    }, children: [_jsx("div", { style: { color: stat.color, fontSize: "22px", fontWeight: 600 }, children: stat.count }), _jsx("div", { style: { color: "#888", fontSize: "11px" }, children: stat.label })] }, stat.key))) }), _jsxs("div", { style: { display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }, children: [_jsxs("select", { value: clientFilter, onChange: (e) => setClientFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                            minWidth: "150px",
                        }, children: [_jsx("option", { value: "", children: "All Clients" }), clients.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id)))] }), _jsxs("select", { value: deviceFilter, onChange: (e) => setDeviceFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                            minWidth: "150px",
                        }, children: [_jsx("option", { value: "", children: "All Devices" }), devices.map((d) => (_jsx("option", { value: d.id, children: d.friendlyName || d.model }, d.id)))] }), _jsxs("select", { value: platformFilter, onChange: (e) => setPlatformFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                        }, children: [_jsx("option", { value: "", children: "All Platforms" }), PLATFORMS.map((p) => (_jsxs("option", { value: p.value, children: [p.icon, " ", p.label] }, p.value)))] }), _jsx("button", { onClick: fetchData, style: {
                            padding: "8px 16px",
                            background: "#1a1a2e",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            cursor: "pointer",
                            fontSize: "13px",
                        }, children: "\uD83D\uDD04 Refresh" })] }), _jsxs("div", { style: {
                    display: "grid",
                    gridTemplateColumns: "200px 140px 140px 100px 100px 100px auto",
                    gap: "12px",
                    padding: "10px 16px",
                    color: "#666",
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    marginBottom: "8px",
                }, children: [_jsx("div", { children: "Account" }), _jsx("div", { children: "Client" }), _jsx("div", { children: "Device" }), _jsx("div", { children: "Status" }), _jsx("div", { children: "Type" }), _jsx("div", { children: "Created" }), _jsx("div", { style: { textAlign: "right" }, children: "Actions" })] }), error && (_jsxs("div", { style: {
                    padding: "12px 16px",
                    background: "#2a1515",
                    borderRadius: "6px",
                    color: "#f88",
                    marginBottom: "16px",
                }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : accounts.length === 0 ? (_jsxs("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: ["No accounts found.", _jsx("br", {}), _jsx("button", { onClick: () => setShowAddModal(true), style: {
                            marginTop: "16px",
                            padding: "10px 20px",
                            background: "#2563eb",
                            border: "none",
                            borderRadius: "6px",
                            color: "#fff",
                            cursor: "pointer",
                            fontSize: "13px",
                        }, children: "+ Add first account" })] })) : (_jsx("div", { style: { display: "flex", flexDirection: "column", gap: "8px" }, children: accounts.map((account) => (_jsx(AccountRow, { account: account, onStatusChange: handleStatusChange, onDelete: handleDelete }, account.id))) })), showAddModal && (_jsx(AddAccountModal, { clients: clients, devices: devices, onAdd: fetchData, onClose: () => setShowAddModal(false) }))] }));
}
