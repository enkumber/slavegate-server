import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { accountsApi } from "../api/accounts";
import { agencyApi, } from "../api/agency";
export function HumanWorkflowModal({ device, onClose }) {
    const [accounts, setAccounts] = useState([]);
    const [accountId, setAccountId] = useState("");
    const [intent, setIntent] = useState("");
    const [compileResult, setCompileResult] = useState(null);
    const [compileJob, setCompileJob] = useState(null);
    const [compileFailure, setCompileFailure] = useState(null);
    const [readyCompileJobId, setReadyCompileJobId] = useState(null);
    const [runResult, setRunResult] = useState(null);
    const [runStatus, setRunStatus] = useState(null);
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [compiling, setCompiling] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId) ?? null, [accounts, accountId]);
    useEffect(() => {
        let alive = true;
        setLoadingAccounts(true);
        accountsApi.list({ deviceId: device.id, pageSize: 100 })
            .then((data) => {
            if (!alive)
                return;
            setAccounts(data.items);
            setAccountId("");
        })
            .catch((err) => {
            if (alive)
                setError(err.message);
        })
            .finally(() => {
            if (alive)
                setLoadingAccounts(false);
        });
        return () => { alive = false; };
    }, [device.id]);
    const refreshRun = useCallback(async (id) => {
        const next = await agencyApi.humanWorkflow.getRun(id);
        setRunStatus(next);
    }, []);
    useEffect(() => {
        if (!runResult?.id)
            return;
        refreshRun(runResult.id).catch((err) => setError(err.message));
        const timer = setInterval(() => {
            refreshRun(runResult.id).catch((err) => setError(err.message));
        }, 5000);
        return () => clearInterval(timer);
    }, [refreshRun, runResult?.id]);
    const resetCompileState = useCallback(() => {
        setCompileResult(null);
        setCompileJob(null);
        setCompileFailure(null);
        setReadyCompileJobId(null);
    }, []);
    const compile = async () => {
        const trimmedIntent = intent.trim();
        if (!trimmedIntent) {
            setError("Enter an instruction.");
            return;
        }
        setCompiling(true);
        setError(null);
        resetCompileState();
        setRunResult(null);
        setRunStatus(null);
        try {
            const data = await agencyApi.humanWorkflow.compile({
                device_id: device.id,
                account_id: accountId || undefined,
                intent: trimmedIntent,
            });
            if (isCompileReady(data)) {
                setCompileResult(data);
            }
            else {
                setReadyCompileJobId("compileJobId" in data ? data.compileJobId : null);
                setCompileJob(data);
            }
        }
        catch (err) {
            resetCompileState();
            setError(err.message);
        }
        finally {
            setCompiling(false);
        }
    };
    const retryCompile = async () => {
        if (!compileFailure?.compileJobId)
            return;
        setCompiling(true);
        setError(null);
        try {
            const data = await agencyApi.humanWorkflow.retryCompileJob(compileFailure.compileJobId);
            setCompileResult(null);
            setCompileFailure(null);
            setReadyCompileJobId(data.compileJobId);
            setCompileJob(data);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setCompiling(false);
        }
    };
    useEffect(() => {
        if (!compileJob)
            return;
        let cancelled = false;
        const delayMs = pollingDelayMs(compileJob.retryAfterMs, 2_000);
        const timer = setTimeout(async () => {
            try {
                const data = "segmentBuildJobId" in compileJob
                    ? await agencyApi.humanWorkflow.compile({
                        device_id: device.id,
                        account_id: accountId || undefined,
                        intent: intent.trim(),
                    })
                    : await agencyApi.humanWorkflow.getCompileJob(compileJob.compileJobId);
                if (cancelled)
                    return;
                if (isCompileReady(data)) {
                    setCompileResult(data);
                    setReadyCompileJobId("compileJobId" in compileJob ? compileJob.compileJobId : null);
                    setCompileJob(null);
                    setCompileFailure(null);
                }
                else if ("terminal" in data && data.terminal) {
                    setCompileResult(null);
                    setCompileJob(null);
                    setCompileFailure(data);
                }
                else {
                    setCompileJob(data);
                }
            }
            catch (err) {
                if (!cancelled)
                    setError(err.message);
            }
        }, delayMs);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [accountId, compileJob, device.id, intent]);
    const run = async () => {
        if (!compileResult?.dashboardExecutionAllowed)
            return;
        setRunning(true);
        setError(null);
        try {
            const data = await agencyApi.humanWorkflow.run({
                device_id: device.id,
                account_id: compileResult.target.account_id,
                intent: intent.trim(),
                requestKey: compileResult.requestKey,
                cacheKey: compileResult.cacheKey,
                compileJobId: readyCompileJobId ?? undefined,
            });
            setRunResult(data);
        }
        catch (err) {
            setError(err.message);
        }
        finally {
            setRunning(false);
        }
    };
    const planStepCount = compileResult?.plan.steps?.length ?? compileResult?.plan.compiledPlan?.steps?.length ?? 0;
    const actionCount = compileResult?.plan.actions?.length ?? 0;
    const canRun = !!compileResult?.dashboardExecutionAllowed && !running;
    const terminalStatus = Boolean(runStatus?.completedAt ?? runStatus?.completed_at);
    const compilePending = compiling || !!compileJob;
    return (_jsx("div", { style: {
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
            padding: "24px",
        }, onClick: (e) => { if (e.target === e.currentTarget)
            onClose(); }, children: _jsxs("div", { style: {
                width: "min(860px, 100%)", maxHeight: "92vh", overflow: "auto",
                background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "8px",
                color: "#e2e8f0", fontFamily: "monospace",
            }, children: [_jsxs("div", { style: { padding: "18px 20px", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", gap: "16px" }, children: [_jsxs("div", { children: [_jsx("h3", { style: { margin: 0, fontSize: "16px" }, children: "AI Workflow" }), _jsxs("div", { style: { marginTop: "4px", fontSize: "12px", color: "#64748b" }, children: [device.friendlyName ?? device.model ?? device.id, " \u00B7 ", device.status] })] }), _jsx("button", { onClick: onClose, style: ghostButtonStyle, children: "Close" })] }), _jsxs("div", { style: { padding: "18px 20px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.8fr)", gap: "18px" }, children: [_jsxs("div", { children: [_jsx("label", { style: labelStyle, children: "Account" }), _jsxs("select", { value: accountId, disabled: loadingAccounts, onChange: (e) => { setAccountId(e.target.value); resetCompileState(); }, style: inputStyle, children: [_jsx("option", { value: "", children: "Device only" }), accounts.map((account) => (_jsxs("option", { value: account.id, children: ["@", account.username, " \u00B7 ", account.platform, " \u00B7 ", account.status] }, account.id)))] }), _jsx("label", { style: { ...labelStyle, marginTop: "14px" }, children: "Instruction" }), _jsx("textarea", { value: intent, onChange: (e) => { setIntent(e.target.value); resetCompileState(); }, placeholder: "What should this device do?", rows: 6, style: { ...inputStyle, resize: "vertical", lineHeight: 1.45 } }), selectedAccount && (_jsxs("div", { style: { marginTop: "8px", color: "#64748b", fontSize: "12px" }, children: ["Target: @", selectedAccount.username, " on ", selectedAccount.platform] })), !selectedAccount && !loadingAccounts && (_jsx("div", { style: { marginTop: "8px", color: "#64748b", fontSize: "12px" }, children: "Target: device-only workflow. Social-account actions will still require an account." })), error && (_jsx("div", { style: { marginTop: "12px", background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: "6px", padding: "8px 10px", color: "#fca5a5", fontSize: "12px" }, children: error })), _jsxs("div", { style: { display: "flex", gap: "10px", marginTop: "16px" }, children: [_jsx("button", { onClick: compile, disabled: compilePending || !intent.trim(), style: primaryButtonStyle(compilePending || !intent.trim() ? "#334155" : "#2563eb"), children: compilePending ? "Compiling..." : "Compile" }), _jsx("button", { onClick: run, disabled: !canRun, style: primaryButtonStyle(canRun ? "#16a34a" : "#334155"), children: running ? "Queueing..." : "Run" })] })] }), _jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "12px" }, children: [_jsx(Panel, { title: "Preview", children: compileResult ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: compileResult.safetyClass, color: compileResult.safetyPresentationColor ?? "#64748b" }), _jsx(Badge, { label: compileResult.cacheHit ? "cache hit" : "compiled", color: "#60a5fa" })] }), _jsx(Metric, { label: "Steps", value: String(planStepCount) }), _jsx(Metric, { label: "Actions", value: String(actionCount) }), _jsx(Metric, { label: "Platform", value: compileResult.platform }), _jsx(Metric, { label: "Request", value: compileResult.requestKey }), compileResult.source && _jsx(Metric, { label: "Source", value: compileResult.source }), compileResult.architecture === "segments-v1" && (_jsxs(_Fragment, { children: [_jsx(Metric, { label: "Composition", value: `${compileResult.compositionName ?? "-"}@${compileResult.compositionVersion ?? "-"}` }), _jsx(Metric, { label: "Composition key", value: compileResult.compositionKey ?? "-" }), _jsx(Metric, { label: "Execution key", value: compileResult.executionKey ?? "-" }), _jsx(Metric, { label: "Segments", value: (compileResult.segmentRefs ?? []).map((item) => `${item.segmentKey}@${item.segmentVersion}`).join(", ") || "-" }), _jsx(Metric, { label: "Runtime inputs", value: JSON.stringify(compileResult.publicRuntimeInputs ?? {}) })] })), !compileResult.dashboardExecutionAllowed && (_jsx("div", { style: { marginTop: "10px", color: "#fca5a5", fontSize: "12px" }, children: compileResult.dashboardBlockedReason ?? "This plan is not enabled for dashboard execution by its PostgreSQL policy." }))] })) : compileJob ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: "in progress", color: "#f59e0b" }), _jsx(Badge, { label: "polling", color: "#60a5fa" })] }), _jsx(Metric, { label: "Job", value: "segmentBuildJobId" in compileJob
                                                    ? compileJob.segmentBuildJobId
                                                    : compileJob.compileJobId }), _jsx(Metric, { label: "Request", value: compileJob.requestKey })] })) : compileFailure ? (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }, children: [_jsx(Badge, { label: "failed", color: "#ef4444" }), compileFailure.retryable && _jsx(Badge, { label: "retryable", color: "#f59e0b" })] }), _jsx(Metric, { label: "Job", value: compileFailure.compileJobId }), _jsx(Metric, { label: "Request", value: compileFailure.requestKey }), _jsx("div", { style: { marginTop: "10px", color: "#fca5a5", fontSize: "12px", lineHeight: 1.45 }, children: compileFailure.error }), compileFailure.retryable && (_jsx("button", { onClick: retryCompile, disabled: compiling, style: { ...primaryButtonStyle(compiling ? "#334155" : "#2563eb"), marginTop: "12px" }, children: "Retry compile" }))] })) : (_jsx(EmptyText, { value: "Compile to preview the generated plan." })) }), _jsx(Panel, { title: "Status", children: runResult ? (_jsxs(_Fragment, { children: [_jsx(Metric, { label: "Run", value: runResult.id }), _jsx(Metric, { label: "Task", value: runResult.taskId ?? "pending" }), _jsx(Metric, { label: "Status", value: runStatus?.status ?? runResult.status }), terminalStatus && (_jsx("pre", { style: preStyle, children: JSON.stringify(runStatus?.result ?? runStatus?.error ?? null, null, 2) }))] })) : (_jsx(EmptyText, { value: "Run a compiled plan to start polling status." })) })] })] })] }) }));
}
function Panel({ title, children }) {
    return (_jsxs("section", { style: { border: "1px solid #1e293b", borderRadius: "8px", padding: "12px", background: "#111827" }, children: [_jsx("div", { style: { color: "#94a3b8", fontSize: "11px", textTransform: "uppercase", marginBottom: "10px" }, children: title }), children] }));
}
function Badge({ label, color }) {
    return (_jsx("span", { style: { color, border: `1px solid ${color}55`, background: `${color}16`, borderRadius: "4px", padding: "3px 7px", fontSize: "11px" }, children: label }));
}
function Metric({ label, value }) {
    return (_jsxs("div", { style: { display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: "8px", marginBottom: "6px", fontSize: "12px" }, children: [_jsx("span", { style: { color: "#64748b" }, children: label }), _jsx("span", { style: { color: "#e2e8f0", overflowWrap: "anywhere" }, children: value })] }));
}
function EmptyText({ value }) {
    return _jsx("div", { style: { color: "#64748b", fontSize: "12px", lineHeight: 1.5 }, children: value });
}
function isCompileReady(result) {
    return result.ready === true;
}
function pollingDelayMs(value, fallback) {
    if (!Number.isFinite(value) || !value || value <= 0)
        return fallback;
    return Math.min(Math.max(value, 1_000), 30_000);
}
const labelStyle = {
    display: "block",
    marginBottom: "6px",
    color: "#94a3b8",
    fontSize: "12px",
};
const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: "6px",
    color: "#e2e8f0",
    fontFamily: "monospace",
    fontSize: "13px",
    padding: "9px 10px",
};
const ghostButtonStyle = {
    background: "transparent",
    border: "1px solid #334155",
    borderRadius: "6px",
    color: "#94a3b8",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "12px",
    padding: "7px 12px",
    height: "32px",
};
const preStyle = {
    margin: "10px 0 0",
    maxHeight: "180px",
    overflow: "auto",
    background: "#020617",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    color: "#cbd5e1",
    fontSize: "11px",
    padding: "8px",
};
function primaryButtonStyle(background) {
    return {
        background,
        color: "#fff",
        border: "none",
        borderRadius: "6px",
        cursor: background === "#334155" ? "not-allowed" : "pointer",
        fontFamily: "monospace",
        fontSize: "12px",
        fontWeight: "bold",
        padding: "9px 16px",
    };
}
