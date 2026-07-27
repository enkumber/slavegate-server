import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * FleetPage.tsx
 * Main fleet view — devices grouped by physical location.
 * Includes "Pending Approval" section with Approve/Block actions.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { DeviceCard } from "../components/DeviceCard";
import { AccountsModal } from "../components/AccountsModal";
import { HumanWorkflowModal } from "../components/HumanWorkflowModal";
import { api } from "../api/client";
import { accountsApi } from "../api/accounts";
// ─── Main page ────────────────────────────────────────────────────────────────
export function FleetPage() {
    const [grouped, setGrouped] = useState({});
    const [pending, setPending] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [approveModal, setApproveModal] = useState(null);
    const [dispatchModal, setDispatchModal] = useState(null);
    const [accountsModal, setAccountsModal] = useState(null);
    const [humanWorkflowDevice, setHumanWorkflowDevice] = useState(null);
    const [accountsCounts, setAccountsCounts] = useState({});
    const [lastRefresh, setLastRefresh] = useState(new Date());
    // ─── Fetch fleet (grouped) ──────────────────────────────────────────────────
    const fetchFleet = useCallback(async () => {
        try {
            const data = await api.get("/devices?grouped=true");
            setGrouped(data);
            setError(null);
            setLastRefresh(new Date());
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    // ─── Fetch pending — separate call, faster poll ─────────────────────────────
    const fetchPending = useCallback(async () => {
        try {
            const data = await api.get("/devices?status=pending");
            setPending(data.items ?? []);
        }
        catch { /* non-fatal — fleet still shows */ }
    }, []);
    // ─── Fetch accounts counts per device ─────────────────────────────────────
    const fetchAccountsCounts = useCallback(async () => {
        try {
            // Fetch all accounts and group by deviceId
            const data = await accountsApi.list({ pageSize: 500 });
            const counts = {};
            for (const account of data.items) {
                if (account.deviceId) {
                    counts[account.deviceId] = (counts[account.deviceId] || 0) + 1;
                }
            }
            setAccountsCounts(counts);
        }
        catch { /* non-fatal */ }
    }, []);
    const fetchAll = useCallback(async () => {
        await Promise.all([fetchFleet(), fetchPending(), fetchAccountsCounts()]);
    }, [fetchFleet, fetchPending, fetchAccountsCounts]);
    // Fleet: 15s poll. Pending: 10s poll (devices can appear any time).
    useEffect(() => {
        fetchAll();
        const fleetInterval = setInterval(fetchFleet, 15_000);
        const pendingInterval = setInterval(fetchPending, 10_000);
        return () => { clearInterval(fleetInterval); clearInterval(pendingInterval); };
    }, [fetchAll, fetchFleet, fetchPending]);
    // ─── Approve ────────────────────────────────────────────────────────────────
    const handleApprove = async (deviceId, friendlyName) => {
        await api.post(`/devices/${deviceId}/approve`, { friendlyName });
        setApproveModal(null);
        await fetchAll();
    };
    // ─── Block ──────────────────────────────────────────────────────────────────
    const handleBlock = async (deviceId) => {
        if (!confirm("Block this device? It will be disconnected immediately."))
            return;
        await api.post(`/devices/${deviceId}/block`, { reason: "Blocked by admin" });
        await fetchAll();
    };
    // ─── Revoke ─────────────────────────────────────────────────────────────────
    const handleRevoke = async (deviceId) => {
        try {
            await api.post(`/devices/${deviceId}/revoke`);
            await fetchAll();
        }
        catch (e) {
            alert(`Revoke failed: ${e.message}`);
        }
    };
    // ─── Delete ─────────────────────────────────────────────────────────────────
    const handleDelete = async (deviceId) => {
        try {
            await api.delete(`/devices/${deviceId}`);
            await fetchAll();
        }
        catch (e) {
            alert(`Delete failed: ${e.message}`);
        }
    };
    // ─── OTA Push ───────────────────────────────────────────────────────────────
    const [otaPushing, setOtaPushing] = useState(false);
    const handleOtaPush = async (deviceIds) => {
        const target = deviceIds ? `${deviceIds.length} device(s)` : "all online devices";
        if (!confirm(`Push OTA update to ${target}?`))
            return;
        setOtaPushing(true);
        try {
            const res = await api.post("/ota/push", {
                deviceIds,
            });
            alert(`✅ OTA ${res.version} (${res.versionCode}) pushed to ${res.count} device(s)`);
        }
        catch (e) {
            alert(`OTA failed: ${e.message}`);
        }
        finally {
            setOtaPushing(false);
        }
    };
    const handleOtaPushSingle = (deviceId) => handleOtaPush([deviceId]);
    // ─── Stats ──────────────────────────────────────────────────────────────────
    const allDevices = Object.values(grouped).flat();
    const online = allDevices.filter(d => d.statusCapabilities.dispatchable).length;
    const total = allDevices.length;
    const locations = Object.keys(grouped).filter(k => k !== "unassigned");
    return (_jsxs("div", { style: { padding: "24px", background: "#0f0f23", minHeight: "100vh", color: "#e2e8f0" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: 0, fontSize: "18px", fontFamily: "monospace", color: "#e2e8f0" }, children: "Fleet Overview" }), _jsxs("div", { style: { fontSize: "12px", color: "#64748b", marginTop: "4px" }, children: [total, " devices \u00B7 ", locations.length, " locations \u00B7 refreshed ", lastRefresh.toLocaleTimeString()] })] }), _jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [_jsx("button", { onClick: () => handleOtaPush(), disabled: otaPushing || online === 0, style: {
                                    padding: "8px 16px",
                                    backgroundColor: otaPushing ? "#6b7280" : "#8b5cf6",
                                    color: "#fff",
                                    borderRadius: "6px",
                                    border: "none",
                                    fontSize: "13px",
                                    fontWeight: 600,
                                    cursor: otaPushing || online === 0 ? "not-allowed" : "pointer",
                                    opacity: online === 0 ? 0.5 : 1,
                                }, children: otaPushing ? "⏳ Pushing..." : "📦 OTA All" }), _jsx("a", { href: "#/provision", style: {
                                    padding: "8px 16px",
                                    backgroundColor: "#4CAF50",
                                    color: "#fff",
                                    borderRadius: "6px",
                                    textDecoration: "none",
                                    fontSize: "13px",
                                    fontWeight: 600,
                                }, children: "\u2795 Add Device" }), _jsx(Badge, { label: "Online", value: online, color: "#22c55e" }), _jsx(Badge, { label: "Total", value: total, color: "#3b82f6" }), pending.length > 0 && _jsx(Badge, { label: "Pending", value: pending.length, color: "#f59e0b" })] })] }), error && (_jsxs("div", { style: { background: "#450a0a", border: "1px solid #ef4444", borderRadius: "6px", padding: "10px 14px", marginBottom: "16px", color: "#fca5a5", fontSize: "13px" }, children: ["\u26A0 ", error] })), pending.length > 0 && (_jsxs("div", { style: {
                    background: "#1a1200", border: "1px solid #78350f",
                    borderRadius: "8px", padding: "16px", marginBottom: "28px",
                }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }, children: [_jsx("span", { style: { fontSize: "16px" }, children: "\u23F3" }), _jsxs("h2", { style: { margin: 0, fontSize: "15px", color: "#fbbf24", fontFamily: "monospace" }, children: ["Pending Approval (", pending.length, ")"] }), _jsx("span", { style: { fontSize: "11px", color: "#92400e", marginLeft: "4px" }, children: "\u2014 new devices waiting for admin approval" })] }), _jsx("div", { style: { display: "flex", flexDirection: "column", gap: "10px" }, children: pending.map(device => (_jsx(PendingDeviceRow, { device: device, onApprove: () => setApproveModal({ device }), onBlock: () => handleBlock(device.id) }, device.id))) })] })), loading ? (_jsx("div", { style: { color: "#64748b", fontFamily: "monospace" }, children: "Loading fleet..." })) : (_jsxs(_Fragment, { children: [Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([locationId, devices]) => (_jsx(LocationGroup, { locationId: locationId, devices: devices, accountsCounts: accountsCounts, onApprove: (id) => {
                            const d = devices.find(x => x.id === id);
                            if (d)
                                setApproveModal({ device: d });
                        }, onDispatchJob: (d) => setDispatchModal({ device: d }), onHumanWorkflow: (d) => setHumanWorkflowDevice(d), onRevoke: handleRevoke, onDelete: handleDelete, onRenamed: fetchAll, onOtaPush: handleOtaPushSingle, onAccountsClick: (d) => setAccountsModal(d) }, locationId))), total === 0 && pending.length === 0 && (_jsxs("div", { style: { color: "#64748b", fontFamily: "monospace", textAlign: "center", marginTop: "60px" }, children: ["No devices yet.", _jsx("br", {}), "Install the agent on a device \u2014 it will appear here automatically."] }))] })), approveModal && (_jsx(ApproveDeviceModal, { device: approveModal.device, onApprove: handleApprove, onClose: () => setApproveModal(null) })), dispatchModal && (_jsx(JobDispatchModal, { device: dispatchModal.device, onClose: () => setDispatchModal(null), onDispatched: fetchAll })), accountsModal && (_jsx(AccountsModal, { deviceId: accountsModal.id, deviceName: accountsModal.friendlyName ?? accountsModal.model ?? "Device", onClose: () => { setAccountsModal(null); fetchAccountsCounts(); } })), humanWorkflowDevice && (_jsx(HumanWorkflowModal, { device: humanWorkflowDevice, onClose: () => setHumanWorkflowDevice(null) }))] }));
}
// ─── PendingDeviceRow ─────────────────────────────────────────────────────────
function PendingDeviceRow({ device, onApprove, onBlock, }) {
    const created = device.createdAt ? new Date(device.createdAt).toLocaleString() : "–";
    return (_jsxs("div", { style: {
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "#0f0a00", borderRadius: "6px", padding: "10px 14px",
            border: "1px solid #292000",
        }, children: [_jsxs("div", { style: { fontFamily: "monospace", fontSize: "13px" }, children: [_jsx("span", { style: { color: "#fbbf24", fontWeight: "bold" }, children: device.model ?? "Unknown" }), _jsxs("span", { style: { color: "#64748b", marginLeft: "10px" }, children: ["Android ", device.androidVersion ?? "?"] }), _jsxs("span", { style: { color: "#475569", marginLeft: "10px", fontSize: "11px" }, children: ["UUID: ", device.hardwareUuid?.slice(0, 8) ?? device.id.slice(0, 8), "\u2026"] }), device.lastIp && (_jsxs("span", { style: { color: "#475569", marginLeft: "10px", fontSize: "11px" }, children: ["IP: ", device.lastIp] })), _jsxs("span", { style: { color: "#374151", marginLeft: "10px", fontSize: "11px" }, children: ["Since: ", created] })] }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { onClick: onApprove, style: {
                            background: "#166534", color: "#bbf7d0", border: "none",
                            borderRadius: "5px", padding: "6px 14px", cursor: "pointer",
                            fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
                        }, children: "\u2713 Approve" }), _jsx("button", { onClick: onBlock, style: {
                            background: "#450a0a", color: "#fca5a5", border: "none",
                            borderRadius: "5px", padding: "6px 12px", cursor: "pointer",
                            fontFamily: "monospace", fontSize: "12px",
                        }, children: "\u2715 Block" })] })] }));
}
// ─── ApproveDeviceModal ───────────────────────────────────────────────────────
function ApproveDeviceModal({ device, onApprove, onClose, }) {
    const [name, setName] = useState(device.friendlyName || device.model || "");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const inputRef = useRef(null);
    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
    const submit = async () => {
        if (!name.trim()) {
            setErr("Friendly name required");
            return;
        }
        setBusy(true);
        try {
            await onApprove(device.id, name.trim());
        }
        catch (e) {
            setErr(e.message);
            setBusy(false);
        }
    };
    return (_jsx("div", { style: {
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }, onClick: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { style: {
                background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "10px",
                padding: "24px", width: "380px",
            }, children: [_jsx("h3", { style: { margin: "0 0 4px", fontFamily: "monospace", color: "#e2e8f0" }, children: "\u2713 Approve Device" }), _jsxs("div", { style: { fontSize: "12px", color: "#64748b", marginBottom: "18px" }, children: [device.model, " \u00B7 Android ", device.androidVersion ?? "?", " \u00B7 ", device.lastIp ?? "unknown IP"] }), _jsx("label", { style: { fontSize: "12px", color: "#94a3b8", display: "block", marginBottom: "6px" }, children: "Friendly name" }), _jsx("input", { ref: inputRef, value: name, onChange: e => setName(e.target.value), onKeyDown: e => { if (e.key === "Enter")
                        submit(); if (e.key === "Escape")
                        onClose(); }, placeholder: "e.g. OnePlus 5T - Cluj", style: {
                        width: "100%", boxSizing: "border-box",
                        background: "#1e293b", border: "1px solid #334155",
                        borderRadius: "6px", padding: "8px 10px",
                        color: "#e2e8f0", fontFamily: "monospace", fontSize: "13px",
                    } }), err && _jsx("div", { style: { color: "#f87171", fontSize: "12px", marginTop: "6px" }, children: err }), _jsxs("div", { style: { display: "flex", gap: "10px", marginTop: "18px", justifyContent: "flex-end" }, children: [_jsx("button", { onClick: onClose, style: {
                                background: "transparent", color: "#64748b",
                                border: "1px solid #334155", borderRadius: "6px",
                                padding: "7px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px",
                            }, children: "Cancel" }), _jsx("button", { onClick: submit, disabled: busy, style: {
                                background: busy ? "#064e3b" : "#065f46", color: "#6ee7b7",
                                border: "none", borderRadius: "6px",
                                padding: "7px 20px", cursor: busy ? "not-allowed" : "pointer",
                                fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
                            }, children: busy ? "Approving…" : "Approve" })] })] }) }));
}
// ─── LocationGroup (unchanged) ────────────────────────────────────────────────
function LocationGroup({ locationId, devices, accountsCounts, onApprove, onDispatchJob, onHumanWorkflow, onRevoke, onDelete, onRenamed, onOtaPush, onAccountsClick, }) {
    const online = devices.filter(d => d.statusCapabilities.dispatchable).length;
    const label = locationId === "unassigned" ? "Unassigned" : locationId.toUpperCase();
    return (_jsxs("div", { style: { marginBottom: "28px" }, children: [_jsxs("div", { style: {
                    display: "flex", alignItems: "center", gap: "10px",
                    marginBottom: "12px", borderBottom: "1px solid #1e293b", paddingBottom: "8px",
                }, children: [_jsxs("span", { style: { fontFamily: "monospace", fontSize: "13px", color: "#64748b" }, children: ["\uD83D\uDCCD ", label] }), _jsxs("span", { style: { fontSize: "11px", color: "#475569" }, children: [online, "/", devices.length, " online"] })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "12px" }, children: devices.map(device => (_jsx(DeviceCard, { device: device, accountsCount: accountsCounts[device.id] ?? 0, onApprove: () => onApprove(device.id), onDispatchJob: () => onDispatchJob(device), onHumanWorkflow: () => onHumanWorkflow(device), onRevoke: () => onRevoke(device.id), onDelete: () => onDelete(device.id), onRenamed: onRenamed, onOtaPush: () => onOtaPush(device.id), onAccountsClick: () => onAccountsClick(device) }, device.id))) })] }));
}
// ─── Badge ────────────────────────────────────────────────────────────────────
function Badge({ label, value, color }) {
    return (_jsxs("div", { style: {
            background: "#0f172a", border: `1px solid ${color}33`,
            borderRadius: "6px", padding: "6px 12px", textAlign: "center",
        }, children: [_jsx("div", { style: { fontSize: "18px", fontWeight: "bold", color, fontFamily: "monospace" }, children: value }), _jsx("div", { style: { fontSize: "10px", color: "#64748b", textTransform: "uppercase" }, children: label })] }));
}
function JobDispatchModal({ device, onClose, onDispatched }) {
    const [jobTypes, setJobTypes] = useState([]);
    const [jobType, setJobType] = useState("");
    const [params, setParams] = useState("{}");
    const [busy, setBusy] = useState(false);
    const [paramsError, setParamsError] = useState(null);
    useEffect(() => {
        let cancelled = false;
        api.get("/jobs/action-policies")
            .then((definitions) => {
            if (cancelled)
                return;
            const allowed = definitions.filter((definition) => definition.allowed);
            setJobTypes(allowed);
            if (allowed[0]) {
                setJobType(allowed[0].actionKey);
                setParams(JSON.stringify(allowed[0].defaultParams ?? {}, null, 2));
            }
        })
            .catch((error) => {
            if (!cancelled)
                setParamsError(error.message);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const handleTypeChange = (newType) => {
        setJobType(newType);
        const preset = jobTypes.find((definition) => definition.actionKey === newType);
        if (preset)
            setParams(JSON.stringify(preset.defaultParams ?? {}, null, 2));
        setParamsError(null);
    };
    const dispatch = async () => {
        let parsed;
        try {
            parsed = JSON.parse(params);
        }
        catch {
            setParamsError("Invalid JSON");
            return;
        }
        setParamsError(null);
        setBusy(true);
        try {
            await api.post("/jobs", {
                deviceId: device.id,
                type: jobType,
                params: parsed,
            });
            onDispatched();
            onClose();
        }
        catch (e) {
            alert(e.message);
            setBusy(false);
        }
    };
    const requiresRoot = jobTypes.find((definition) => definition.actionKey === jobType)?.requiresRoot === true;
    return (_jsx("div", { style: {
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }, onClick: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { style: {
                background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "10px",
                padding: "24px", width: "440px",
            }, children: [_jsxs("h3", { style: { margin: "0 0 16px", fontFamily: "monospace", color: "#e2e8f0" }, children: ["Dispatch Job \u2014 ", device.friendlyName ?? device.model] }), _jsx("label", { style: { fontSize: "12px", color: "#94a3b8" }, children: "Job type" }), _jsx("select", { value: jobType, onChange: e => handleTypeChange(e.target.value), style: {
                        width: "100%", boxSizing: "border-box", background: "#1e293b",
                        border: `1px solid ${requiresRoot ? "#ef4444" : "#334155"}`,
                        borderRadius: "6px", padding: "7px 10px",
                        color: requiresRoot ? "#fca5a5" : "#e2e8f0",
                        fontFamily: "monospace", fontSize: "12px",
                        marginBottom: "12px", marginTop: "4px", cursor: "pointer",
                    }, children: jobTypes.map((definition) => (_jsx("option", { value: definition.actionKey, children: definition.label }, definition.actionKey))) }), requiresRoot && (_jsx("div", { style: {
                        background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444",
                        borderRadius: "6px", padding: "8px 12px", marginBottom: "12px",
                        fontSize: "11px", color: "#fca5a5", fontFamily: "monospace",
                    }, children: "\u26A0\uFE0F Privileged operation \u2014 requires root. Confirm params carefully." })), _jsx("label", { style: { fontSize: "12px", color: "#94a3b8" }, children: "Params (JSON)" }), _jsx("textarea", { value: params, onChange: e => { setParams(e.target.value); setParamsError(null); }, rows: 4, style: {
                        width: "100%", boxSizing: "border-box", background: "#1e293b",
                        border: `1px solid ${paramsError ? "#ef4444" : "#334155"}`,
                        borderRadius: "6px", padding: "7px 10px", color: "#e2e8f0",
                        fontFamily: "monospace", fontSize: "12px", marginTop: "4px", resize: "vertical",
                    } }), paramsError && (_jsx("div", { style: { color: "#ef4444", fontSize: "11px", fontFamily: "monospace", marginTop: "4px" }, children: paramsError })), _jsxs("div", { style: { display: "flex", gap: "10px", marginTop: "16px", justifyContent: "flex-end" }, children: [_jsx("button", { onClick: onClose, style: { background: "transparent", color: "#64748b", border: "1px solid #334155", borderRadius: "6px", padding: "7px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px" }, children: "Cancel" }), _jsx("button", { onClick: dispatch, disabled: busy, style: {
                                background: requiresRoot ? "#7f1d1d" : "#1d4ed8",
                                color: requiresRoot ? "#fca5a5" : "#bfdbfe",
                                border: "none", borderRadius: "6px", padding: "7px 20px",
                                cursor: "pointer", fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
                                opacity: busy ? 0.6 : 1,
                            }, children: busy ? "Sending…" : requiresRoot ? "⚠️ Dispatch" : "Dispatch" })] })] }) }));
}
