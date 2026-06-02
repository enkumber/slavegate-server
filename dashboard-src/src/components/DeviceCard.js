import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * DeviceCard.tsx
 * Single device card — status indicator, health metrics, quick actions.
 * Supports inline rename: click friendly name → edit → Enter/blur saves, Escape cancels.
 */
import { useState, useRef, useEffect } from "react";
import { api } from "../api/client";
const STATUS_COLOR = {
    online: "#22c55e",
    offline: "#6b7280",
    approved: "#3b82f6",
    pending: "#f59e0b",
    maintenance: "#ef4444",
};
const STATUS_LABEL = {
    online: "Online",
    offline: "Offline",
    approved: "Approved",
    pending: "Pending",
    maintenance: "Maintenance",
};
export function DeviceCard({ device, accountsCount, onApprove, onDispatchJob, onHumanWorkflow, onRevoke, onDelete, onRenamed, onOtaPush, onAccountsClick }) {
    const health = device.health;
    const statusColor = STATUS_COLOR[device.status] ?? "#6b7280";
    // ─── Inline rename state ──────────────────────────────────────────────────
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(device.friendlyName ?? "");
    const [saving, setSaving] = useState(false);
    const inputRef = useRef(null);
    // Sync draft if parent updates device
    useEffect(() => {
        if (!editing)
            setDraft(device.friendlyName ?? "");
    }, [device.friendlyName, editing]);
    // Focus + select all when entering edit mode
    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);
    const startEdit = () => {
        setDraft(device.friendlyName ?? "");
        setEditing(true);
    };
    const cancelEdit = () => {
        setDraft(device.friendlyName ?? "");
        setEditing(false);
    };
    const commitEdit = async () => {
        const trimmed = draft.trim();
        if (!trimmed || trimmed === device.friendlyName) {
            cancelEdit();
            return;
        }
        setSaving(true);
        try {
            await api.patch(`/devices/${device.id}`, { friendlyName: trimmed });
            setEditing(false);
            onRenamed?.();
        }
        catch (e) {
            alert(`Rename failed: ${e.message}`);
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("div", { style: {
            border: `2px solid ${statusColor}`,
            borderRadius: "8px",
            padding: "12px 16px",
            background: "#1a1a2e",
            color: "#e2e8f0",
            minWidth: "220px",
            fontFamily: "monospace",
        }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }, children: [_jsx("span", { style: {
                                    width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
                                    background: statusColor, display: "inline-block",
                                    boxShadow: device.status === "online" ? `0 0 6px ${statusColor}` : "none",
                                } }), editing ? (_jsx("input", { ref: inputRef, value: draft, disabled: saving, onChange: e => setDraft(e.target.value), onKeyDown: e => {
                                    if (e.key === "Enter")
                                        commitEdit();
                                    if (e.key === "Escape")
                                        cancelEdit();
                                }, onBlur: commitEdit, style: {
                                    background: "#0f172a",
                                    border: "1px solid #3b82f6",
                                    borderRadius: "4px",
                                    color: "#e2e8f0",
                                    fontFamily: "monospace",
                                    fontSize: "14px",
                                    fontWeight: "bold",
                                    padding: "1px 6px",
                                    width: "100%",
                                    outline: "none",
                                    opacity: saving ? 0.5 : 1,
                                } })) : (_jsxs("span", { title: "Click to rename", onClick: startEdit, style: {
                                    fontSize: "14px", fontWeight: "bold",
                                    cursor: "text", display: "flex", alignItems: "center", gap: "4px",
                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }, children: [device.friendlyName ?? device.model ?? "Unnamed", _jsx("span", { style: { fontSize: "10px", color: "#475569", flexShrink: 0 }, children: "\u270F\uFE0F" })] })), device.isCanary && (_jsx("span", { style: { fontSize: "10px", background: "#7c3aed", padding: "2px 6px", borderRadius: "4px", flexShrink: 0 }, children: "CANARY" }))] }), _jsx("span", { style: { fontSize: "11px", color: "#94a3b8", flexShrink: 0, marginLeft: "8px" }, children: STATUS_LABEL[device.status] })] }), _jsxs("div", { style: { fontSize: "11px", color: "#94a3b8", marginBottom: "8px" }, children: [_jsxs("div", { children: [device.model ?? "Unknown model", " \u00B7 Android ", device.androidVersion ?? "?"] }), _jsxs("div", { children: ["Agent v", device.agentVersion ?? "?"] }), health?.publicIp && _jsxs("div", { children: ["\uD83C\uDF10 Public IP: ", health.publicIp] }), health?.connectionType && (_jsxs("div", { children: ["\uD83D\uDD17 Connection: ", " ", _jsx("span", { style: { color: health.connectionType === "wireguard" ? "#22c55e" : "#f59e0b" }, children: health.connectionType === "wireguard" ? "🛡 WireGuard" : "☁️ Relay" })] })), health?.rustdeskId && (_jsxs("div", { children: ["\uD83D\uDDA5 RustDesk: ", health.rustdeskId, " ", health.rustdeskRunning ? "✅" : "❌"] })), !health?.publicIp && device.lastIp && _jsxs("div", { children: ["IP: ", device.lastIp] }), device.lastSeenAt && (_jsxs("div", { children: ["Last seen: ", new Date(device.lastSeenAt).toLocaleString()] }))] }), health && (_jsxs("div", { style: { fontSize: "11px", marginBottom: "8px", display: "flex", gap: "10px", flexWrap: "wrap" }, children: [_jsxs("span", { title: "Battery", children: ["\uD83D\uDD0B ", health.batteryLevel, "%", health.charging ? "⚡" : ""] }), _jsxs("span", { title: "Network", children: ["\uD83D\uDCE1 ", health.networkType, "/", health.networkQuality] }), _jsxs("span", { title: "Thermal", style: {
                            color: health.thermalStatus === "nominal" ? "#22c55e" :
                                health.thermalStatus === "light" ? "#f59e0b" :
                                    health.thermalStatus === "moderate" ? "#f97316" : "#ef4444",
                        }, children: ["\uD83C\uDF21 ", health.thermalStatus] }), _jsxs("span", { title: "Storage", children: ["\uD83D\uDCBE ", Math.round(health.storageFreeBytes / 1024 / 1024), "MB free"] })] })), onAccountsClick && (_jsx("div", { style: { marginBottom: "8px" }, children: _jsxs("button", { onClick: (e) => { e.stopPropagation(); onAccountsClick(device); }, style: {
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 10px",
                        background: accountsCount && accountsCount > 0 ? "#1e3a5f" : "#1a1a2e",
                        border: "1px solid #333",
                        borderRadius: "4px",
                        color: accountsCount && accountsCount > 0 ? "#60a5fa" : "#666",
                        cursor: "pointer",
                        fontSize: "11px",
                        fontFamily: "monospace",
                    }, children: ["\uD83D\uDCF1 ", accountsCount ?? 0, " accounts"] }) })), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [device.status === "pending" && onApprove && (_jsx("button", { onClick: () => onApprove(device.id), style: btnStyle("#22c55e"), children: "Approve" })), device.status === "online" && onDispatchJob && (_jsx("button", { onClick: () => onDispatchJob(device), style: btnStyle("#3b82f6"), children: "Dispatch Job" })), device.status === "online" && onHumanWorkflow && (_jsx("button", { onClick: () => onHumanWorkflow(device), style: btnStyle("#0ea5e9"), children: "AI Workflow" })), device.status === "online" && onOtaPush && (_jsx("button", { onClick: () => onOtaPush(device.id), style: btnStyle("#8b5cf6"), children: "\uD83D\uDCE6 OTA" })), device.status !== "maintenance" && onRevoke && (_jsx("button", { onClick: () => { if (confirm(`Revoke ${device.friendlyName}?`))
                            onRevoke(device.id); }, style: btnStyle("#ef4444"), children: "Revoke" })), onDelete && (_jsx("button", { onClick: () => {
                            if (confirm(`⚠️ DELETE ${device.friendlyName ?? device.model}?\n\nThis will permanently remove the device and all its job history. This action cannot be undone.`)) {
                                onDelete(device.id);
                            }
                        }, style: btnStyle("#dc2626"), children: "\uD83D\uDDD1\uFE0F Delete" }))] })] }));
}
const btnStyle = (color) => ({
    background: "transparent",
    border: `1px solid ${color}`,
    color,
    padding: "3px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "monospace",
});
