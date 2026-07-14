import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * ToolCatalogPage.tsx
 * Read-only registry of runtime capabilities available to workflow planning.
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
function listText(values) {
    return values.length ? values.join(", ") : "-";
}
export function ToolCatalogPage() {
    const [items, setItems] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [categoryFilter, setCategoryFilter] = useState("");
    const [riskFilter, setRiskFilter] = useState("");
    const [sourceFilter, setSourceFilter] = useState("");
    const [policyMode, setPolicyMode] = useState("read_only_catalog");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0] ?? null, [items, selectedId]);
    const loadCatalog = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await agencyApi.toolCatalog.list({
                category: categoryFilter || undefined,
                risk: riskFilter || undefined,
                source: sourceFilter || undefined,
            });
            setItems(data.items);
            setPolicyMode(data.policy.mode);
            setSelectedId((current) => current && data.items.some((item) => item.id === current) ? current : data.items[0]?.id ?? null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load Tool Catalog");
        }
        finally {
            setLoading(false);
        }
    }, [categoryFilter, riskFilter, sourceFilter]);
    useEffect(() => {
        void loadCatalog();
    }, [loadCatalog]);
    const categoryCount = new Set(items.map((item) => item.category)).size;
    const deviceCount = items.filter((item) => item.requiresDevice).length;
    const highRiskCount = items.filter((item) => item.risk === "high").length;
    const compilerVisibleCount = items.filter((item) => item.policy.compilerVisible).length;
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/tool-catalog", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Tool Catalog" }) }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "12px", marginBottom: "18px" }, children: [
                    ["Tools", items.length, "#4ade80"],
                    ["Categories", categoryCount, "#60a5fa"],
                    ["Device tools", deviceCount, "#fbbf24"],
                    ["Compiler visible", compilerVisibleCount, "#a1a1aa"],
                ].map(([label, value, color]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "6px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 600 }, children: value })] }, label))) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx(Badge, { label: `mode: ${policyMode}`, tone: "blue" }), _jsx(Badge, { label: "compilerVisible: false", tone: "gray" }), _jsx(Badge, { label: "autoUseEnabled: false", tone: "gray" }), _jsx("span", { style: { color: "#777", fontSize: "12px" }, children: "Catalogul este doar inventar declarativ \u00EEn faza asta." })] }), _jsxs("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px", flexWrap: "wrap" }, children: [_jsxs("select", { value: categoryFilter, onChange: (event) => setCategoryFilter(event.target.value), style: { background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "180px" }, children: [_jsx("option", { value: "", children: "All categories" }), _jsx("option", { value: "device_control", children: "Device control" }), _jsx("option", { value: "navigation", children: "Navigation" }), _jsx("option", { value: "input", children: "Input" }), _jsx("option", { value: "observation", children: "Observation" }), _jsx("option", { value: "workflow", children: "Workflow" }), _jsx("option", { value: "content", children: "Content" })] }), _jsxs("select", { value: riskFilter, onChange: (event) => setRiskFilter(event.target.value), style: { background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "140px" }, children: [_jsx("option", { value: "", children: "All risks" }), _jsx("option", { value: "low", children: "Low" }), _jsx("option", { value: "medium", children: "Medium" }), _jsx("option", { value: "high", children: "High" })] }), _jsxs("select", { value: sourceFilter, onChange: (event) => setSourceFilter(event.target.value), style: { background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "170px" }, children: [_jsx("option", { value: "", children: "All sources" }), _jsx("option", { value: "device_job", children: "Device job" }), _jsx("option", { value: "workflow_runtime", children: "Workflow runtime" }), _jsx("option", { value: "server_skill", children: "Server skill" })] }), _jsx("button", { onClick: () => void loadCatalog(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Refresh" })] }), error && _jsx("div", { style: { color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }, children: error }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "minmax(420px, 1.05fr) minmax(360px, 0.95fr)", gap: "16px", alignItems: "start" }, children: [_jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }, children: [_jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 0.75fr 0.55fr 0.75fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }, children: [_jsx("div", { children: "Tool" }), _jsx("div", { children: "Source" }), _jsx("div", { children: "Risk" }), _jsx("div", { children: "Policy" })] }), loading ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "Loading..." })) : items.length === 0 ? (_jsx("div", { style: { padding: "32px", color: "#777", textAlign: "center" }, children: "No tools match the filters." })) : (items.map((item) => (_jsxs("button", { onClick: () => setSelectedId(item.id), style: {
                                    width: "100%",
                                    display: "grid",
                                    gridTemplateColumns: "1fr 0.75fr 0.55fr 0.75fr",
                                    gap: "10px",
                                    alignItems: "center",
                                    padding: "12px",
                                    background: selected?.id === item.id ? "#151515" : "transparent",
                                    border: 0,
                                    borderBottom: "1px solid #1f1f1f",
                                    color: "#ddd",
                                    textAlign: "left",
                                    cursor: "pointer",
                                }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }, children: item.name }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "4px" }, children: [item.id, " \u00B7 ", item.category] })] }), _jsx("div", { style: { color: "#aaa", fontSize: "12px" }, children: item.source }), _jsx("div", { children: _jsx(Badge, { label: item.risk, tone: riskTone(item.risk) }) }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [_jsx(Badge, { label: item.policy.readOnly ? "read" : "write", tone: item.policy.readOnly ? "green" : "yellow" }), item.policy.externalAction && _jsx(Badge, { label: "external", tone: "red" })] })] }, item.id))))] }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }, children: selected ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }, children: [_jsxs("div", { children: [_jsx("h2", { style: { color: "#fff", fontSize: "16px", margin: "0 0 6px" }, children: selected.name }), _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: selected.id })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }, children: [_jsx(Badge, { label: selected.source, tone: "blue" }), _jsx(Badge, { label: selected.risk, tone: riskTone(selected.risk) })] })] }), _jsx("div", { style: { color: "#bbb", fontSize: "13px", lineHeight: 1.5, marginBottom: "12px" }, children: selected.description }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px", marginBottom: "12px" }, children: [
                                        ["Requires device", selected.requiresDevice ? "yes" : "no"],
                                        ["DirectWS", selected.availability.directWs ? "yes" : "no"],
                                        ["Edge workflow", selected.availability.edgeWorkflow ? "yes" : "no"],
                                        ["Server runtime", selected.availability.serverRuntime ? "yes" : "no"],
                                        ["Compiler visible", selected.policy.compilerVisible ? "yes" : "no"],
                                        ["Auto-use", selected.policy.autoUseEnabled ? "yes" : "no"],
                                    ].map(([label, value]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "12px" }, children: value })] }, label))) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Policy" }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [_jsx(Badge, { label: selected.policy.readOnly ? "read-only" : "mutating", tone: selected.policy.readOnly ? "green" : "yellow" }), selected.policy.destructive && _jsx(Badge, { label: "destructive", tone: "red" }), selected.policy.externalAction && _jsx(Badge, { label: "external action", tone: "red" }), _jsx(Badge, { label: "compiler hidden", tone: "gray" }), _jsx(Badge, { label: "auto-use disabled", tone: "gray" })] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Schema" }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "6px" }, children: ["Required: ", listText(selected.inputSchema.required)] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", marginBottom: "6px" }, children: ["Optional: ", listText(selected.inputSchema.optional)] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px" }, children: ["Produces: ", listText(selected.outputSchema.produces)] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", padding: "12px", background: "#101010" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Notes" }), _jsx("ul", { style: { margin: 0, paddingLeft: "18px", color: "#aaa", fontSize: "12px", lineHeight: 1.6 }, children: selected.notes.map((note) => _jsx("li", { children: note }, note)) }), _jsxs("div", { style: { color: "#777", fontSize: "12px", marginTop: "10px" }, children: ["Side effects: ", listText(selected.sideEffects)] })] })] })) : (_jsx("div", { style: { color: "#777", textAlign: "center", padding: "28px" }, children: "Select a tool." })) })] })] }));
}
