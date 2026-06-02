import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { accountsApi, type Account } from "../api/accounts";
import { agencyApi, type AgencyWorkflowRun, type HumanWorkflowCompileResult, type HumanWorkflowRunResult } from "../api/agency";
import type { Device } from "../../../shared/protocol/api-types";

interface Props {
  device: Device;
  onClose: () => void;
}

export function HumanWorkflowModal({ device, onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [intent, setIntent] = useState("");
  const [compileResult, setCompileResult] = useState<HumanWorkflowCompileResult | null>(null);
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
        setAccountId((current) => current || data.items[0]?.id || "");
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

  const compile = async () => {
    if (!accountId || !intent.trim()) {
      setError("Select an account and enter an instruction.");
      return;
    }
    setCompiling(true);
    setError(null);
    setRunResult(null);
    setRunStatus(null);
    try {
      const data = await agencyApi.humanWorkflow.compile({
        device_id: device.id,
        account_id: accountId,
        intent: intent.trim(),
      });
      setCompileResult(data);
    } catch (err) {
      setCompileResult(null);
      setError((err as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const run = async () => {
    if (!compileResult || compileResult.safetyClass === "destructive") return;
    setRunning(true);
    setError(null);
    try {
      const data = await agencyApi.humanWorkflow.run({
        device_id: device.id,
        account_id: compileResult.target.account_id,
        intent: intent.trim(),
        requestKey: compileResult.requestKey,
        cacheKey: compileResult.cacheKey,
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
  const canRun = !!compileResult && compileResult.safetyClass !== "destructive" && !running;
  const terminalStatus = runStatus?.status === "completed" || runStatus?.status === "failed" || runStatus?.status === "cancelled";

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
              disabled={loadingAccounts || accounts.length === 0}
              onChange={(e) => { setAccountId(e.target.value); setCompileResult(null); }}
              style={inputStyle}
            >
              {accounts.length === 0 && <option value="">No accounts on this device</option>}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  @{account.username} · {account.platform} · {account.status}
                </option>
              ))}
            </select>

            <label style={{ ...labelStyle, marginTop: "14px" }}>Instruction</label>
            <textarea
              value={intent}
              onChange={(e) => { setIntent(e.target.value); setCompileResult(null); }}
              placeholder="What should this device do?"
              rows={6}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }}
            />

            {selectedAccount && (
              <div style={{ marginTop: "8px", color: "#64748b", fontSize: "12px" }}>
                Target: @{selectedAccount.username} on {selectedAccount.platform}
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
                disabled={compiling || !accountId || !intent.trim()}
                style={primaryButtonStyle(compiling || !accountId || !intent.trim() ? "#334155" : "#2563eb")}
              >
                {compiling ? "Compiling..." : "Compile"}
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
                    <Badge label={compileResult.safetyClass} color={safetyColor(compileResult.safetyClass)} />
                    <Badge label={compileResult.cacheHit ? "cache hit" : "compiled"} color="#60a5fa" />
                  </div>
                  <Metric label="Steps" value={String(planStepCount)} />
                  <Metric label="Actions" value={String(actionCount)} />
                  <Metric label="Platform" value={compileResult.platform} />
                  <Metric label="Request" value={compileResult.requestKey} />
                  {compileResult.safetyClass === "destructive" && (
                    <div style={{ marginTop: "10px", color: "#fca5a5", fontSize: "12px" }}>
                      Destructive plans cannot be launched from the dashboard.
                    </div>
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

function safetyColor(safetyClass: HumanWorkflowCompileResult["safetyClass"]): string {
  if (safetyClass === "read_only") return "#22c55e";
  if (safetyClass === "standard") return "#f59e0b";
  return "#ef4444";
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
