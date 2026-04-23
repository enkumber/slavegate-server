import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * FarmingProfilesPage.tsx
 * Agency farming profiles list + detail/edit modal.
 */
import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
function StrategyEditor({ strategy, onChange }) {
    const fields = [
        { key: "phase", label: "Phase", type: "select", options: ["warmup", "growth", "maintenance"] },
        { key: "daily_limits", label: "Daily Limits", type: "text" },
        { key: "seeds", label: "Seeds", type: "textarea" },
        { key: "engagement_windows", label: "Engagement Windows", type: "text" },
        { key: "target_audience", label: "Target Audience", type: "textarea" },
        { key: "content_strategy", label: "Content Strategy", type: "textarea" },
    ];
    return (_jsx("div", { style: { display: "flex", flexDirection: "column", gap: "12px" }, children: fields.map((field) => (_jsxs("div", { children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "4px" }, children: field.label }), field.type === "textarea" ? (_jsx("textarea", { value: strategy[field.key] ?? "", onChange: (e) => onChange({ ...strategy, [field.key]: e.target.value }), style: {
                        width: "100%",
                        padding: "8px 10px",
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "13px",
                        minHeight: "60px",
                        resize: "vertical",
                    } })) : field.type === "select" ? (_jsxs("select", { value: strategy[field.key] ?? "", onChange: (e) => onChange({ ...strategy, [field.key]: e.target.value }), style: {
                        width: "100%",
                        padding: "8px 10px",
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "13px",
                    }, children: [_jsx("option", { value: "", children: "Select..." }), field.options?.map((opt) => (_jsx("option", { value: opt, children: opt }, opt)))] })) : (_jsx("input", { type: "text", value: strategy[field.key] ?? "", onChange: (e) => onChange({ ...strategy, [field.key]: e.target.value }), style: {
                        width: "100%",
                        padding: "8px 10px",
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "13px",
                    } }))] }, field.key))) }));
}
function FarmingProfileModal({ profile, isNew, onClose, onSave }) {
    const [name, setName] = useState(profile?.name ?? "");
    const [active, setActive] = useState(profile?.active ?? true);
    const [strategy, setStrategy] = useState(profile?.strategy ?? {});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const handleSave = async () => {
        if (!name.trim()) {
            setError("Name is required");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            if (isNew) {
                await agencyApi.clients.create({ name: name.trim(), strategy, type: 'farming' });
            }
            else if (profile) {
                await agencyApi.clients.update(profile.id, { name: name.trim(), active, strategy });
            }
            onSave();
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
            background: "rgba(0,0,0,0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
        }, onClick: onClose, children: _jsxs("div", { style: {
                background: "#111",
                borderRadius: "8px",
                border: "1px solid #333",
                width: "500px",
                maxHeight: "80vh",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
            }, onClick: (e) => e.stopPropagation(), children: [_jsx("div", { style: { padding: "16px 20px", borderBottom: "1px solid #222" }, children: _jsx("h3", { style: { color: "#fff", margin: 0, fontSize: "16px" }, children: isNew ? "New Farming Profile" : `Edit: ${profile?.name}` }) }), _jsxs("div", { style: { padding: "20px", overflowY: "auto", flex: 1 }, children: [_jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { display: "block", color: "#888", fontSize: "12px", marginBottom: "4px" }, children: "Profile Name" }), _jsx("input", { type: "text", value: name, onChange: (e) => setName(e.target.value), placeholder: "e.g. Tech Farming Profile", style: {
                                        width: "100%",
                                        padding: "10px 12px",
                                        background: "#1a1a1a",
                                        border: "1px solid #333",
                                        borderRadius: "4px",
                                        color: "#fff",
                                        fontSize: "14px",
                                    } })] }), !isNew && (_jsx("div", { style: { marginBottom: "16px" }, children: _jsxs("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }, children: [_jsx("input", { type: "checkbox", checked: active, onChange: (e) => setActive(e.target.checked) }), _jsx("span", { style: { color: "#ccc", fontSize: "13px" }, children: "Active" })] }) })), _jsxs("div", { children: [_jsx("h4", { style: { color: "#aaa", fontSize: "13px", marginBottom: "12px" }, children: "Strategy" }), _jsx(StrategyEditor, { strategy: strategy, onChange: setStrategy })] }), error && (_jsxs("div", { style: { marginTop: "16px", color: "#f55", fontSize: "13px" }, children: ["\u26A0\uFE0F ", error] }))] }), _jsxs("div", { style: {
                        padding: "16px 20px",
                        borderTop: "1px solid #222",
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "12px",
                    }, children: [_jsx("button", { onClick: onClose, style: {
                                padding: "8px 16px",
                                background: "#333",
                                border: "none",
                                borderRadius: "4px",
                                color: "#ccc",
                                cursor: "pointer",
                            }, children: "Cancel" }), _jsx("button", { onClick: handleSave, disabled: saving, style: {
                                padding: "8px 16px",
                                background: saving ? "#444" : "#16a34a",
                                border: "none",
                                borderRadius: "4px",
                                color: "#fff",
                                cursor: saving ? "not-allowed" : "pointer",
                            }, children: saving ? "Saving..." : "Save" })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function FarmingProfilesPage() {
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showActiveOnly, setShowActiveOnly] = useState(false);
    const [modalState, setModalState] = useState({
        open: false,
        profile: null,
        isNew: false,
    });
    const fetchProfiles = useCallback(async () => {
        try {
            const data = await agencyApi.clients.list({
                active: showActiveOnly ? true : undefined,
                type: 'farming'
            });
            setProfiles(data.items);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [showActiveOnly]);
    useEffect(() => {
        fetchProfiles();
    }, [fetchProfiles]);
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/farming", children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\uD83C\uDF31 Farming Profiles" }), _jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [_jsxs("label", { style: { display: "flex", alignItems: "center", gap: "6px", color: "#888", fontSize: "13px" }, children: [_jsx("input", { type: "checkbox", checked: showActiveOnly, onChange: (e) => setShowActiveOnly(e.target.checked) }), "Active only"] }), _jsx("button", { onClick: () => setModalState({ open: true, profile: null, isNew: true }), style: {
                                    padding: "8px 16px",
                                    background: "#16a34a",
                                    border: "none",
                                    borderRadius: "6px",
                                    color: "#fff",
                                    cursor: "pointer",
                                    fontSize: "13px",
                                }, children: "+ New Profile" })] })] }), error && (_jsxs("div", { style: { padding: "12px 16px", background: "#2a1515", borderRadius: "6px", color: "#f88", marginBottom: "16px" }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : profiles.length === 0 ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "No farming profiles yet. Create one to get started." })) : (
            /* Profile grid */
            _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }, children: profiles.map((profile) => (_jsxs("div", { onClick: () => setModalState({ open: true, profile, isNew: false }), style: {
                        background: "#111",
                        border: "1px solid #222",
                        borderRadius: "8px",
                        padding: "16px",
                        cursor: "pointer",
                        transition: "border-color 0.15s ease",
                    }, onMouseEnter: (e) => (e.currentTarget.style.borderColor = "#444"), onMouseLeave: (e) => (e.currentTarget.style.borderColor = "#222"), children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" }, children: [_jsx("h3", { style: { color: "#fff", margin: 0, fontSize: "15px" }, children: profile.name }), _jsx("span", { style: {
                                        padding: "2px 8px",
                                        borderRadius: "4px",
                                        fontSize: "11px",
                                        background: profile.active ? "#0d3320" : "#2a1515",
                                        color: profile.active ? "#4ade80" : "#f88",
                                    }, children: profile.active ? "Active" : "Inactive" })] }), _jsxs("div", { style: { marginTop: "12px" }, children: [typeof profile.strategy.phase === "string" && profile.strategy.phase && (_jsxs("div", { style: { color: "#888", fontSize: "12px", marginBottom: "4px" }, children: [_jsx("strong", { children: "Phase:" }), " ", profile.strategy.phase] })), typeof profile.strategy.daily_limits === "string" && profile.strategy.daily_limits && (_jsxs("div", { style: { color: "#888", fontSize: "12px", marginBottom: "4px" }, children: [_jsx("strong", { children: "Daily Limits:" }), " ", profile.strategy.daily_limits] })), typeof profile.strategy.target_audience === "string" && profile.strategy.target_audience && (_jsxs("div", { style: { color: "#888", fontSize: "12px" }, children: [_jsx("strong", { children: "Audience:" }), " ", profile.strategy.target_audience.slice(0, 40), profile.strategy.target_audience.length > 40 ? "..." : ""] }))] }), _jsxs("div", { style: { marginTop: "12px", color: "#555", fontSize: "11px" }, children: ["Created ", new Date(profile.created_at).toLocaleDateString()] })] }, profile.id))) })), modalState.open && (_jsx(FarmingProfileModal, { profile: modalState.profile, isNew: modalState.isNew, onClose: () => setModalState({ open: false, profile: null, isNew: false }), onSave: fetchProfiles }))] }));
}
