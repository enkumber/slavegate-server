import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
function Badge({ label, tone }) {
    const palette = {
        green: { bg: "#0f3323", color: "#4ade80", border: "#166534" },
        yellow: { bg: "#332b12", color: "#fbbf24", border: "#854d0e" },
        gray: { bg: "#1f1f1f", color: "#d4d4d8", border: "#333" },
        red: { bg: "#3a1618", color: "#f87171", border: "#7f1d1d" },
        blue: { bg: "#102033", color: "#60a5fa", border: "#1d4ed8" },
    }[tone];
    return (_jsx("span", { style: { background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px", whiteSpace: "nowrap" }, children: label }));
}
function toneForState(state) {
    if (state === "enabled")
        return "green";
    if (state === "review_ready")
        return "yellow";
    if (state === "blocked")
        return "red";
    return "gray";
}
function textList(values, limit = 3) {
    const items = Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
    if (!items.length)
        return "-";
    return `${items.slice(0, limit).join(", ")}${items.length > limit ? " +" : ""}`;
}
export function CompilerControlPlanePage() {
    const [intent, setIntent] = useState("unlock device");
    const [scope, setScope] = useState("device:test-device");
    const [data, setData] = useState(null);
    const [events, setEvents] = useState([]);
    const [gateEvents, setGateEvents] = useState([]);
    const [gateNote, setGateNote] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [controlPlane, eventPage, policyEvents] = await Promise.all([
                agencyApi.compilerControlPlane.get({ intent: intent || undefined, scope: scope || undefined }),
                agencyApi.compilerControlPlane.listEvents({ pageSize: 5 }),
                agencyApi.compilerPolicyGates.listEvents({ pageSize: 6 }),
            ]);
            setData(controlPlane);
            setEvents(eventPage.items);
            setGateEvents(policyEvents.items);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load Compiler Control Plane");
        }
        finally {
            setLoading(false);
        }
    }, [intent, scope]);
    useEffect(() => {
        void load();
    }, [load]);
    const gateSummary = data?.policyGates.summary;
    const manifest = data?.capabilityManifest;
    const dryRun = data?.dryRun;
    const reuseSummary = data?.limitedReusePlan.summary;
    const visibleTools = useMemo(() => (manifest?.tools ?? []).slice(0, 10), [manifest?.tools]);
    const updateGate = useCallback(async (gateId, state, risk) => {
        setLoading(true);
        setError(null);
        try {
            await agencyApi.compilerPolicyGates.update(gateId, {
                state,
                note: gateNote || null,
                config: state === "enabled" && risk === "high" ? { explicitApproval: true } : {},
            });
            await load();
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update policy gate");
        }
        finally {
            setLoading(false);
        }
    }, [gateNote, load]);
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/compiler-control-plane", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Compiler Control Plane" }) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx(Badge, { label: "readOnly: true", tone: "blue" }), _jsx(Badge, { label: "autoUseEnabled: false", tone: "gray" }), _jsx(Badge, { label: "wouldChangePlan: false", tone: "gray" }), _jsx(Badge, { label: "wouldExecuteStepLibrary: false", tone: "gray" }), _jsx(Badge, { label: "workflowCacheChanging: false", tone: "gray" })] }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx("input", { value: intent, onChange: (event) => setIntent(event.target.value), placeholder: "Intent", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("input", { value: scope, onChange: (event) => setScope(event.target.value), placeholder: "Scope", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("button", { onClick: () => void load(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Run read-only dry-run" }), loading && _jsx("span", { style: { color: "#777", fontSize: "12px" }, children: "Loading..." }), error && _jsx("span", { style: { color: "#f87171", fontSize: "12px" }, children: error })] }) }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "12px", marginBottom: "14px" }, children: [
                    ["Policy gates", gateSummary?.total ?? 0, "#60a5fa"],
                    ["Blocked", gateSummary?.blocked ?? 0, "#f87171"],
                    ["High risk", gateSummary?.highRisk ?? 0, "#fbbf24"],
                    ["Safe auto apply", gateSummary?.safeToAutoApply ?? 0, "#a1a1aa"],
                ].map(([label, value, color]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "6px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 600 }, children: String(value) })] }, label))) }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }, children: [_jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Scoped Dry-Run" }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: `outcome: ${dryRun?.outcome ?? "-"}`, tone: "red" }), _jsx(Badge, { label: "safeToAutoApply: false", tone: "gray" })] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", lineHeight: 1.6 }, children: ["Blockers: ", textList(dryRun?.blockers, 6)] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", lineHeight: 1.6 }, children: ["Selected steps: ", (dryRun?.selectedStepIds ?? []).length] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", lineHeight: 1.6 }, children: ["Selected tools: ", (dryRun?.selectedToolIds ?? []).length] })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Capability Manifest" }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: manifest?.compatibility.state ?? "unknown_device", tone: manifest?.compatibility.state === "known_device" ? "green" : "yellow" }), _jsx(Badge, { label: `device: ${manifest?.deviceName ?? "-"}`, tone: "gray" }), _jsx(Badge, { label: `agent: ${manifest?.agentVersion ?? "-"}`, tone: "gray" })] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", lineHeight: 1.6 }, children: ["Available tools: ", String(manifest?.compatibility.availableTools ?? 0), " / ", String(manifest?.compatibility.totalTools ?? 0)] }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "8px" }, children: ["Source: ", manifest?.source ?? "-", " \u00B7 device published: ", manifest?.publishedByDevice ? "yes" : "no"] }), _jsx("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }, children: visibleTools.slice(0, 6).map((tool) => (_jsx(Badge, { label: `${String(tool.id)}: ${tool.available ? "available" : "blocked"}`, tone: tool.available ? "green" : "gray" }, String(tool.id)))) })] })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Limited Reuse Plan" }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: `candidates: ${String(reuseSummary?.candidates ?? 0)}`, tone: "blue" }), _jsx(Badge, { label: `scope matches: ${String(reuseSummary?.scopeMatches ?? 0)}`, tone: "gray" }), _jsx(Badge, { label: `capability matches: ${String(reuseSummary?.capabilityMatches ?? 0)}`, tone: "gray" }), _jsx(Badge, { label: "wouldUse: 0", tone: "gray" })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "10px" }, children: [data?.limitedReusePlan.items.map((item) => (_jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: item.name ?? item.action ?? item.stepId }), _jsx("div", { style: { color: "#666", fontSize: "11px", marginTop: "4px" }, children: item.promotionScope ?? "no scope" }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }, children: [_jsx(Badge, { label: `scope: ${item.scopeMatch ? "match" : "blocked"}`, tone: item.scopeMatch ? "green" : "red" }), _jsx(Badge, { label: `cap: ${item.capabilityMatch ? "match" : "blocked"}`, tone: item.capabilityMatch ? "green" : "red" })] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.45, marginTop: "8px" }, children: ["Blockers: ", textList(item.blockers, 4)] })] }, `${item.stepId ?? item.action}`))), !data?.limitedReusePlan.items.length && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No matching limited reuse candidates." })] })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Policy Gate State" }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }, children: [_jsx("input", { value: gateNote, onChange: (event) => setGateNote(event.target.value), placeholder: "Gate audit note", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" } }), _jsx(Badge, { label: "policy updates are audited", tone: "blue" }), _jsx(Badge, { label: "wouldExecuteWorkflow: false", tone: "gray" })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(190px, 1fr))", gap: "10px" }, children: data?.policyGates.items.map((gate) => (_jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: gate.title }), _jsx("div", { style: { color: "#666", fontSize: "11px", marginTop: "4px" }, children: gate.id }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }, children: [_jsx(Badge, { label: gate.state, tone: toneForState(gate.state) }), _jsx(Badge, { label: `v${gate.version ?? 1}`, tone: "blue" }), _jsx(Badge, { label: gate.risk, tone: gate.risk === "high" ? "red" : gate.risk === "medium" ? "yellow" : "green" })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }, children: [_jsx("button", { onClick: () => void updateGate(gate.id, "blocked", gate.risk), disabled: loading || gate.state === "blocked", style: { background: "#1f1f1f", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "6px 8px", cursor: loading || gate.state === "blocked" ? "not-allowed" : "pointer", fontSize: "11px" }, children: "Block" }), _jsx("button", { onClick: () => void updateGate(gate.id, "review_ready", gate.risk), disabled: loading || gate.state === "review_ready", style: { background: "#332b12", border: "1px solid #854d0e", color: "#fef3c7", borderRadius: "6px", padding: "6px 8px", cursor: loading || gate.state === "review_ready" ? "not-allowed" : "pointer", fontSize: "11px" }, children: "Review" }), _jsx("button", { onClick: () => void updateGate(gate.id, "enabled", gate.risk), disabled: loading || gate.state === "enabled", style: { background: "#0f3323", border: "1px solid #166534", color: "#dcfce7", borderRadius: "6px", padding: "6px 8px", cursor: loading || gate.state === "enabled" ? "not-allowed" : "pointer", fontSize: "11px" }, children: "Enable" })] })] }, gate.id))) })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Policy Gate Audit" }), _jsxs("div", { style: { display: "grid", gap: "8px" }, children: [gateEvents.map((event) => (_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 110px 110px 140px", gap: "10px", alignItems: "center", borderBottom: "1px solid #1f1f1f", paddingBottom: "8px" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: event.gateId }), _jsx(Badge, { label: event.previousState ?? "-", tone: toneForState(event.previousState ?? undefined) }), _jsx(Badge, { label: event.nextState, tone: toneForState(event.nextState) }), _jsx("div", { style: { color: "#666", fontSize: "11px" }, children: event.createdAt ? new Date(event.createdAt).toLocaleString() : "-" })] }, event.id))), !gateEvents.length && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No policy gate updates yet." })] })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Recent Control Plane Checks" }), _jsxs("div", { style: { display: "grid", gap: "8px" }, children: [events.map((event) => (_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1.2fr 1fr 140px", gap: "10px", alignItems: "center", borderBottom: "1px solid #1f1f1f", paddingBottom: "8px" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px" }, children: event.intent ?? "-" }), _jsx("div", { style: { color: "#888", fontSize: "12px" }, children: event.requestedScope ?? "-" }), _jsx("div", { style: { color: "#666", fontSize: "11px" }, children: event.createdAt ? new Date(event.createdAt).toLocaleString() : "-" })] }, event.id))), !events.length && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No control plane checks yet." })] })] })] }));
}
