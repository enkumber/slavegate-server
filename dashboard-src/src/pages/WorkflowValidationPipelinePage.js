import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
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
function stateTone(state) {
    if (state === "passed")
        return "green";
    if (state === "blocked")
        return "red";
    if (state === "review_ready")
        return "yellow";
    return "gray";
}
function shortList(values, limit = 4) {
    if (!Array.isArray(values) || values.length === 0)
        return "-";
    return `${values.slice(0, limit).map(String).join(", ")}${values.length > limit ? " +" : ""}`;
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}
function numberValue(value) {
    return typeof value === "number" ? value : 0;
}
function SummaryCard({ label, value, color }) {
    return (_jsxs("div", { style: { background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "12px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "4px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 700 }, children: String(value ?? 0) })] }));
}
function PipelineItem({ item }) {
    const branchCoverage = objectValue(item.dryRun.branchCoverage);
    const fixtureMatrix = arrayValue(item.dryRun.fixtureMatrix);
    const smokeScore = numberValue(item.smokeReadiness.score);
    const canaryScore = numberValue(item.canaryReadiness.score);
    const regressionScore = numberValue(item.regressionReadiness.score);
    return (_jsxs("div", { style: { background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsxs("div", { style: { display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: item.definition.title }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "3px" }, children: [item.definition.key, "@v", item.definition.version] })] }), _jsx(Badge, { label: String(item.decision.outcome ?? "unknown"), tone: "red" })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: item.definition.platform, tone: "blue" }), _jsx(Badge, { label: item.definition.intent, tone: "gray" }), _jsx(Badge, { label: `static: ${String(item.staticValidation.state ?? "unknown")}`, tone: stateTone(item.staticValidation.state) }), _jsx(Badge, { label: `score: ${String(item.decision.validationScore ?? 0)}`, tone: "yellow" }), _jsx(Badge, { label: "dry-run only", tone: "yellow" })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(5, minmax(90px, 1fr))", gap: "8px", marginBottom: "10px" }, children: [
                    ["Errors", item.staticValidation.errors ?? 0],
                    ["Warnings", item.staticValidation.warnings ?? 0],
                    ["Coverage", `${String(branchCoverage.coveragePercent ?? 0)}%`],
                    ["Fixtures", fixtureMatrix.length],
                    ["Safe", String(item.decision.safeToAutoApply ?? false)],
                ].map(([label, value]) => (_jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "10px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }, children: String(value) })] }, String(label)))) }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(90px, 1fr))", gap: "8px", marginBottom: "10px" }, children: [
                    ["Smoke", item.smokeReadiness.state ?? "blocked", smokeScore],
                    ["Canary", item.canaryReadiness.state ?? "blocked", canaryScore],
                    ["Regression", item.regressionReadiness.state ?? "blocked", regressionScore],
                ].map(([label, state, score]) => (_jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }, children: [_jsx("div", { style: { color: "#666", fontSize: "10px" }, children: label }), _jsx(Badge, { label: `${score}%`, tone: "gray" })] }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }, children: String(state) })] }, String(label)))) }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Blockers: ", shortList(item.decision.blockers)] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Dry-run: wouldUseDefinition=", String(item.dryRun.wouldUseDefinition), "; wouldExecuteWorkflow=", String(item.dryRun.wouldExecuteWorkflow)] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Fixtures: ", shortList(fixtureMatrix.map((fixture) => objectValue(fixture).id))] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Missing branches: ", shortList(branchCoverage.missingBranches)] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Criteria: ", shortList(item.definition.successCriteria)] })] }));
}
function EventRow({ event }) {
    const decision = event.decision ?? {};
    const summary = event.summary ?? {};
    return (_jsxs("div", { style: { background: "#0b0b0b", border: "1px solid #202020", borderRadius: "6px", padding: "10px", display: "grid", gridTemplateColumns: "180px 1fr 160px", gap: "10px", alignItems: "center" }, children: [_jsx("div", { style: { color: "#888", fontSize: "11px" }, children: event.createdAt ? new Date(event.createdAt).toLocaleString() : "-" }), _jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: event.definitionKey ?? event.intent ?? "-" }), _jsxs("div", { style: { color: "#666", fontSize: "11px" }, children: [event.platform ?? "-", " \u00B7 ", event.source ?? "-", " \u00B7 score ", String(summary.averageValidationScore ?? "-")] })] }), _jsx("div", { style: { display: "flex", justifyContent: "flex-end" }, children: _jsx(Badge, { label: String(decision.outcome ?? "recorded"), tone: "gray" }) })] }));
}
export function WorkflowValidationPipelinePage() {
    const [intent, setIntent] = useState("reddit_account_health_scan");
    const [platform, setPlatform] = useState("reddit");
    const [key, setKey] = useState("");
    const [pipeline, setPipeline] = useState(null);
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = {
                intent: intent || undefined,
                platform: platform || undefined,
                key: key || undefined,
            };
            const [pipelineResponse, eventResponse] = await Promise.all([
                agencyApi.workflowValidationPipeline.get(params),
                agencyApi.workflowValidationPipeline.listEvents({ ...params, pageSize: 8 }),
            ]);
            setPipeline(pipelineResponse);
            setEvents(eventResponse.items);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load validation pipeline");
        }
        finally {
            setLoading(false);
        }
    }, [intent, key, platform]);
    useEffect(() => {
        void load();
    }, [load]);
    const summary = pipeline?.summary ?? {};
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/workflow-validation-pipeline", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Validation Pipeline" }) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx(Badge, { label: "readOnly: true", tone: "blue" }), _jsx(Badge, { label: "validationOnly: true", tone: "gray" }), _jsx(Badge, { label: "autoPromotionEnabled: false", tone: "gray" }), _jsx(Badge, { label: "wouldExecuteWorkflow: false", tone: "gray" }), _jsx(Badge, { label: "workflowCacheChanging: false", tone: "gray" })] }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx("input", { value: intent, onChange: (event) => setIntent(event.target.value), placeholder: "Intent", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "240px" } }), _jsx("input", { value: platform, onChange: (event) => setPlatform(event.target.value), placeholder: "Platform", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "150px" } }), _jsx("input", { value: key, onChange: (event) => setKey(event.target.value), placeholder: "Definition key", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("button", { onClick: () => void load(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Run validation preview" }), loading && _jsx("span", { style: { color: "#777", fontSize: "12px" }, children: "Loading..." }), error && _jsx("span", { style: { color: "#f87171", fontSize: "12px" }, children: error })] }) }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }, children: [_jsx(SummaryCard, { label: "Definitions", value: summary.definitions, color: "#e5e7eb" }), _jsx(SummaryCard, { label: "Static Passed", value: summary.staticPassed, color: "#4ade80" }), _jsx(SummaryCard, { label: "Branch Coverage", value: `${String(summary.branchCoveragePercent ?? 0)}%`, color: "#60a5fa" }), _jsx(SummaryCard, { label: "Validation Score", value: summary.averageValidationScore, color: "#fbbf24" }), _jsx(SummaryCard, { label: "Safe Auto Apply", value: summary.safeToAutoApply, color: "#f87171" })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }, children: [_jsx(SummaryCard, { label: "Static Warnings", value: summary.staticWarnings, color: "#fbbf24" }), _jsx(SummaryCard, { label: "Dry-run Fixtures", value: summary.dryRunFixtures, color: "#60a5fa" }), _jsx(SummaryCard, { label: "Readiness Blocked", value: summary.readinessBlocked, color: "#f87171" }), _jsx(SummaryCard, { label: "Would Promote", value: summary.wouldPromoteDefinition, color: "#f87171" })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "12px", marginBottom: "18px" }, children: [(pipeline?.items ?? []).map((item) => _jsx(PipelineItem, { item: item }, item.definition.id)), pipeline && pipeline.items.length === 0 && _jsx("div", { style: { color: "#777", fontSize: "13px" }, children: "No matching definitions." })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "14px", fontWeight: 600, marginBottom: "10px" }, children: "Validation Events" }), _jsxs("div", { style: { display: "grid", gap: "8px" }, children: [events.map((event) => _jsx(EventRow, { event: event }, event.id)), events.length === 0 && _jsx("div", { style: { color: "#777", fontSize: "13px" }, children: "No validation events yet." })] })] })] }));
}
