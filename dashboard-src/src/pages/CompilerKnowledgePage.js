import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * CompilerKnowledgePage.tsx
 * Read-only rules/examples that will later guide workflow compilation.
 */
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
    return (_jsx("span", { style: { background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px" }, children: label }));
}
function riskTone(risk) {
    if (risk === "low")
        return "green";
    if (risk === "medium")
        return "yellow";
    return "red";
}
function sourceTone(source) {
    if (source === "product_decision")
        return "blue";
    if (source === "qa_guardrail")
        return "yellow";
    if (source === "live_incident")
        return "red";
    return "green";
}
function stateTone(state) {
    if (state === "enabled")
        return "green";
    if (state === "review_ready")
        return "yellow";
    if (state === "blocked")
        return "red";
    return "gray";
}
function listText(values) {
    return values.length ? values.join(", ") : "-";
}
function eligibilityBlockers(item) {
    return item.eligibility?.blockers?.length ? item.eligibility.blockers.join(", ") : "-";
}
function remediationActions(item) {
    return item.eligibility?.remediation?.nextActions?.length ? item.eligibility.remediation.nextActions : [];
}
function eligibilityPolicyGates(item) {
    return item.eligibility?.policyGates?.length
        ? item.eligibility.policyGates.map((gate) => gate.id).filter(Boolean).join(", ")
        : "-";
}
function decisionRemediation(decision) {
    return decision.remediation?.nextActions?.length ? decision.remediation.nextActions : [];
}
function decisionPolicyGates(decision) {
    return decision.policyGateSummary?.length
        ? decision.policyGateSummary.map((gate) => gate.id).filter(Boolean).join(", ")
        : "-";
}
export function CompilerKnowledgePage() {
    const [items, setItems] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [typeFilter, setTypeFilter] = useState("");
    const [domainFilter, setDomainFilter] = useState("");
    const [riskFilter, setRiskFilter] = useState("");
    const [sourceFilter, setSourceFilter] = useState("");
    const [policyMode, setPolicyMode] = useState("read_only_knowledge_base");
    const [awarenessIntent, setAwarenessIntent] = useState("unlock device");
    const [awareness, setAwareness] = useState(null);
    const [awarenessEvents, setAwarenessEvents] = useState([]);
    const [policyGates, setPolicyGates] = useState([]);
    const [policyGateMode, setPolicyGateMode] = useState("read_only_compiler_policy_gates");
    const [awarenessLoading, setAwarenessLoading] = useState(false);
    const [awarenessError, setAwarenessError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0] ?? null, [items, selectedId]);
    const loadKnowledge = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await agencyApi.compilerKnowledge.list({
                type: typeFilter || undefined,
                domain: domainFilter || undefined,
                risk: riskFilter || undefined,
                source: sourceFilter || undefined,
            });
            setItems(data.items);
            setPolicyMode(data.policy.mode);
            setSelectedId((current) => current && data.items.some((item) => item.id === current) ? current : data.items[0]?.id ?? null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load Compiler Knowledge");
        }
        finally {
            setLoading(false);
        }
    }, [typeFilter, domainFilter, riskFilter, sourceFilter]);
    useEffect(() => {
        void loadKnowledge();
    }, [loadKnowledge]);
    const loadPolicyGates = useCallback(async () => {
        try {
            const data = await agencyApi.compilerPolicyGates.list();
            setPolicyGates(data.items);
            setPolicyGateMode(data.policy.mode);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load Compiler Policy Gates");
        }
    }, []);
    useEffect(() => {
        void loadPolicyGates();
    }, [loadPolicyGates]);
    const loadAwareness = useCallback(async () => {
        setAwarenessLoading(true);
        setAwarenessError(null);
        try {
            const data = await agencyApi.compilerAwareness.get({ intent: awarenessIntent || undefined });
            setAwareness(data);
            const events = await agencyApi.compilerAwareness.listEvents({ pageSize: 6 });
            setAwarenessEvents(events.items);
        }
        catch (err) {
            setAwarenessError(err instanceof Error ? err.message : "Failed to load Compiler Awareness");
        }
        finally {
            setAwarenessLoading(false);
        }
    }, [awarenessIntent]);
    useEffect(() => {
        void loadAwareness();
    }, [loadAwareness]);
    const ruleCount = items.filter((item) => item.type === "rule").length;
    const negativeCount = items.filter((item) => item.type === "negative_example" || item.type === "anti_pattern").length;
    const compilerVisibleCount = items.filter((item) => item.policy.compilerVisible).length;
    const domains = new Set(items.map((item) => item.domain)).size;
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/compiler-knowledge", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Compiler Knowledge" }) }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "12px", marginBottom: "18px" }, children: [
                    ["Entries", items.length, "#4ade80"],
                    ["Rules", ruleCount, "#60a5fa"],
                    ["Negative learning", negativeCount, "#f87171"],
                    ["Compiler visible", compilerVisibleCount, "#a1a1aa"],
                ].map(([label, value, color]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "6px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 600 }, children: value })] }, label))) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx(Badge, { label: `mode: ${policyMode}`, tone: "blue" }), _jsx(Badge, { label: "compilerVisible: false", tone: "gray" }), _jsx(Badge, { label: "autoUseEnabled: false", tone: "gray" }), _jsx(Badge, { label: "executionChanging: false", tone: "gray" }), _jsx("span", { style: { color: "#777", fontSize: "12px" }, children: "Read-only guidance. Compiler execution remains unchanged." })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600 }, children: "Compiler Policy Gates" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "4px" }, children: "Read-only registry of explicit gates required before compiler auto-use can exist." })] }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }, children: [_jsx(Badge, { label: `mode: ${policyGateMode}`, tone: "blue" }), _jsx(Badge, { label: "safeToAutoApply: false", tone: "gray" })] })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(190px, 1fr))", gap: "10px" }, children: policyGates.map((gate) => (_jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "start", marginBottom: "8px" }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: gate.title }), _jsx("div", { style: { color: "#666", fontSize: "11px", marginTop: "3px" }, children: gate.id })] }), _jsx(Badge, { label: gate.state, tone: stateTone(gate.state) })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }, children: [_jsx(Badge, { label: gate.category, tone: "gray" }), _jsx(Badge, { label: gate.risk, tone: riskTone(gate.risk) }), _jsx(Badge, { label: gate.owner, tone: "blue" })] }), _jsxs("div", { style: { color: "#888", fontSize: "11px", lineHeight: 1.45 }, children: ["Blocks: ", listText(gate.blocks)] }), _jsxs("div", { style: { color: "#666", fontSize: "11px", lineHeight: 1.45, marginTop: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: ["Next: ", gate.remediation.nextActions[0] ?? "-"] })] }, gate.id))) })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600 }, children: "Compiler Awareness" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "4px" }, children: "Read-only candidate matching from Tool Catalog, Step Library, and Knowledge Base." })] }), _jsxs("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }, children: [_jsx("input", { value: awarenessIntent, onChange: (event) => setAwarenessIntent(event.target.value), placeholder: "Intent", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("button", { onClick: () => void loadAwareness(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Check" })] })] }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }, children: [_jsx(Badge, { label: "mode: read_only_compiler_awareness", tone: "blue" }), _jsx(Badge, { label: "wouldUse: false", tone: "gray" }), _jsx(Badge, { label: "autoUseEnabled: false", tone: "gray" }), _jsx(Badge, { label: "executionChanging: false", tone: "gray" })] }), awarenessError ? (_jsx("div", { style: { color: "#f87171", fontSize: "12px" }, children: awarenessError })) : awarenessLoading ? (_jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "Loading awareness..." })) : awareness ? (_jsxs("div", { style: { display: "grid", gap: "10px" }, children: [_jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: "10px" }, children: [
                                    ["Tool candidates", awareness.summary.toolCandidates, awareness.candidates.tools.map((item) => item.id).join(", ")],
                                    ["Step candidates", awareness.summary.stepCandidates, awareness.candidates.steps.map((item) => `${item.name ?? item.id} (${item.reason})`).join(", ")],
                                    ["Knowledge candidates", awareness.summary.knowledgeCandidates, awareness.candidates.knowledge.map((item) => item.id).join(", ")],
                                ].map(([label, value, detail]) => (_jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "20px", fontWeight: 600 }, children: value }), _jsx("div", { style: { color: "#888", fontSize: "11px", marginTop: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: detail || "-" })] }, label))) }), _jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px" }, children: [_jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" }, children: [_jsx(Badge, { label: `decision: ${awareness.decision.outcome ?? "unknown"}`, tone: "yellow" }), _jsx(Badge, { label: `wouldChangePlan: ${String(awareness.decision.wouldChangePlan ?? false)}`, tone: "gray" }), _jsx(Badge, { label: `wouldExecuteStepLibrary: ${String(awareness.decision.wouldExecuteStepLibrary ?? false)}`, tone: "gray" })] }), _jsxs("div", { style: { color: "#888", fontSize: "12px" }, children: ["Blockers: ", (awareness.decision.blockers ?? []).join(", ") || "-"] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", marginTop: "8px" }, children: ["Policy gates: ", decisionPolicyGates(awareness.decision)] }), _jsxs("div", { style: { color: "#888", fontSize: "12px", marginTop: "8px" }, children: ["Remediation: ", decisionRemediation(awareness.decision).slice(0, 2).join(" · ") || "-"] })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "10px" }, children: [
                                    ["Tool eligibility", awareness.candidates.tools.slice(0, 3)],
                                    ["Step eligibility", awareness.candidates.steps.slice(0, 3)],
                                    ["Knowledge eligibility", awareness.candidates.knowledge.slice(0, 3)],
                                ].map(([label, candidates]) => (_jsxs("div", { style: { background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "7px" }, children: label }), _jsxs("div", { style: { display: "grid", gap: "6px" }, children: [(candidates.length ? candidates : []).map((item) => (_jsxs("div", { style: { minWidth: 0 }, children: [_jsxs("div", { style: { color: "#aaa", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [item.name ?? item.id, ": ", eligibilityBlockers(item)] }), _jsx("div", { style: { color: "#666", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }, children: (remediationActions(item)[0] ?? "No remediation hint.") }), _jsxs("div", { style: { color: "#555", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }, children: ["Gates: ", eligibilityPolicyGates(item)] })] }, item.id))), candidates.length === 0 && _jsx("div", { style: { color: "#aaa", fontSize: "11px" }, children: "-" })] })] }, label))) })] })) : null] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600 }, children: "Awareness Audit" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "4px" }, children: "Append-only log of read-only awareness checks. These entries never change execution." })] }), _jsx(Badge, { label: "audit-only", tone: "gray" })] }), awarenessEvents.length === 0 ? (_jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No awareness checks logged yet." })) : (_jsx("div", { style: { display: "grid", gap: "8px" }, children: awarenessEvents.map((event) => (_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 0.8fr 0.8fr 0.8fr 0.9fr", gap: "10px", alignItems: "center", background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: event.intent || event.action || "awareness check" }), _jsx("div", { style: { color: "#666", fontSize: "11px", marginTop: "3px" }, children: event.createdAt ? new Date(event.createdAt).toLocaleString() : "-" })] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["tools: ", event.summary.toolCandidates ?? 0] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["steps: ", event.summary.stepCandidates ?? 0] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["knowledge: ", event.summary.knowledgeCandidates ?? 0] }), _jsx("div", { style: { color: "#aaa", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: event.decision.outcome ?? "no decision" })] }, event.id))) }))] }), _jsxs("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px", flexWrap: "wrap" }, children: [_jsxs("select", { value: typeFilter, onChange: (event) => setTypeFilter(event.target.value), style: selectStyle, children: [_jsx("option", { value: "", children: "All types" }), _jsx("option", { value: "rule", children: "Rule" }), _jsx("option", { value: "positive_example", children: "Positive example" }), _jsx("option", { value: "negative_example", children: "Negative example" }), _jsx("option", { value: "anti_pattern", children: "Anti-pattern" }), _jsx("option", { value: "app_map_hint", children: "App-map hint" }), _jsx("option", { value: "success_criteria", children: "Success criteria" }), _jsx("option", { value: "repair_note", children: "Repair note" })] }), _jsxs("select", { value: domainFilter, onChange: (event) => setDomainFilter(event.target.value), style: selectStyle, children: [_jsx("option", { value: "", children: "All domains" }), _jsx("option", { value: "workflow_lifecycle", children: "Workflow lifecycle" }), _jsx("option", { value: "step_library", children: "Step Library" }), _jsx("option", { value: "tool_selection", children: "Tool selection" }), _jsx("option", { value: "app_navigation", children: "App navigation" }), _jsx("option", { value: "safety", children: "Safety" }), _jsx("option", { value: "recovery", children: "Recovery" })] }), _jsxs("select", { value: riskFilter, onChange: (event) => setRiskFilter(event.target.value), style: selectStyle, children: [_jsx("option", { value: "", children: "All risks" }), _jsx("option", { value: "low", children: "Low" }), _jsx("option", { value: "medium", children: "Medium" }), _jsx("option", { value: "high", children: "High" })] }), _jsxs("select", { value: sourceFilter, onChange: (event) => setSourceFilter(event.target.value), style: selectStyle, children: [_jsx("option", { value: "", children: "All sources" }), _jsx("option", { value: "product_decision", children: "Product decision" }), _jsx("option", { value: "qa_guardrail", children: "QA guardrail" }), _jsx("option", { value: "live_incident", children: "Live incident" }), _jsx("option", { value: "implementation_rule", children: "Implementation rule" })] }), _jsx("button", { onClick: () => void loadKnowledge(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Refresh" })] }), error && _jsx("div", { style: { color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }, children: error }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "minmax(430px, 1.05fr) minmax(380px, 0.95fr)", gap: "16px", alignItems: "start" }, children: [_jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }, children: [_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 0.7fr 0.55fr 0.7fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }, children: [_jsx("div", { children: "Knowledge" }), _jsx("div", { children: "Domain" }), _jsx("div", { children: "Risk" }), _jsx("div", { children: "Source" })] }), loading ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "Loading..." })) : items.length === 0 ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "No entries match the filters." })) : (items.map((item) => (_jsxs("button", { onClick: () => setSelectedId(item.id), style: {
                                    width: "100%",
                                    display: "grid",
                                    gridTemplateColumns: "1fr 0.7fr 0.55fr 0.7fr",
                                    gap: "10px",
                                    alignItems: "center",
                                    padding: "12px",
                                    background: selected?.id === item.id ? "#151515" : "transparent",
                                    border: 0,
                                    borderBottom: "1px solid #1f1f1f",
                                    color: "#ddd",
                                    textAlign: "left",
                                    cursor: "pointer",
                                }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }, children: item.title }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "4px" }, children: [item.id, " \u00B7 ", item.type] })] }), _jsx("div", { style: { color: "#aaa", fontSize: "12px" }, children: item.domain }), _jsx("div", { children: _jsx(Badge, { label: item.risk, tone: riskTone(item.risk) }) }), _jsx("div", { children: _jsx(Badge, { label: item.source, tone: sourceTone(item.source) }) })] }, item.id))))] }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }, children: selected ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { color: "#fff", fontSize: "16px", margin: "0 0 6px" }, children: selected.title }), _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: selected.id })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }, children: [_jsx(Badge, { label: selected.type, tone: "blue" }), _jsx(Badge, { label: selected.risk, tone: riskTone(selected.risk) })] })] }), _jsx("div", { style: { color: "#bbb", fontSize: "13px", lineHeight: 1.5, marginBottom: "12px" }, children: selected.summary }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px", marginBottom: "12px" }, children: [
                                        ["Domain", selected.domain],
                                        ["Status", selected.status],
                                        ["Compiler visible", selected.policy.compilerVisible ? "yes" : "no"],
                                        ["Auto-use", selected.policy.autoUseEnabled ? "yes" : "no"],
                                        ["Execution changing", selected.policy.executionChanging ? "yes" : "no"],
                                        ["Domains loaded", String(domains)],
                                    ].map(([label, value]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "12px" }, children: value })] }, label))) }), _jsx(Panel, { title: "Guidance", values: selected.guidance }), _jsx(Panel, { title: "Applies to", values: selected.appliesTo, compact: true }), _jsx(Panel, { title: "Evidence required", values: selected.evidence.required, compact: true }), _jsx(Panel, { title: "Evidence examples", values: selected.evidence.examples, compact: true }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Notes" }), _jsx("div", { style: { color: "#aaa", fontSize: "12px", lineHeight: 1.6 }, children: listText(selected.notes) })] })] })) : (_jsx("div", { style: { color: "#777", textAlign: "center", padding: "28px" }, children: "Select an entry." })) })] })] }));
}
function Panel({ title, values, compact }) {
    return (_jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: title }), compact ? (_jsx("div", { style: { color: "#aaa", fontSize: "12px", lineHeight: 1.6 }, children: listText(values) })) : (_jsx("ul", { style: { margin: 0, paddingLeft: "18px", color: "#aaa", fontSize: "12px", lineHeight: 1.6 }, children: values.map((value) => _jsx("li", { children: value }, value)) }))] }));
}
const selectStyle = {
    background: "#111",
    border: "1px solid #333",
    color: "#ddd",
    borderRadius: "6px",
    padding: "8px 10px",
    minWidth: "160px",
};
