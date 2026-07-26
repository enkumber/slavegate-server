import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
const panel = { background: "#101018", border: "1px solid #29293d", borderRadius: 8, padding: 16 };
const button = { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: 6, padding: "7px 10px", cursor: "pointer" };
function pct(value) {
    return `${((value ?? 0) * 100).toFixed(1)}%`;
}
export function UiGraphPage() {
    const [status, setStatus] = useState(null);
    const [candidates, setCandidates] = useState([]);
    const [scopeType, setScopeType] = useState("global");
    const [scopeValue, setScopeValue] = useState("*");
    const [mode, setMode] = useState("shadow");
    const [reason, setReason] = useState("");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const [nextStatus, nextCandidates] = await Promise.all([
                api.get("/ui-graph/status"),
                api.get("/ui-graph/candidates"),
            ]);
            setStatus(nextStatus);
            setCandidates(nextCandidates);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load UI Graph runtime");
        }
        finally {
            setBusy(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    const saveFlag = async () => {
        setBusy(true);
        try {
            await api.put(`/ui-graph/flags/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeValue)}`, {
                mode, selectorFirst: true, graphRuntime: true, aiRecovery: true, candidateLearning: true, autoPromotion: false,
            });
            await load();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Flag update failed");
        }
        finally {
            setBusy(false);
        }
    };
    const candidateAction = async (id, action) => {
        if (!reason.trim()) {
            setError("Audit reason is required");
            return;
        }
        setBusy(true);
        try {
            await api.post(`/ui-graph/candidates/${id}/${action}`, { reason });
            await load();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : `${action} failed`);
        }
        finally {
            setBusy(false);
        }
    };
    const materialize = async () => {
        setBusy(true);
        try {
            await api.post("/ui-graph/materialize");
            await load();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Materialization failed");
        }
        finally {
            setBusy(false);
        }
    };
    const stats = status?.effective24h;
    return (_jsxs("main", { style: { padding: 24, color: "#e5e7eb", fontFamily: "system-ui, sans-serif" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }, children: [_jsxs("div", { children: [_jsx("h1", { style: { margin: 0, fontSize: 24 }, children: "UI Graph Runtime" }), _jsx("div", { style: { color: "#8b8ba7", marginTop: 5, fontSize: 13 }, children: "Fast path, state resolution, recovery and controlled learning" })] }), _jsxs("div", { style: { display: "flex", gap: 8 }, children: [_jsx("button", { style: button, disabled: busy, onClick: () => void materialize(), children: "Materialize App Maps" }), _jsx("button", { style: button, disabled: busy, onClick: () => void load(), children: "Refresh" })] })] }), error && _jsx("div", { style: { background: "#3a1618", border: "1px solid #7f1d1d", color: "#fca5a5", padding: 10, borderRadius: 6, marginBottom: 14 }, children: error }), _jsx("section", { style: { display: "grid", gridTemplateColumns: "repeat(5, minmax(130px, 1fr))", gap: 12, marginBottom: 14 }, children: [
                    ["Fast path", pct(stats?.fastPathRate)],
                    ["VLM rate", pct(stats?.vlmRate)],
                    ["Unknown state", pct(stats?.unknownStateRate)],
                    ["p50 latency", `${Math.round(stats?.p50_latency_ms ?? 0)} ms`],
                    ["p95 latency", `${Math.round(stats?.p95_latency_ms ?? 0)} ms`],
                ].map(([label, value]) => _jsxs("div", { style: panel, children: [_jsx("div", { style: { color: "#77778f", fontSize: 11 }, children: label }), _jsx("div", { style: { fontSize: 22, marginTop: 6 }, children: value })] }, label)) }), _jsxs("section", { style: { ...panel, marginBottom: 14 }, children: [_jsx("div", { style: { fontWeight: 600, marginBottom: 10 }, children: "Scoped rollout control" }), _jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: [_jsxs("select", { value: scopeType, onChange: (event) => setScopeType(event.target.value), style: { ...button, cursor: "default" }, children: [_jsx("option", { value: "global", children: "global" }), _jsx("option", { value: "app", children: "app" }), _jsx("option", { value: "workflow", children: "workflow" }), _jsx("option", { value: "device", children: "device" })] }), _jsx("input", { value: scopeValue, onChange: (event) => setScopeValue(event.target.value), style: { ...button, minWidth: 260, cursor: "text" } }), _jsxs("select", { value: mode, onChange: (event) => setMode(event.target.value), style: { ...button, cursor: "default" }, children: [_jsx("option", { value: "disabled", children: "disabled" }), _jsx("option", { value: "shadow", children: "shadow" }), _jsx("option", { value: "enforced", children: "enforced" })] }), _jsx("button", { style: button, disabled: busy, onClick: () => void saveFlag(), children: "Save scope" }), _jsxs("span", { style: { color: "#77778f", fontSize: 12, alignSelf: "center" }, children: ["Startup kill switch: ", status?.startupDefaults.mode ?? "-"] })] })] }), _jsxs("section", { style: panel, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }, children: [_jsx("div", { style: { fontWeight: 600 }, children: "Learning candidates" }), _jsx("input", { value: reason, onChange: (event) => setReason(event.target.value), placeholder: "Required audit reason", style: { ...button, minWidth: 300, cursor: "text" } })] }), _jsxs("div", { style: { display: "grid", gap: 8 }, children: [candidates.map((candidate) => (_jsxs("div", { style: { background: "#0b0b12", border: "1px solid #242438", borderRadius: 6, padding: 12, display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr auto", gap: 12, alignItems: "center" }, children: [_jsxs("div", { children: [_jsxs("div", { style: { fontWeight: 600 }, children: [candidate.app_id, " \u00B7 ", candidate.candidate_type] }), _jsx("div", { style: { color: "#77778f", fontSize: 11, marginTop: 4 }, children: String(candidate.payload?.elementKey ?? candidate.payload?.transitionKey ?? candidate.discovery_method) })] }), _jsxs("div", { style: { fontSize: 12 }, children: [candidate.status, " \u00B7 ", (Number(candidate.confidence) * 100).toFixed(0), "%"] }), _jsxs("div", { style: { fontSize: 12, color: "#9ca3af" }, children: [candidate.success_count, " ok / ", candidate.failure_count, " fail / ", candidate.distinct_context_count, " portable envs"] }), _jsxs("div", { style: { display: "flex", gap: 6 }, children: [_jsx("button", { style: button, disabled: busy, onClick: () => void candidateAction(candidate.id, "promote"), children: "Promote" }), _jsx("button", { style: { ...button, borderColor: "#7f1d1d", color: "#fca5a5" }, disabled: busy, onClick: () => void candidateAction(candidate.id, "quarantine"), children: "Quarantine" })] })] }, candidate.id))), !candidates.length && _jsx("div", { style: { color: "#77778f", fontSize: 13 }, children: "No candidates yet." })] })] })] }));
}
