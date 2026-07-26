/**
 * CompilerKnowledgePage.tsx
 * Read-only rules/examples that will later guide workflow compilation.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, CompilerAwarenessEvent, CompilerAwarenessResponse, CompilerKnowledgeEntry, CompilerPolicyGate } from "../api/agency";

function Badge({ label, tone }: { label: string; tone: "green" | "yellow" | "gray" | "red" | "blue" }) {
  const palette = {
    green: { bg: "#0f3323", color: "#4ade80", border: "#166534" },
    yellow: { bg: "#332b12", color: "#fbbf24", border: "#854d0e" },
    gray: { bg: "#1f1f1f", color: "#d4d4d8", border: "#333" },
    red: { bg: "#3a1618", color: "#f87171", border: "#7f1d1d" },
    blue: { bg: "#102033", color: "#60a5fa", border: "#1d4ed8" },
  }[tone];
  return (
    <span style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px" }}>
      {label}
    </span>
  );
}

function riskTone(risk: string): "green" | "yellow" | "red" {
  if (risk === "low") return "green";
  if (risk === "medium") return "yellow";
  return "red";
}

function sourceTone(source: string): "blue" | "yellow" | "gray" | "green" | "red" {
  if (source === "product_decision") return "blue";
  if (source === "qa_guardrail") return "yellow";
  if (source === "live_incident") return "red";
  return "green";
}

function stateTone(_state: string): "green" | "yellow" | "gray" | "red" | "blue" {
  return "gray";
}

function listText(values: string[]) {
  return values.length ? values.join(", ") : "-";
}

function eligibilityBlockers(item: { eligibility?: { blockers?: string[] } }) {
  return item.eligibility?.blockers?.length ? item.eligibility.blockers.join(", ") : "-";
}

function remediationActions(item: { eligibility?: { remediation?: { nextActions?: string[] } } }) {
  return item.eligibility?.remediation?.nextActions?.length ? item.eligibility.remediation.nextActions : [];
}

function eligibilityPolicyGates(item: { eligibility?: { policyGates?: Array<{ id?: string }> } }) {
  return item.eligibility?.policyGates?.length
    ? item.eligibility.policyGates.map((gate) => gate.id).filter(Boolean).join(", ")
    : "-";
}

function decisionRemediation(decision: CompilerAwarenessResponse["decision"]) {
  return decision.remediation?.nextActions?.length ? decision.remediation.nextActions : [];
}

function decisionPolicyGates(decision: CompilerAwarenessResponse["decision"]) {
  return decision.policyGateSummary?.length
    ? decision.policyGateSummary.map((gate) => gate.id).filter(Boolean).join(", ")
    : "-";
}

function eventPolicyGateText(event: CompilerAwarenessEvent) {
  const summary = event.policyGateSummary;
  const gates = summary?.gates ?? [];
  if (!gates.length) return "-";
  const ids = gates.map((gate) => gate.id).filter(Boolean).slice(0, 3).join(", ");
  const suffix = (summary?.total ?? gates.length) > 3 ? " +" : "";
  return `${ids}${suffix} · blocked ${summary?.blocked ?? 0} · high ${summary?.highRisk ?? 0}`;
}

function awarenessPolicyGateText(summary: CompilerAwarenessResponse["policyGateSummary"]) {
  const gates = summary?.gates ?? [];
  if (!gates.length) return "-";
  const ids = gates.map((gate) => gate.id).filter(Boolean).slice(0, 5).join(", ");
  const suffix = (summary?.total ?? gates.length) > 5 ? " +" : "";
  return `${ids}${suffix}`;
}

export function CompilerKnowledgePage() {
  const [items, setItems] = useState<CompilerKnowledgeEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [domainFilter, setDomainFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [policyMode, setPolicyMode] = useState("read_only_knowledge_base");
  const [awarenessIntent, setAwarenessIntent] = useState("unlock device");
  const [awareness, setAwareness] = useState<CompilerAwarenessResponse | null>(null);
  const [awarenessEvents, setAwarenessEvents] = useState<CompilerAwarenessEvent[]>([]);
  const [policyGates, setPolicyGates] = useState<CompilerPolicyGate[]>([]);
  const [policyGateMode, setPolicyGateMode] = useState("read_only_compiler_policy_gates");
  const [awarenessLoading, setAwarenessLoading] = useState(false);
  const [awarenessError, setAwarenessError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  );

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Compiler Knowledge");
    } finally {
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
    } catch (err) {
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
    } catch (err) {
      setAwarenessError(err instanceof Error ? err.message : "Failed to load Compiler Awareness");
    } finally {
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

  return (
    <AgencyLayout currentRoute="#/agency/compiler-knowledge">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Compiler Knowledge</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "12px", marginBottom: "18px" }}>
        {([
          ["Entries", items.length, "#4ade80"],
          ["Rules", ruleCount, "#60a5fa"],
          ["Negative learning", negativeCount, "#f87171"],
          ["Compiler visible", compilerVisibleCount, "#a1a1aa"],
        ] as Array<[string, number, string]>).map(([label, value, color]) => (
          <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }}>
            <div style={{ color: "#777", fontSize: "11px", marginBottom: "6px" }}>{label}</div>
            <div style={{ color, fontSize: "22px", fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <Badge label={`mode: ${policyMode}`} tone="blue" />
        <Badge label="compilerVisible: false" tone="gray" />
        <Badge label="autoUseEnabled: false" tone="gray" />
        <Badge label="executionChanging: false" tone="gray" />
        <span style={{ color: "#777", fontSize: "12px" }}>Read-only guidance. Compiler execution remains unchanged.</span>
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600 }}>Compiler Policy Gates</div>
            <div style={{ color: "#777", fontSize: "12px", marginTop: "4px" }}>Read-only registry of explicit gates required before compiler auto-use can exist.</div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Badge label={`mode: ${policyGateMode}`} tone="blue" />
            <Badge label="safeToAutoApply: false" tone="gray" />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(190px, 1fr))", gap: "10px" }}>
          {policyGates.map((gate) => (
            <div key={gate.id} style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "start", marginBottom: "8px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gate.title}</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "3px" }}>{gate.id}</div>
                </div>
                <Badge label={gate.state} tone={stateTone(gate.state)} />
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
                <Badge label={gate.category} tone="gray" />
                <Badge label={gate.risk} tone={riskTone(gate.risk)} />
                <Badge label={gate.owner} tone="blue" />
              </div>
              <div style={{ color: "#888", fontSize: "11px", lineHeight: 1.45 }}>
                Blocks: {listText(gate.blocks)}
              </div>
              <div style={{ color: "#666", fontSize: "11px", lineHeight: 1.45, marginTop: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Next: {gate.remediation.nextActions[0] ?? "-"}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600 }}>Compiler Awareness</div>
            <div style={{ color: "#777", fontSize: "12px", marginTop: "4px" }}>Read-only candidate matching from Tool Catalog, Step Library, and Knowledge Base.</div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={awarenessIntent}
              onChange={(event) => setAwarenessIntent(event.target.value)}
              placeholder="Intent"
              style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" }}
            />
            <button onClick={() => void loadAwareness()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>
              Check
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
          <Badge label="mode: read_only_compiler_awareness" tone="blue" />
          <Badge label="wouldUse: false" tone="gray" />
          <Badge label="autoUseEnabled: false" tone="gray" />
          <Badge label="executionChanging: false" tone="gray" />
        </div>
        {awarenessError ? (
          <div style={{ color: "#f87171", fontSize: "12px" }}>{awarenessError}</div>
        ) : awarenessLoading ? (
          <div style={{ color: "#777", fontSize: "12px" }}>Loading awareness...</div>
        ) : awareness ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: "10px" }}>
              {([
                ["Tool candidates", awareness.summary.toolCandidates, awareness.candidates.tools.map((item) => item.id).join(", ")],
                ["Step candidates", awareness.summary.stepCandidates, awareness.candidates.steps.map((item) => `${item.name ?? item.id} (${item.reason})`).join(", ")],
                ["Knowledge candidates", awareness.summary.knowledgeCandidates, awareness.candidates.knowledge.map((item) => item.id).join(", ")],
              ] as Array<[string, number, string]>).map(([label, value, detail]) => (
                <div key={label} style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>{label}</div>
                  <div style={{ color: "#e5e7eb", fontSize: "20px", fontWeight: 600 }}>{value}</div>
                  <div style={{ color: "#888", fontSize: "11px", marginTop: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail || "-"}</div>
                </div>
              ))}
            </div>
            <div style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px" }}>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" }}>
                <Badge label={`decision: ${awareness.decision.outcome ?? "unknown"}`} tone="yellow" />
                <Badge label={`wouldChangePlan: ${String(awareness.decision.wouldChangePlan ?? false)}`} tone="gray" />
                <Badge label={`wouldExecuteStepLibrary: ${String(awareness.decision.wouldExecuteStepLibrary ?? false)}`} tone="gray" />
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" }}>
                <Badge label={`gates: ${awareness.policyGateSummary?.total ?? 0}`} tone="blue" />
                <Badge label={`blocked: ${awareness.policyGateSummary?.blocked ?? 0}`} tone="yellow" />
                <Badge label={`high-risk: ${awareness.policyGateSummary?.highRisk ?? 0}`} tone="red" />
                <Badge label={`safeToAutoApply: ${awareness.policyGateSummary?.safeToAutoApply ?? 0}`} tone="gray" />
              </div>
              <div style={{ color: "#888", fontSize: "12px", marginBottom: "8px" }}>
                Gate summary: {awarenessPolicyGateText(awareness.policyGateSummary)}
              </div>
              <div style={{ color: "#888", fontSize: "12px" }}>
                Blockers: {(awareness.decision.blockers ?? []).join(", ") || "-"}
              </div>
              <div style={{ color: "#888", fontSize: "12px", marginTop: "8px" }}>
                Policy gates: {decisionPolicyGates(awareness.decision)}
              </div>
              <div style={{ color: "#888", fontSize: "12px", marginTop: "8px" }}>
                Remediation: {decisionRemediation(awareness.decision).slice(0, 2).join(" · ") || "-"}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "10px" }}>
              {([
                ["Tool eligibility", awareness.candidates.tools.slice(0, 3)],
                ["Step eligibility", awareness.candidates.steps.slice(0, 3)],
                ["Knowledge eligibility", awareness.candidates.knowledge.slice(0, 3)],
              ] as Array<[string, CompilerAwarenessResponse["candidates"]["tools"]]>).map(([label, candidates]) => (
                <div key={label} style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "7px" }}>{label}</div>
                  <div style={{ display: "grid", gap: "6px" }}>
                    {(candidates.length ? candidates : []).map((item) => (
                      <div key={item.id} style={{ minWidth: 0 }}>
                        <div style={{ color: "#aaa", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.name ?? item.id}: {eligibilityBlockers(item)}
                        </div>
                        <div style={{ color: "#666", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
                          {(remediationActions(item)[0] ?? "No remediation hint.")}
                        </div>
                        <div style={{ color: "#555", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
                          Gates: {eligibilityPolicyGates(item)}
                        </div>
                      </div>
                    ))}
                    {candidates.length === 0 && <div style={{ color: "#aaa", fontSize: "11px" }}>-</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600 }}>Awareness Audit</div>
            <div style={{ color: "#777", fontSize: "12px", marginTop: "4px" }}>Append-only log of read-only awareness checks. These entries never change execution.</div>
          </div>
          <Badge label="audit-only" tone="gray" />
        </div>
        {awarenessEvents.length === 0 ? (
          <div style={{ color: "#777", fontSize: "12px" }}>No awareness checks logged yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {awarenessEvents.map((event) => (
              <div key={event.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 0.6fr 0.6fr 0.9fr 1.1fr", gap: "10px", alignItems: "center", background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.intent || event.action || "awareness check"}</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "3px" }}>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</div>
                </div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>tools: {event.summary.toolCandidates ?? 0}</div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>steps: {event.summary.stepCandidates ?? 0}</div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>knowledge: {event.summary.knowledgeCandidates ?? 0}</div>
                <div style={{ color: "#aaa", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.decision.outcome ?? "no decision"}</div>
                <div style={{ color: "#aaa", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>gates: {eventPolicyGateText(event)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px", flexWrap: "wrap" }}>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} style={selectStyle}>
          <option value="">All types</option>
          <option value="rule">Rule</option>
          <option value="positive_example">Positive example</option>
          <option value="negative_example">Negative example</option>
          <option value="anti_pattern">Anti-pattern</option>
          <option value="app_map_hint">App-map hint</option>
          <option value="success_criteria">Success criteria</option>
          <option value="repair_note">Repair note</option>
        </select>
        <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)} style={selectStyle}>
          <option value="">All domains</option>
          <option value="workflow_lifecycle">Workflow lifecycle</option>
          <option value="step_library">Step Library</option>
          <option value="tool_selection">Tool selection</option>
          <option value="app_navigation">App navigation</option>
          <option value="safety">Safety</option>
          <option value="recovery">Recovery</option>
        </select>
        <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)} style={selectStyle}>
          <option value="">All risks</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} style={selectStyle}>
          <option value="">All sources</option>
          <option value="product_decision">Product decision</option>
          <option value="qa_guardrail">QA guardrail</option>
          <option value="live_incident">Live incident</option>
          <option value="implementation_rule">Implementation rule</option>
        </select>
        <button onClick={() => void loadKnowledge()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>
          Refresh
        </button>
      </div>

      {error && <div style={{ color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(430px, 1.05fr) minmax(380px, 0.95fr)", gap: "16px", alignItems: "start" }}>
        <div style={{ border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 0.7fr 0.55fr 0.7fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }}>
            <div>Knowledge</div>
            <div>Domain</div>
            <div>Risk</div>
            <div>Source</div>
          </div>
          {loading ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>Loading...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>No entries match the filters.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                style={{
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
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }}>{item.title}</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>{item.id} · {item.type}</div>
                </div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>{item.domain}</div>
                <div><Badge label={item.risk} tone={riskTone(item.risk)} /></div>
                <div><Badge label={item.source} tone={sourceTone(item.source)} /></div>
              </button>
            ))
          )}
        </div>

        <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }}>
          {selected ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }}>
                <div>
                  <h2 style={{ color: "#fff", fontSize: "16px", margin: "0 0 6px" }}>{selected.title}</h2>
                  <div style={{ color: "#777", fontSize: "12px" }}>{selected.id}</div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Badge label={selected.type} tone="blue" />
                  <Badge label={selected.risk} tone={riskTone(selected.risk)} />
                </div>
              </div>

              <div style={{ color: "#bbb", fontSize: "13px", lineHeight: 1.5, marginBottom: "12px" }}>{selected.summary}</div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px", marginBottom: "12px" }}>
                {([
                  ["Domain", selected.domain],
                  ["Status", selected.status],
                  ["Compiler visible", selected.policy.compilerVisible ? "yes" : "no"],
                  ["Auto-use", selected.policy.autoUseEnabled ? "yes" : "no"],
                  ["Execution changing", selected.policy.executionChanging ? "yes" : "no"],
                  ["Domains loaded", String(domains)],
                ] as Array<[string, string]>).map(([label, value]) => (
                  <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                    <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>{label}</div>
                    <div style={{ color: "#e5e7eb", fontSize: "12px" }}>{value}</div>
                  </div>
                ))}
              </div>

              <Panel title="Guidance" values={selected.guidance} />
              <Panel title="Applies to" values={selected.appliesTo} compact />
              <Panel title="Evidence required" values={selected.evidence.required} compact />
              <Panel title="Evidence examples" values={selected.evidence.examples} compact />

              <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", background: "#101010" }}>
                <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Notes</div>
                <div style={{ color: "#aaa", fontSize: "12px", lineHeight: 1.6 }}>{listText(selected.notes)}</div>
              </div>
            </>
          ) : (
            <div style={{ color: "#777", textAlign: "center", padding: "28px" }}>Select an entry.</div>
          )}
        </div>
      </div>
    </AgencyLayout>
  );
}

function Panel({ title, values, compact }: { title: string; values: string[]; compact?: boolean }) {
  return (
    <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }}>
      <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>{title}</div>
      {compact ? (
        <div style={{ color: "#aaa", fontSize: "12px", lineHeight: 1.6 }}>{listText(values)}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "18px", color: "#aaa", fontSize: "12px", lineHeight: 1.6 }}>
          {values.map((value) => <li key={value}>{value}</li>)}
        </ul>
      )}
    </div>
  );
}

const selectStyle = {
  background: "#111",
  border: "1px solid #333",
  color: "#ddd",
  borderRadius: "6px",
  padding: "8px 10px",
  minWidth: "160px",
};
