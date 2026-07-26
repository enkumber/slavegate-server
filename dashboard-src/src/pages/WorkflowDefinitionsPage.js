import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, } from "../api/agency";
import { statusTone as genericStatusTone } from "../utils/statusPresentation";
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
function statusTone(definition) {
    if (definition.statusCapabilities.terminal) {
        return definition.statusCapabilities.retryable ? "red" : "gray";
    }
    if (definition.statusCapabilities.dispatchable)
        return "green";
    const tone = genericStatusTone(definition.status);
    return tone === "blue" ? "gray" : tone;
}
function shortList(values, limit = 3) {
    if (!values.length)
        return "-";
    return `${values.slice(0, limit).map(String).join(", ")}${values.length > limit ? " +" : ""}`;
}
function numberValue(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function promotionReadinessLabel(definition) {
    return typeof definition.promotion?.readiness?.state === "string"
        ? definition.promotion.readiness.state
        : "not_evaluated";
}
function DefinitionCard({ definition }) {
    const readiness = promotionReadinessLabel(definition);
    const branchCoverage = numberValue(definition.promotion?.readiness?.branchCoveragePercent);
    const validationScore = numberValue(definition.promotion?.readiness?.validationScore);
    return (_jsxs("div", { style: { background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "14px", minWidth: 0 }, children: [_jsxs("div", { style: { display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }, children: [_jsxs("div", { style: { minWidth: 0 }, children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: definition.title }), _jsxs("div", { style: { color: "#666", fontSize: "11px", marginTop: "3px" }, children: [definition.key, "@v", definition.version] })] }), _jsx(Badge, { label: definition.status, tone: statusTone(definition) })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: definition.platform, tone: "blue" }), _jsx(Badge, { label: definition.intent, tone: "gray" }), _jsx(Badge, { label: definition.source, tone: "gray" }), _jsx(Badge, { label: `promotion: ${definition.promotion?.state ?? "-"}`, tone: definition.promotion?.stateCapabilities?.terminal ? "red" : definition.promotion?.reusable ? "green" : "gray" }), _jsx(Badge, { label: `confidence: ${Math.round(numberValue(definition.promotion?.confidence) * 100)}%`, tone: "blue" })] }), _jsx("div", { style: { color: "#aaa", fontSize: "12px", lineHeight: 1.55, marginBottom: "10px" }, children: definition.goal }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(5, minmax(70px, 1fr))", gap: "6px", marginBottom: "10px" }, children: [
                    ["criteria", definition.summary.successCriteria],
                    ["tools", definition.summary.allowedTools],
                    ["caps", definition.summary.requiredCapabilities],
                    ["constraints", definition.summary.constraints],
                    ["fallback", definition.summary.fallbackRules],
                ].map(([label, value]) => (_jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "10px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "14px", fontWeight: 600 }, children: String(value) })] }, String(label)))) }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Tools: ", shortList(definition.allowedTools)] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Capabilities: ", shortList(definition.requiredCapabilities)] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Rollback: ", String(definition.rollback?.strategy ?? definition.rollback?.reason ?? "-")] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Promotion scope: ", definition.promotion?.scope ?? "-"] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", lineHeight: 1.5 }, children: ["Readiness: ", readiness, " \u00B7 score ", validationScore, " \u00B7 branches ", branchCoverage, "%"] })] }));
}
export function WorkflowDefinitionsPage() {
    const [definitions, setDefinitions] = useState([]);
    const [summary, setSummary] = useState({});
    const [status, setStatus] = useState("");
    const [platform, setPlatform] = useState("");
    const [intent, setIntent] = useState("reddit_account_health_scan");
    const [resolvePlatform, setResolvePlatform] = useState("reddit");
    const [resolveScope, setResolveScope] = useState("device:test-device");
    const [resolution, setResolution] = useState(null);
    const [selected, setSelected] = useState(null);
    const [promotionScope, setPromotionScope] = useState("definition:limited-review");
    const [promotionNote, setPromotionNote] = useState("");
    const [rollbackTargetId, setRollbackTargetId] = useState("");
    const [promotionBusy, setPromotionBusy] = useState(false);
    const [promotionEvents, setPromotionEvents] = useState([]);
    const [versionEvents, setVersionEvents] = useState([]);
    const [versions, setVersions] = useState([]);
    const [impactPreview, setImpactPreview] = useState(null);
    const [hardeningPreview, setHardeningPreview] = useState(null);
    const [rollbackPreview, setRollbackPreview] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.list({
                status: status || undefined,
                platform: platform || undefined,
            });
            setDefinitions(response.items);
            setSummary(response.summary);
            setSelected((current) => {
                if (!current)
                    return response.items[0] ?? null;
                return response.items.find((item) => item.id === current.id) ?? response.items[0] ?? null;
            });
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load workflow definitions");
        }
        finally {
            setLoading(false);
        }
    }, [platform, status]);
    const resolve = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.resolve({
                intent: intent || undefined,
                platform: resolvePlatform || undefined,
                scope: resolveScope || undefined,
            });
            setResolution(response);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to resolve workflow definition");
        }
        finally {
            setLoading(false);
        }
    }, [intent, resolvePlatform, resolveScope]);
    const loadPromotionEvents = useCallback(async (definitionId) => {
        if (!definitionId) {
            setPromotionEvents([]);
            return;
        }
        const response = await agencyApi.workflowDefinitions.listPromotionEvents({ definitionId, pageSize: 10 });
        setPromotionEvents(response.items);
    }, []);
    const loadRollbackPreview = useCallback(async (definitionId) => {
        if (!definitionId) {
            setRollbackPreview(null);
            return;
        }
        const response = await agencyApi.workflowDefinitions.rollbackPreview(definitionId);
        setRollbackPreview(response);
    }, []);
    const loadVersioning = useCallback(async (definition) => {
        if (!definition) {
            setVersions([]);
            setVersionEvents([]);
            setImpactPreview(null);
            setHardeningPreview(null);
            return;
        }
        const [versionPage, eventPage, impact, hardening] = await Promise.all([
            agencyApi.workflowDefinitions.versions(definition.id),
            agencyApi.workflowDefinitions.listVersionEvents({ definitionId: definition.id, pageSize: 10 }),
            agencyApi.workflowDefinitions.impactPreview(definition.id),
            agencyApi.workflowDefinitions.hardening(definition.id, promotionScope || undefined),
        ]);
        setVersions(versionPage.items);
        setVersionEvents(eventPage.items);
        setImpactPreview(impact);
        setHardeningPreview(hardening);
    }, [promotionScope]);
    const applyPromotionTransition = useCallback(async (actionKey, requiresScope) => {
        if (!selected)
            return;
        setPromotionBusy(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.promote(selected.id, {
                action: actionKey,
                scope: requiresScope ? promotionScope : null,
                note: promotionNote || null,
            });
            setSelected(response.definition);
            await load();
            await loadPromotionEvents(selected.id);
            await loadRollbackPreview(selected.id);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to apply workflow definition promotion transition");
        }
        finally {
            setPromotionBusy(false);
        }
    }, [load, loadPromotionEvents, loadRollbackPreview, promotionNote, promotionScope, selected]);
    const rollbackSelected = useCallback(async () => {
        if (!selected)
            return;
        setPromotionBusy(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.rollback(selected.id, {
                targetDefinitionId: rollbackTargetId || null,
                note: promotionNote || null,
            });
            setSelected(response.targetDefinition);
            await load();
            await loadPromotionEvents(selected.id);
            await loadRollbackPreview(selected.id);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to roll back workflow definition");
        }
        finally {
            setPromotionBusy(false);
        }
    }, [load, loadPromotionEvents, loadRollbackPreview, promotionNote, rollbackTargetId, selected]);
    const createVersionSelected = useCallback(async () => {
        if (!selected)
            return;
        setPromotionBusy(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.createVersion(selected.id, {
                title: `${selected.title} v${selected.version + 1}`,
                note: promotionNote || "Manual dashboard version",
            });
            setSelected(response.definition);
            await load();
            await loadVersioning(response.definition);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create workflow definition version");
        }
        finally {
            setPromotionBusy(false);
        }
    }, [load, loadVersioning, promotionNote, selected]);
    const lifecycleSelected = useCallback(async (action) => {
        if (!selected)
            return;
        setPromotionBusy(true);
        setError(null);
        try {
            const response = await agencyApi.workflowDefinitions.lifecycle(selected.id, {
                action,
                note: promotionNote || null,
            });
            setSelected(response.definition);
            await load();
            await loadVersioning(response.definition);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update workflow definition lifecycle");
        }
        finally {
            setPromotionBusy(false);
        }
    }, [load, loadVersioning, promotionNote, selected]);
    useEffect(() => {
        void load();
    }, [load]);
    useEffect(() => {
        void resolve();
    }, [resolve]);
    useEffect(() => {
        void loadPromotionEvents(selected?.id);
        void loadRollbackPreview(selected?.id);
        void loadVersioning(selected);
        setRollbackTargetId("");
    }, [loadPromotionEvents, loadRollbackPreview, loadVersioning, selected]);
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/workflow-definitions", children: [_jsx("div", { style: { marginBottom: "20px" }, children: _jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "Workflow Definitions" }) }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsx(Badge, { label: "readOnly: true", tone: "blue" }), _jsx(Badge, { label: "compilerVisible: false", tone: "gray" }), _jsx(Badge, { label: "autoUseEnabled: false", tone: "gray" }), _jsx(Badge, { label: "executionChanging: false", tone: "gray" }), _jsx(Badge, { label: "workflowCacheChanging: false", tone: "gray" }), _jsx(Badge, { label: "controlledPromotion: manual", tone: "blue" })] }), _jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }, children: [
                    ["Active", summary.active ?? 0, "#4ade80"],
                    ["Draft", summary.draft ?? 0, "#fbbf24"],
                    ["Deprecated", summary.deprecated ?? 0, "#f87171"],
                    ["Archived", summary.archived ?? 0, "#a1a1aa"],
                ].map(([label, value, color]) => (_jsxs("div", { style: { background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "6px" }, children: label }), _jsx("div", { style: { color, fontSize: "22px", fontWeight: 600 }, children: value })] }, label))) }), _jsx("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsxs("select", { value: status, onChange: (event) => setStatus(event.target.value), style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px" }, children: [_jsx("option", { value: "", children: "All statuses" }), _jsx("option", { value: "active", children: "Active" }), _jsx("option", { value: "draft", children: "Draft" }), _jsx("option", { value: "deprecated", children: "Deprecated" }), _jsx("option", { value: "archived", children: "Archived" })] }), _jsx("input", { value: platform, onChange: (event) => setPlatform(event.target.value), placeholder: "Platform filter", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "180px" } }), _jsx("button", { onClick: () => void load(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Refresh definitions" }), loading && _jsx("span", { style: { color: "#777", fontSize: "12px" }, children: "Loading..." }), error && _jsx("span", { style: { color: "#f87171", fontSize: "12px" }, children: error })] }) }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }, children: "Read-Only Resolution Preview" }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }, children: [_jsx("input", { value: intent, onChange: (event) => setIntent(event.target.value), placeholder: "Intent", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" } }), _jsx("input", { value: resolvePlatform, onChange: (event) => setResolvePlatform(event.target.value), placeholder: "Platform", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "160px" } }), _jsx("input", { value: resolveScope, onChange: (event) => setResolveScope(event.target.value), placeholder: "Scope", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "190px" } }), _jsx("button", { onClick: () => void resolve(), style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }, children: "Resolve dry-run" })] }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: `outcome: ${resolution?.outcome ?? "-"}`, tone: resolution?.candidateDefinition ? "red" : "yellow" }), _jsx(Badge, { label: `wouldUseDefinition: ${String(resolution?.wouldUseDefinition ?? false)}`, tone: resolution?.wouldUseDefinition ? "yellow" : "gray" }), _jsx(Badge, { label: `wouldChangePlan: ${String(resolution?.wouldChangePlan ?? false)}`, tone: resolution?.wouldChangePlan ? "yellow" : "gray" }), _jsx(Badge, { label: "wouldChangeWorkflowCache: false", tone: "gray" }), _jsx(Badge, { label: "wouldExecuteWorkflow: false", tone: "gray" })] }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "13px", marginBottom: "6px" }, children: ["Candidate: ", resolution?.candidateDefinition ? `${resolution.candidateDefinition.key}@v${resolution.candidateDefinition.version}` : "-"] }), _jsxs("div", { style: { color: "#777", fontSize: "12px", lineHeight: 1.6 }, children: ["Blockers: ", shortList(resolution?.blockers ?? [], 6)] })] }), _jsxs("section", { style: { border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "10px" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "15px", fontWeight: 600 }, children: "Controlled Promotion" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "3px" }, children: "Manual, scope-bound promotion metadata only. Compiler auto-use remains disabled." })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [_jsx(Badge, { label: "wouldUseDefinition: false", tone: "gray" }), _jsx(Badge, { label: "wouldExecuteWorkflow: false", tone: "gray" }), _jsx(Badge, { label: "safeToAutoApply: false", tone: "gray" })] })] }), selected ? (_jsxs(_Fragment, { children: [_jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "8px", marginBottom: "12px" }, children: [
                                    ["Selected", `${selected.key}@v${selected.version}`],
                                    ["State", selected.promotion?.state ?? "review_only"],
                                    ["Scope", selected.promotion?.scope ?? "-"],
                                    ["Confidence", `${Math.round(numberValue(selected.promotion?.confidence) * 100)}%`],
                                    ["Readiness", promotionReadinessLabel(selected)],
                                    ["Validation score", String(numberValue(selected.promotion?.readiness?.validationScore))],
                                    ["Branch coverage", `${numberValue(selected.promotion?.readiness?.branchCoveragePercent)}%`],
                                    ["Compiler eligible", String(selected.promotion?.compilerEligible ?? false)],
                                ].map(([label, value]) => (_jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px", minWidth: 0 }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: label }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: value })] }, label))) }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }, children: [_jsx("input", { value: promotionScope, onChange: (event) => setPromotionScope(event.target.value), placeholder: "scope, e.g. definition:...", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" } }), _jsx("input", { value: promotionNote, onChange: (event) => setPromotionNote(event.target.value), placeholder: "review note", style: { background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" } }), selected.promotion.transitions.map((transition) => (_jsx("button", { onClick: () => void applyPromotionTransition(transition.actionKey, transition.target.dispatchable && !transition.target.terminal), disabled: promotionBusy, style: { background: transition.target.terminal ? "#3a1618" : "#166534", border: `1px solid ${transition.target.terminal ? "#7f1d1d" : "#15803d"}`, color: transition.target.terminal ? "#fecaca" : "#dcfce7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }, children: transition.description || transition.toStatus }, transition.actionKey)))] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "8px", marginBottom: "12px" }, children: [_jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Scope Details" }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: [String(selected.promotion?.scopeDetails?.scopeType ?? "-"), " \u00B7 global allowed: ", String(selected.promotion?.scopeDetails?.globalScopeAllowed ?? false)] })] }), _jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Rollback Preview" }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: [rollbackPreview?.available ? "target available" : "no previous version", " \u00B7 wouldRollbackNow: ", String(rollbackPreview?.wouldRollbackNow ?? false)] })] }), _jsxs("div", { style: { background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Promotion Mode" }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: ["manual only \u00B7 auto-use ", String(selected.promotion?.autoUseEnabled ?? false)] })] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#0a0a0a", padding: "10px", marginBottom: "12px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "8px" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }, children: "Manual Rollback" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "3px" }, children: "Switch limited reuse metadata to an older definition version. No compiler, cache, or execution path changes." })] }), _jsx(Badge, { label: "rollback: manual/audited", tone: "blue" })] }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }, children: [_jsxs("select", { value: rollbackTargetId, onChange: (event) => setRollbackTargetId(event.target.value), style: { background: "#050505", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" }, children: [_jsxs("option", { value: "", children: ["Preview target: ", rollbackPreview?.selectedTarget ? `${String(rollbackPreview.selectedTarget.key)}@v${String(rollbackPreview.selectedTarget.version)}` : "none"] }), (rollbackPreview?.candidateTargets ?? []).map((target) => (_jsxs("option", { value: String(target.id), children: [String(target.key), "@v", String(target.version), " \u00B7 ", String(target.status), " \u00B7 ", String(target.promotionState)] }, String(target.id))))] }), _jsx("button", { onClick: () => void rollbackSelected(), disabled: promotionBusy || !rollbackPreview?.available, style: { background: rollbackPreview?.available ? "#1f2937" : "#1f1f1f", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || !rollbackPreview?.available ? "not-allowed" : "pointer" }, children: "Rollback manual" }), _jsx(Badge, { label: `wouldChangeWorkflowCache: ${String(rollbackPreview?.wouldChangeWorkflowCache ?? false)}`, tone: "gray" }), _jsx(Badge, { label: `wouldExecuteWorkflow: ${String(rollbackPreview?.wouldExecuteWorkflow ?? false)}`, tone: "gray" })] })] }), _jsxs("div", { style: { border: "1px solid #222", borderRadius: "6px", background: "#0a0a0a", padding: "10px", marginBottom: "12px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "8px" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }, children: "Versioning & Lifecycle" }), _jsx("div", { style: { color: "#777", fontSize: "12px", marginTop: "3px" }, children: "Create drafts, archive or deprecate definitions, and preview impact without touching execution." })] }), _jsxs("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [_jsx(Badge, { label: `versions: ${versions.length}`, tone: "blue" }), _jsx(Badge, { label: "workflowCacheChanging: false", tone: "gray" }), _jsx(Badge, { label: "wouldExecuteWorkflow: false", tone: "gray" })] })] }), _jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }, children: [_jsx("button", { onClick: () => void createVersionSelected(), disabled: promotionBusy, style: { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }, children: "Create draft version" }), selected.statusTransitions.map((transition) => (_jsx("button", { onClick: () => void lifecycleSelected(transition.actionKey), disabled: promotionBusy, style: { background: transition.target.terminal ? "#3a1618" : "#1f2937", border: `1px solid ${transition.target.terminal ? "#7f1d1d" : "#374151"}`, color: transition.target.terminal ? "#fecaca" : "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }, children: transition.description || transition.toStatus }, transition.actionKey)))] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: "8px", marginBottom: "10px" }, children: [_jsxs("div", { style: { background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Impact Preview" }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: ["versions ", String(impactPreview?.versionCount ?? versions.length), " \u00B7 promotions ", Array.isArray(impactPreview?.promotionEvents) ? impactPreview.promotionEvents.length : 0] })] }), _jsxs("div", { style: { background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Hardening" }), _jsxs("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: ["recommendation: ", String(hardeningPreview?.recommendation ?? "-")] })] }), _jsxs("div", { style: { background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }, children: [_jsx("div", { style: { color: "#777", fontSize: "11px", marginBottom: "5px" }, children: "Hardening Blockers" }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }, children: shortList(Array.isArray(hardeningPreview?.blockers) ? hardeningPreview.blockers : [], 4) })] })] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(180px, 1fr))", gap: "8px" }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }, children: "Versions" }), _jsx("div", { style: { display: "grid", gap: "6px" }, children: versions.slice(0, 5).map((version) => (_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }, children: [_jsxs("span", { style: { color: "#ddd", fontSize: "12px" }, children: [version.key, "@v", version.version] }), _jsx(Badge, { label: version.status, tone: statusTone(version) })] }, version.id))) })] }), _jsxs("div", { children: [_jsx("div", { style: { color: "#e5e7eb", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }, children: "Version Audit" }), _jsxs("div", { style: { display: "grid", gap: "6px" }, children: [versionEvents.slice(0, 5).map((event) => (_jsxs("div", { style: { background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }, children: [_jsxs("div", { style: { color: "#ddd", fontSize: "12px" }, children: [event.action, " \u00B7 v", event.definitionVersion ?? "-"] }), _jsxs("div", { style: { color: "#777", fontSize: "11px", marginTop: "3px" }, children: [event.previousStatus ?? "-", " \u2192 ", event.nextStatus ?? "-", " \u00B7 ", event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"] })] }, event.id))), !versionEvents.length && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No version events yet." })] })] })] })] }), _jsx("div", { style: { color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }, children: "Promotion Audit" }), _jsxs("div", { style: { display: "grid", gap: "8px" }, children: [promotionEvents.map((event) => (_jsxs("div", { style: { border: "1px solid #242424", borderRadius: "6px", padding: "10px", background: "#0d0d0d" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "5px" }, children: [_jsx(Badge, { label: event.action, tone: "gray" }), _jsx("span", { style: { color: "#777", fontSize: "11px" }, children: event.createdAt ? new Date(event.createdAt).toLocaleString() : "-" })] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }, children: ["State: ", event.previousState ?? "-", " \u2192 ", event.nextState ?? "-"] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }, children: ["Actor: ", event.actor ?? "-", " \u00B7 Scope: ", event.promotionScope ?? "-"] }), _jsxs("div", { style: { color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }, children: ["Confidence: ", Math.round(numberValue(event.promotionConfidence) * 100), "% \u00B7 Readiness: ", String(event.promotionReadiness?.state ?? "-")] }), _jsxs("div", { style: { color: "#777", fontSize: "12px", overflowWrap: "anywhere" }, children: ["Note: ", event.note ?? "-"] })] }, event.id))), promotionEvents.length === 0 && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No promotion events for this definition yet." })] })] })) : (_jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "Select a workflow definition." }))] }), _jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(260px, 1fr))", gap: "12px" }, children: [definitions.map((definition) => (_jsx("button", { onClick: () => setSelected(definition), style: {
                            padding: 0,
                            margin: 0,
                            background: "transparent",
                            border: selected?.id === definition.id ? "1px solid #2563eb" : "1px solid transparent",
                            borderRadius: "8px",
                            textAlign: "left",
                            cursor: "pointer",
                        }, children: _jsx(DefinitionCard, { definition: definition }) }, definition.id))), !definitions.length && _jsx("div", { style: { color: "#777", fontSize: "12px" }, children: "No workflow definitions match the current filters." })] })] }));
}
