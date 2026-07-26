import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { accountsApi, type Account } from "../api/accounts";
import {
  agencyApi,
  type AgencyWorkflowRun,
  type HumanWorkflowCompileBuildingSegmentResult,
  type HumanWorkflowCompileCompilingResult,
  type HumanWorkflowCompileJobFailedResult,
  type HumanWorkflowCompileJobPendingResult,
  type HumanWorkflowCompileReadyResult,
  type HumanWorkflowCompileResult,
  type HumanWorkflowRunResult,
} from "../api/agency";
import type { Device } from "../../../shared/protocol/api-types";

interface Props {
  device: Device;
  onClose: () => void;
}

export function HumanWorkflowModal({ device, onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [intent, setIntent] = useState("");
  const [compileResult, setCompileResult] = useState<HumanWorkflowCompileReadyResult | null>(null);
  const [compileJob, setCompileJob] = useState<
    HumanWorkflowCompileCompilingResult
    | HumanWorkflowCompileBuildingSegmentResult
    | HumanWorkflowCompileJobPendingResult
    | null
  >(null);
  const [compileFailure, setCompileFailure] = useState<HumanWorkflowCompileJobFailedResult | null>(null);
  const [readyCompileJobId, setReadyCompileJobId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<HumanWorkflowRunResult | null>(null);
  const [runStatus, setRunStatus] = useState<AgencyWorkflowRun | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === accountId) ?? null,
    [accounts, accountId],
  );

  useEffect(() => {
    let alive = true;
    setLoadingAccounts(true);
    accountsApi.list({ deviceId: device.id, pageSize: 100 })
      .then((data) => {
        if (!alive) return;
        setAccounts(data.items);
        setAccountId("");
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoadingAccounts(false);
      });
    return () => { alive = false; };
  }, [device.id]);

  const refreshRun = useCallback(async (id: string) => {
    const next = await agencyApi.humanWorkflow.getRun(id);
    setRunStatus(next);
  }, []);

  useEffect(() => {
    if (!runResult?.id) return;
    refreshRun(runResult.id).catch((err) => setError((err as Error).message));
    const timer = setInterval(() => {
      refreshRun(runResult.id).catch((err) => setError((err as Error).message));
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
      } else {
        setReadyCompileJobId("compileJobId" in data ? data.compileJobId : null);
        setCompileJob(data);
      }
    } catch (err) {
      resetCompileState();
      setError((err as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const retryCompile = async () => {
    if (!compileFailure?.compileJobId) return;
    setCompiling(true);
    setError(null);
    try {
      const data = await agencyApi.humanWorkflow.retryCompileJob(compileFailure.compileJobId);
      setCompileResult(null);
      setCompileFailure(null);
      setReadyCompileJobId(data.compileJobId);
      setCompileJob(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  useEffect(() => {
    if (!compileJob) return;
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
        if (cancelled) return;
        if (isCompileReady(data)) {
          setCompileResult(data);
          setReadyCompileJobId(
            "compileJobId" in compileJob ? compileJob.compileJobId : null,
          );
          setCompileJob(null);
          setCompileFailure(null);
        } else if ("terminal" in data && data.terminal) {
          setCompileResult(null);
          setCompileJob(null);
          setCompileFailure(data);
        } else {
          setCompileJob(data);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountId, compileJob, device.id, intent]);

  const run = async () => {
    if (!compileResult?.dashboardExecutionAllowed) return;
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const planStepCount = compileResult?.plan.steps?.length ?? compileResult?.plan.compiledPlan?.steps?.length ?? 0;
  const actionCount = compileResult?.plan.actions?.length ?? 0;
  const canRun = !!compileResult?.dashboardExecutionAllowed && !running;
  const terminalStatus = Boolean(runStatus?.completedAt ?? runStatus?.completed_at);
  const compilePending = compiling || !!compileJob;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        padding: "24px",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: "min(860px, 100%)", maxHeight: "92vh", overflow: "auto",
        background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "8px",
        color: "#e2e8f0", fontFamily: "monospace",
      }}>
        <div style={{ padding: "18px 20px", borderBottom: "1px solid #1e293b", display: "flex", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px" }}>AI Workflow</h3>
            <div style={{ marginTop: "4px", fontSize: "12px", color: "#64748b" }}>
              {device.friendlyName ?? device.model ?? device.id} · {device.status}
            </div>
          </div>
          <button onClick={onClose} style={ghostButtonStyle}>Close</button>
        </div>

        <div style={{ padding: "18px 20px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.8fr)", gap: "18px" }}>
          <div>
            <label style={labelStyle}>Account</label>
            <select
              value={accountId}
              disabled={loadingAccounts}
              onChange={(e) => { setAccountId(e.target.value); resetCompileState(); }}
              style={inputStyle}
            >
              <option value="">Device only</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  @{account.username} · {account.platform} · {account.status}
                </option>
              ))}
            </select>

            <label style={{ ...labelStyle, marginTop: "14px" }}>Instruction</label>
            <textarea
              value={intent}
              onChange={(e) => { setIntent(e.target.value); resetCompileState(); }}
              placeholder="What should this device do?"
              rows={6}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }}
            />

            {selectedAccount && (
              <div style={{ marginTop: "8px", color: "#64748b", fontSize: "12px" }}>
                Target: @{selectedAccount.username} on {selectedAccount.platform}
              </div>
            )}
            {!selectedAccount && !loadingAccounts && (
              <div style={{ marginTop: "8px", color: "#64748b", fontSize: "12px" }}>
                Target: device-only workflow. Social-account actions will still require an account.
              </div>
            )}

            {error && (
              <div style={{ marginTop: "12px", background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: "6px", padding: "8px 10px", color: "#fca5a5", fontSize: "12px" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
              <button
                onClick={compile}
                disabled={compilePending || !intent.trim()}
                style={primaryButtonStyle(compilePending || !intent.trim() ? "#334155" : "#2563eb")}
              >
                {compilePending ? "Compiling..." : "Compile"}
              </button>
              <button
                onClick={run}
                disabled={!canRun}
                style={primaryButtonStyle(canRun ? "#16a34a" : "#334155")}
              >
                {running ? "Queueing..." : "Run"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <Panel title="Preview">
              {compileResult ? (
                <>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                    <Badge label={compileResult.safetyClass} color={compileResult.safetyPresentationColor ?? "#64748b"} />
                    <Badge label={compileResult.cacheHit ? "cache hit" : "compiled"} color="#60a5fa" />
                  </div>
                  <Metric label="Steps" value={String(planStepCount)} />
                  <Metric label="Actions" value={String(actionCount)} />
                  <Metric label="Platform" value={compileResult.platform} />
                  <Metric label="Request" value={compileResult.requestKey} />
                  {compileResult.source && <Metric label="Source" value={compileResult.source} />}
                  {compileResult.architecture === "segments-v1" && (
                    <>
                      <Metric label="Composition" value={`${compileResult.compositionName ?? "-"}@${compileResult.compositionVersion ?? "-"}`} />
                      <Metric label="Composition key" value={compileResult.compositionKey ?? "-"} />
                      <Metric label="Execution key" value={compileResult.executionKey ?? "-"} />
                      <Metric
                        label="Segments"
                        value={(compileResult.segmentRefs ?? []).map((item) => `${item.segmentKey}@${item.segmentVersion}`).join(", ") || "-"}
                      />
                      <Metric label="Runtime inputs" value={JSON.stringify(compileResult.publicRuntimeInputs ?? {})} />
                    </>
                  )}
                  {!compileResult.dashboardExecutionAllowed && (
                    <div style={{ marginTop: "10px", color: "#fca5a5", fontSize: "12px" }}>
                      {compileResult.dashboardBlockedReason ?? "This plan is not enabled for dashboard execution by its PostgreSQL policy."}
                    </div>
                  )}
                </>
              ) : compileJob ? (
                <>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                    <Badge label="in progress" color="#f59e0b" />
                    <Badge label="polling" color="#60a5fa" />
                  </div>
                  <Metric
                    label="Job"
                    value={"segmentBuildJobId" in compileJob
                      ? compileJob.segmentBuildJobId
                      : compileJob.compileJobId}
                  />
                  <Metric label="Request" value={compileJob.requestKey} />
                </>
              ) : compileFailure ? (
                <>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                    <Badge label="failed" color="#ef4444" />
                    {compileFailure.retryable && <Badge label="retryable" color="#f59e0b" />}
                  </div>
                  <Metric label="Job" value={compileFailure.compileJobId} />
                  <Metric label="Request" value={compileFailure.requestKey} />
                  <div style={{ marginTop: "10px", color: "#fca5a5", fontSize: "12px", lineHeight: 1.45 }}>
                    {compileFailure.error}
                  </div>
                  {compileFailure.retryable && (
                    <button
                      onClick={retryCompile}
                      disabled={compiling}
                      style={{ ...primaryButtonStyle(compiling ? "#334155" : "#2563eb"), marginTop: "12px" }}
                    >
                      Retry compile
                    </button>
                  )}
                </>
              ) : (
                <EmptyText value="Compile to preview the generated plan." />
              )}
            </Panel>

            <Panel title="Status">
              {runResult ? (
                <>
                  <Metric label="Run" value={runResult.id} />
                  <Metric label="Task" value={runResult.taskId ?? "pending"} />
                  <Metric label="Status" value={runStatus?.status ?? runResult.status} />
                  {terminalStatus && (
                    <pre style={preStyle}>{JSON.stringify(runStatus?.result ?? runStatus?.error ?? null, null, 2)}</pre>
                  )}
                </>
              ) : (
                <EmptyText value="Run a compiled plan to start polling status." />
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #1e293b", borderRadius: "8px", padding: "12px", background: "#111827" }}>
      <div style={{ color: "#94a3b8", fontSize: "11px", textTransform: "uppercase", marginBottom: "10px" }}>{title}</div>
      {children}
    </section>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ color, border: `1px solid ${color}55`, background: `${color}16`, borderRadius: "4px", padding: "3px 7px", fontSize: "11px" }}>
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: "8px", marginBottom: "6px", fontSize: "12px" }}>
      <span style={{ color: "#64748b" }}>{label}</span>
      <span style={{ color: "#e2e8f0", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function EmptyText({ value }: { value: string }) {
  return <div style={{ color: "#64748b", fontSize: "12px", lineHeight: 1.5 }}>{value}</div>;
}

function isCompileReady(
  result: HumanWorkflowCompileResult
    | HumanWorkflowCompileJobPendingResult
    | HumanWorkflowCompileJobFailedResult,
): result is HumanWorkflowCompileReadyResult {
  return result.ready === true;
}

function pollingDelayMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.max(value, 1_000), 30_000);
}

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: "6px",
  color: "#94a3b8",
  fontSize: "12px",
};

const inputStyle: CSSProperties = {
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

const ghostButtonStyle: CSSProperties = {
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

const preStyle: CSSProperties = {
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

function primaryButtonStyle(background: string): CSSProperties {
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
