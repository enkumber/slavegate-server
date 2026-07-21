import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

type RuntimeMode = "disabled" | "shadow" | "enforced";

interface RuntimeFlag {
  scope_type: string;
  scope_value: string;
  mode: RuntimeMode;
  selector_first: boolean;
  graph_runtime: boolean;
  ai_recovery: boolean;
  candidate_learning: boolean;
  auto_promotion: boolean;
}

interface Candidate {
  id: string;
  app_id: string;
  candidate_type: string;
  status: string;
  discovery_method: string;
  confidence: number;
  success_count: number;
  failure_count: number;
  distinct_context_count: number;
  safety_class: string;
  payload: Record<string, unknown>;
}

interface StatusResponse {
  startupDefaults: {
    mode: RuntimeMode;
    selectorFirst: boolean;
    graphRuntime: boolean;
    aiRecovery: boolean;
    candidateLearning: boolean;
    autoPromotion: boolean;
  };
  effective24h: {
    actions: number;
    fast_path_actions: number;
    vlm_actions: number;
    unknown_state_actions: number;
    recovered_actions: number;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    fastPathRate: number;
    vlmRate: number;
    unknownStateRate: number;
  };
  candidates: Array<{ status: string; candidate_type: string; count: number }>;
  flags: RuntimeFlag[];
}

const panel: React.CSSProperties = { background: "#101018", border: "1px solid #29293d", borderRadius: 8, padding: 16 };
const button: React.CSSProperties = { background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: 6, padding: "7px 10px", cursor: "pointer" };

function pct(value: number | undefined): string {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

export function UiGraphPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scopeType, setScopeType] = useState("global");
  const [scopeValue, setScopeValue] = useState("*");
  const [mode, setMode] = useState<RuntimeMode>("shadow");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextStatus, nextCandidates] = await Promise.all([
        api.get<StatusResponse>("/ui-graph/status"),
        api.get<Candidate[]>("/ui-graph/candidates"),
      ]);
      setStatus(nextStatus);
      setCandidates(nextCandidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load UI Graph runtime");
    } finally {
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
    } catch (err) { setError(err instanceof Error ? err.message : "Flag update failed"); }
    finally { setBusy(false); }
  };

  const candidateAction = async (id: string, action: "promote" | "quarantine") => {
    if (!reason.trim()) { setError("Audit reason is required"); return; }
    setBusy(true);
    try {
      await api.post(`/ui-graph/candidates/${id}/${action}`, { reason });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : `${action} failed`); }
    finally { setBusy(false); }
  };

  const materialize = async () => {
    setBusy(true);
    try { await api.post("/ui-graph/materialize"); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Materialization failed"); }
    finally { setBusy(false); }
  };

  const stats = status?.effective24h;
  return (
    <main style={{ padding: 24, color: "#e5e7eb", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>UI Graph Runtime</h1>
          <div style={{ color: "#8b8ba7", marginTop: 5, fontSize: 13 }}>Fast path, state resolution, recovery and controlled learning</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={button} disabled={busy} onClick={() => void materialize()}>Materialize App Maps</button>
          <button style={button} disabled={busy} onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <div style={{ background: "#3a1618", border: "1px solid #7f1d1d", color: "#fca5a5", padding: 10, borderRadius: 6, marginBottom: 14 }}>{error}</div>}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(130px, 1fr))", gap: 12, marginBottom: 14 }}>
        {[
          ["Fast path", pct(stats?.fastPathRate)],
          ["VLM rate", pct(stats?.vlmRate)],
          ["Unknown state", pct(stats?.unknownStateRate)],
          ["p50 latency", `${Math.round(stats?.p50_latency_ms ?? 0)} ms`],
          ["p95 latency", `${Math.round(stats?.p95_latency_ms ?? 0)} ms`],
        ].map(([label, value]) => <div key={label} style={panel}><div style={{ color: "#77778f", fontSize: 11 }}>{label}</div><div style={{ fontSize: 22, marginTop: 6 }}>{value}</div></div>)}
      </section>

      <section style={{ ...panel, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Scoped rollout control</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={scopeType} onChange={(event) => setScopeType(event.target.value)} style={{ ...button, cursor: "default" }}>
            <option value="global">global</option><option value="app">app</option><option value="workflow">workflow</option><option value="device">device</option>
          </select>
          <input value={scopeValue} onChange={(event) => setScopeValue(event.target.value)} style={{ ...button, minWidth: 260, cursor: "text" }} />
          <select value={mode} onChange={(event) => setMode(event.target.value as RuntimeMode)} style={{ ...button, cursor: "default" }}>
            <option value="disabled">disabled</option><option value="shadow">shadow</option><option value="enforced">enforced</option>
          </select>
          <button style={button} disabled={busy} onClick={() => void saveFlag()}>Save scope</button>
          <span style={{ color: "#77778f", fontSize: 12, alignSelf: "center" }}>Startup kill switch: {status?.startupDefaults.mode ?? "-"}</span>
        </div>
      </section>

      <section style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Learning candidates</div>
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required audit reason" style={{ ...button, minWidth: 300, cursor: "text" }} />
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {candidates.map((candidate) => (
            <div key={candidate.id} style={{ background: "#0b0b12", border: "1px solid #242438", borderRadius: 6, padding: 12, display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr auto", gap: 12, alignItems: "center" }}>
              <div><div style={{ fontWeight: 600 }}>{candidate.app_id} · {candidate.candidate_type}</div><div style={{ color: "#77778f", fontSize: 11, marginTop: 4 }}>{String(candidate.payload?.elementKey ?? candidate.payload?.transitionKey ?? candidate.discovery_method)}</div></div>
              <div style={{ fontSize: 12 }}>{candidate.status} · {(Number(candidate.confidence) * 100).toFixed(0)}%</div>
              <div style={{ fontSize: 12, color: "#9ca3af" }}>{candidate.success_count} ok / {candidate.failure_count} fail / {candidate.distinct_context_count} contexts</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={button} disabled={busy || candidate.status === "promoted"} onClick={() => void candidateAction(candidate.id, "promote")}>Promote</button>
                <button style={{ ...button, borderColor: "#7f1d1d", color: "#fca5a5" }} disabled={busy || candidate.status === "quarantined"} onClick={() => void candidateAction(candidate.id, "quarantine")}>Quarantine</button>
              </div>
            </div>
          ))}
          {!candidates.length && <div style={{ color: "#77778f", fontSize: 13 }}>No candidates yet.</div>}
        </div>
      </section>
    </main>
  );
}
