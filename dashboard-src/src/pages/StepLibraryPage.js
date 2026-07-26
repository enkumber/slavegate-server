import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * StepLibraryPage.tsx
 * Read-only registry of manually validated workflow step candidates.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
import { statusLabel, statusTone } from "../utils/statusPresentation";
function formatDate(value) {
    return value ? new Date(value).toLocaleString() : "-";
}
function Badge({ label, tone }) {
    const palette = {
        green: { bg: "#0f3323", color: "#4ade80", border: "#166534" },
        yellow: { bg: "#332b12", color: "#fbbf24", border: "#854d0e" },
        gray: { bg: "#1f1f1f", color: "#d4d4d8", border: "#333" },
        red: { bg: "#3a1618", color: "#f87171", border: "#7f1d1d" },
    }[tone];
    return (_jsx("span", { style: { background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px" }, children: label }));
}
function listPreview(items) {
    if (!items.length)
        return "-";
    return items.slice(0, 2).join("; ");
}
function formatPercent(value) {
    return typeof value === "number" ? `${Math.round(value * 100)}%` : "-";
}
function badgeTone(value) {
    const tone = statusTone(value);
    return tone === "blue" ? "gray" : tone;
}
export function StepLibraryPage() {
    const [entries, setEntries] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [actionFilter, setActionFilter] = useState("");
    const [intentFilter, setIntentFilter] = useState("");
    const [promotionScope, setPromotionScope] = useState("");
    const [promotionNote, setPromotionNote] = useState("");
    const [promotionBusy, setPromotionBusy] = useState(false);
    const [promotionEvents, setPromotionEvents] = useState([]);
    const [promotionEventsTotal, setPromotionEventsTotal] = useState(0);
    const [promotionEventsLoading, setPromotionEventsLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const selected = useMemo(() => entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null, [entries, selectedId]);
    const loadEntries = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await agencyApi.stepLibrary.list({
                pageSize: 50,
                action: actionFilter.trim() || undefined,
                intent: intentFilter.trim() || undefined,
            });
            setEntries(data.items);
            setSelectedId((current) => current && data.items.some((entry) => entry.id === current) ? current : data.items[0]?.id ?? null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load Step Library");
        }
        finally {
            setLoading(false);
        }
    }, [actionFilter, intentFilter]);
    useEffect(() => {
        void loadEntries();
    }, [loadEntries]);
    useEffect(() => {
        setPromotionScope(selected?.promotionScope ?? selected?.reuseScope ?? "");
        setPromotionNote(selected?.promotionNote ?? "");
    }, [selected?.id]);
    const loadPromotionEvents = useCallback(async (entryId) => {
        if (!entryId) {
            setPromotionEvents([]);
            setPromotionEventsTotal(0);
            return;
        }
        setPromotionEventsLoading(true);
        try {
            const data = await agencyApi.stepLibrary.listPromotionEvents({ entryId, pageSize: 20 });
            setPromotionEvents(data.items);
            setPromotionEventsTotal(data.total);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load promotion audit history");
        }
        finally {
            setPromotionEventsLoading(false);
        }
    }, []);
    useEffect(() => {
        void loadPromotionEvents(selected?.id ?? null);
    }, [loadPromotionEvents, selected?.id]);
    const updateSelectedEntry = (updated) => {
        setEntries((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
        setSelectedId(updated.id);
        void loadPromotionEvents(updated.id);
    };
    const applyPromotionTransition = async (actionKey, requiresScope) => {
        if (!selected || promotionBusy)
            return;
        const scope = promotionScope.trim();
        if (requiresScope && !scope) {
            setError("Promotion scope is required.");
            return;
        }
        setPromotionBusy(true);
        setError(null);
        try {
            const updated = await agencyApi.stepLibrary.updatePromotion(selected.id, {
                action: actionKey,
                scope: scope || null,
                note: promotionNote.trim() || null,
            });
            updateSelectedEntry(updated);
            await loadEntries();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to apply Step Library transition");
        }
        finally {
            setPromotionBusy(false);
        }
    };
    const validatedCount = entries.filter((entry) => Boolean(entry.validatedAt)).length;
    const compilerEligibleCount = entries.filter((entry) => entry.compilerEligible).length;
    const reviewReadyCount = entries.filter((entry) => entry.readiness.score >= entry.readiness.threshold).length;
    const limitedReuseCount = entries.filter((entry) => entry.reusable).length;
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/step-library", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Step Library" }) }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "12px", marginBottom: "18px" }, children: [
                    ["Validated", validatedCount, "#4ade80"],
                    ["Limited reuse", limitedReuseCount, limitedReuseCount === 0 ? "#a1a1aa" : "#4ade80"],
                    ["Review ready", reviewReadyCount, reviewReadyCount === 0 ? "#a1a1aa" : "#60a5fa"],
                    ["Compiler eligible", compilerEligibleCount, compilerEligibleCount === 0 ? "#a1a1aa" : "#60a5fa"],
                ].map(([label, value, color]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "6px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 600 }, children: value })] }, label))) }), _jsxs("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px", flexWrap: "wrap" }, children: [_jsx("input", { value: actionFilter, onChange: (event) => setActionFilter(event.target.value), placeholder: "Filter action", style: { background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "160px" } }), _jsx("input", { value: intentFilter, onChange: (event) => setIntentFilter(event.target.value), placeholder: "Filter intent", style: { background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("button", { onClick: () => void loadEntries(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Refresh" })] }), error && _jsx("div", { style: { color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }, children: error }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "minmax(400px, 1.1fr) minmax(360px, 0.9fr)", gap: "16px", alignItems: "start" }, children: [_jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }, children: [_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1.1fr 0.8fr 0.7fr 0.8fr 0.8fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }, children: [_jsx("div", { children: "Step" }), _jsx("div", { children: "State" }), _jsx("div", { children: "Readiness" }), _jsx("div", { children: "Scope" }), _jsx("div", { children: "Validated" })] }), loading ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "Loading..." })) : entries.length === 0 ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "No validated steps found." })) : (entries.map((entry) => (_jsxs("button", { onClick: () => setSelectedId(entry.id), style: {
                                    width: "100%",
                                    display: "grid",
                                    gridTemplateColumns: "1.1fr 0.8fr 0.7fr 0.8fr 0.8fr",
                                    gap: "10px",
                                    alignItems: "center",
                                    padding: "12px",
                                    background: selected?.id === entry.id ? "#151515" : "transparent",
                                    border: 0,
                                    borderBottom: "1px solid #1f1f1f",
                                    color: "#ddd",
                                    textAlign: "left",
                                    cursor: "pointer",
                                }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }, children: entry.name }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "4px" }, children: [entry.action ?? entry.type ?? "step", " \u00B7 ", entry.runIntent ?? "unknown intent"] })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [_jsx(Badge, { label: "Validated", tone: "green" }), _jsx(Badge, { label: statusLabel(entry.libraryState), tone: entry.reusable || entry.compilerEligible ? "green" : "yellow" })] }), _jsx("div", { style: { color: entry.readiness.score >= entry.readiness.threshold ? "#60a5fa" : "#fbbf24", fontSize: "12px" }, children: formatPercent(entry.readiness?.score ?? entry.confidence) }), _jsx("div", { style: { color: "#aaa", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: entry.reuseScope }), _jsx("div", { style: { color: "#aaa", fontSize: "12px" }, children: formatDate(entry.validatedAt) })] }, entry.id))))] }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }, children: selected ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { color: "#fff", fontSize: "16px", margin: "0 0 6px" }, children: selected.name }), _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: selected.id })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }, children: [_jsx(Badge, { label: statusLabel(selected.libraryState), tone: badgeTone(selected.libraryState) }), _jsx(Badge, { label: statusLabel(selected.readiness.state), tone: selected.readiness.score >= selected.readiness.threshold ? "green" : "yellow" }), _jsx(Badge, { label: selected.reusable ? "Reusable" : "Not reusable", tone: selected.reusable ? "green" : "gray" }), _jsx(Badge, { label: selected.compilerEligible ? "Compiler eligible" : "Compiler disabled", tone: selected.compilerEligible ? "green" : "gray" })] })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "14px" }, children: [
                                        ["Action", selected.action ?? "-"],
                                        ["Type", selected.type ?? "-"],
                                        ["Scope", selected.reuseScope],
                                        ["Readiness", formatPercent(selected.readiness?.score ?? selected.confidence)],
                                        ["Device", selected.deviceName ?? "-"],
                                        ["Run intent", selected.runIntent ?? "-"],
                                        ["Validated by", selected.validatedBy ?? "-"],
                                        ["Promoted by", selected.promotedBy ?? "-"],
                                    ].map(([label, value]) => (_jsxs("div", { style: { background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: value })] }, label))) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Readiness Gate" }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "8px" }, children: ["State: ", selected.readiness?.state ?? "needs_review", " \u00B7 Threshold: ", formatPercent(selected.readiness?.threshold)] }), _jsx("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }, children: Object.entries(selected.readiness?.gates ?? {}).map(([name, passed]) => (_jsx(Badge, { label: `${name}: ${passed ? "yes" : "no"}`, tone: passed ? "green" : "red" }, name))) }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["Blockers: ", (selected.readiness?.blockers ?? []).join(", ") || "-"] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Promotion Controls" }), _jsx("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "10px" }, children: "Limited reuse stays manual and scope-bound. Compiler auto-use remains disabled." }), _jsx("input", { value: promotionScope, onChange: (event) => setPromotionScope(event.target.value), placeholder: "scope, e.g. device:...", style: { width: "100%", boxSizing: "border-box", background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", marginBottom: "8px" } }), _jsx("textarea", { value: promotionNote, onChange: (event) => setPromotionNote(event.target.value), placeholder: "review note", rows: 2, style: { width: "100%", boxSizing: "border-box", background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", marginBottom: "10px", resize: "vertical" } }), _jsx("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" }, children: selected.promotionTransitions.map((transition) => (_jsx("button", { onClick: () => void applyPromotionTransition(transition.actionKey, transition.target.dispatchable && !transition.target.terminal), disabled: promotionBusy, style: { background: transition.target.terminal ? "#3a1618" : "#166534", border: `1px solid ${transition.target.terminal ? "#7f1d1d" : "#15803d"}`, color: transition.target.terminal ? "#fecaca" : "#dcfce7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }, children: transition.description || transition.toStatus }, transition.actionKey))) })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "8px" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }, children: "Promotion Audit" }), _jsx("button", { onClick: () => void loadPromotionEvents(selected.id), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "5px 8px", cursor: "pointer", fontSize: "11px" }, children: "Refresh" })] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", marginBottom: "10px" }, children: [promotionEventsTotal, " event", promotionEventsTotal === 1 ? "" : "s", " \u00B7 append-only history for manual promotion/revoke decisions"] }), promotionEventsLoading ? (_jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "Loading audit history..." })) : promotionEvents.length === 0 ? (_jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No promotion events yet." })) : (_jsx("div", { style: { display: "grid", gap: "8px" }, children: promotionEvents.map((event) => (_jsxs("div", { style: { border: "1px solid #242424", borderRadius: "6px", padding: "10px", background: "#0d0d0d" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "6px" }, children: [_jsx(Badge, { label: event.action, tone: "gray" }), _jsx("span", { style: { color: "#777", fontSize: "11px" }, children: formatDate(event.createdAt) })] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "4px", overflowWrap: "anywhere" }, children: ["Actor: ", event.actor ?? "-", " \u00B7 Scope: ", event.promotionScope ?? "-"] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }, children: ["Note: ", event.note ?? "-"] })] }, event.id))) }))] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Contract" }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "8px" }, children: ["Preconditions: ", listPreview(selected.preconditions)] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["Postconditions: ", listPreview(selected.postconditions)] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Evidence" }), _jsx("pre", { style: { margin: 0, color: "#a1a1aa", fontSize: "11px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "220px", overflowY: "auto" }, children: JSON.stringify(selected.evidence, null, 2) })] })] })) : (_jsx("div", { style: { color: "#777", textAlign: "center", padding: "28px" }, children: "Select a step." })) })] })] }));
}
