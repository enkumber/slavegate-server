import { useCallback, useEffect, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, WorkflowDefinition, WorkflowDefinitionPromotionEvent, WorkflowDefinitionResolutionResponse } from "../api/agency";

function Badge({ label, tone }: { label: string; tone: "green" | "yellow" | "gray" | "red" | "blue" }) {
  const palette = {
    green: { bg: "#0f3323", color: "#4ade80", border: "#166534" },
    yellow: { bg: "#332b12", color: "#fbbf24", border: "#854d0e" },
    gray: { bg: "#1f1f1f", color: "#d4d4d8", border: "#333" },
    red: { bg: "#3a1618", color: "#f87171", border: "#7f1d1d" },
    blue: { bg: "#102033", color: "#60a5fa", border: "#1d4ed8" },
  }[tone];
  return (
    <span style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function statusTone(status: string): "green" | "yellow" | "gray" | "red" {
  if (status === "active") return "green";
  if (status === "draft") return "yellow";
  if (status === "deprecated") return "red";
  return "gray";
}

function shortList(values: unknown[], limit = 3) {
  if (!values.length) return "-";
  return `${values.slice(0, limit).map(String).join(", ")}${values.length > limit ? " +" : ""}`;
}

function DefinitionCard({ definition }: { definition: WorkflowDefinition }) {
  return (
    <div style={{ background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "14px", minWidth: 0 }}>
      <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#e5e7eb", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{definition.title}</div>
          <div style={{ color: "#666", fontSize: "11px", marginTop: "3px" }}>{definition.key}@v{definition.version}</div>
        </div>
        <Badge label={definition.status} tone={statusTone(definition.status)} />
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
        <Badge label={definition.platform} tone="blue" />
        <Badge label={definition.intent} tone="gray" />
        <Badge label={definition.source} tone="gray" />
        <Badge label={`promotion: ${definition.promotion?.state ?? "review_only"}`} tone={definition.promotion?.state === "limited_reuse" ? "green" : definition.promotion?.state === "revoked" ? "red" : "gray"} />
      </div>
      <div style={{ color: "#aaa", fontSize: "12px", lineHeight: 1.55, marginBottom: "10px" }}>{definition.goal}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(70px, 1fr))", gap: "6px", marginBottom: "10px" }}>
        {[
          ["criteria", definition.summary.successCriteria],
          ["tools", definition.summary.allowedTools],
          ["caps", definition.summary.requiredCapabilities],
          ["constraints", definition.summary.constraints],
          ["fallback", definition.summary.fallbackRules],
        ].map(([label, value]) => (
          <div key={String(label)} style={{ background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }}>
            <div style={{ color: "#666", fontSize: "10px" }}>{label}</div>
            <div style={{ color: "#e5e7eb", fontSize: "14px", fontWeight: 600 }}>{String(value)}</div>
          </div>
        ))}
      </div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Tools: {shortList(definition.allowedTools)}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Capabilities: {shortList(definition.requiredCapabilities)}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Rollback: {String(definition.rollback?.strategy ?? definition.rollback?.reason ?? "-")}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Promotion scope: {definition.promotion?.scope ?? "-"}</div>
    </div>
  );
}

export function WorkflowDefinitionsPage() {
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [intent, setIntent] = useState("reddit_account_health_scan");
  const [resolvePlatform, setResolvePlatform] = useState("reddit");
  const [resolution, setResolution] = useState<WorkflowDefinitionResolutionResponse | null>(null);
  const [selected, setSelected] = useState<WorkflowDefinition | null>(null);
  const [promotionScope, setPromotionScope] = useState("definition:limited-review");
  const [promotionNote, setPromotionNote] = useState("");
  const [promotionBusy, setPromotionBusy] = useState(false);
  const [promotionEvents, setPromotionEvents] = useState<WorkflowDefinitionPromotionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!current) return response.items[0] ?? null;
        return response.items.find((item) => item.id === current.id) ?? response.items[0] ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow definitions");
    } finally {
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
      });
      setResolution(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve workflow definition");
    } finally {
      setLoading(false);
    }
  }, [intent, resolvePlatform]);

  const loadPromotionEvents = useCallback(async (definitionId?: string | null) => {
    if (!definitionId) {
      setPromotionEvents([]);
      return;
    }
    const response = await agencyApi.workflowDefinitions.listPromotionEvents({ definitionId, pageSize: 10 });
    setPromotionEvents(response.items);
  }, []);

  const promoteSelected = useCallback(async () => {
    if (!selected) return;
    setPromotionBusy(true);
    setError(null);
    try {
      const response = await agencyApi.workflowDefinitions.promote(selected.id, {
        action: "promote_limited",
        scope: promotionScope,
        note: promotionNote || null,
      });
      setSelected(response.definition);
      await load();
      await loadPromotionEvents(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to promote workflow definition");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadPromotionEvents, promotionNote, promotionScope, selected]);

  const revokeSelected = useCallback(async () => {
    if (!selected) return;
    setPromotionBusy(true);
    setError(null);
    try {
      const response = await agencyApi.workflowDefinitions.promote(selected.id, {
        action: "revoke",
        note: promotionNote || null,
      });
      setSelected(response.definition);
      await load();
      await loadPromotionEvents(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke workflow definition promotion");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadPromotionEvents, promotionNote, selected]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  useEffect(() => {
    void loadPromotionEvents(selected?.id);
  }, [loadPromotionEvents, selected?.id]);

  return (
    <AgencyLayout currentRoute="#/agency/workflow-definitions">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Workflow Definitions</h1>
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <Badge label="readOnly: true" tone="blue" />
        <Badge label="compilerVisible: false" tone="gray" />
        <Badge label="autoUseEnabled: false" tone="gray" />
        <Badge label="executionChanging: false" tone="gray" />
        <Badge label="workflowCacheChanging: false" tone="gray" />
        <Badge label="controlledPromotion: manual" tone="blue" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }}>
        {([
          ["Active", summary.active ?? 0, "#4ade80"],
          ["Draft", summary.draft ?? 0, "#fbbf24"],
          ["Deprecated", summary.deprecated ?? 0, "#f87171"],
          ["Archived", summary.archived ?? 0, "#a1a1aa"],
        ] as Array<[string, number, string]>).map(([label, value, color]) => (
          <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }}>
            <div style={{ color: "#777", fontSize: "11px", marginBottom: "6px" }}>{label}</div>
            <div style={{ color, fontSize: "22px", fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px" }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="deprecated">Deprecated</option>
            <option value="archived">Archived</option>
          </select>
          <input value={platform} onChange={(event) => setPlatform(event.target.value)} placeholder="Platform filter" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "180px" }} />
          <button onClick={() => void load()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>Refresh definitions</button>
          {loading && <span style={{ color: "#777", fontSize: "12px" }}>Loading...</span>}
          {error && <span style={{ color: "#f87171", fontSize: "12px" }}>{error}</span>}
        </div>
      </div>

      <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Read-Only Resolution Preview</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
          <input value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="Intent" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" }} />
          <input value={resolvePlatform} onChange={(event) => setResolvePlatform(event.target.value)} placeholder="Platform" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "160px" }} />
          <button onClick={() => void resolve()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>Resolve read-only</button>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
          <Badge label={`outcome: ${resolution?.outcome ?? "-"}`} tone={resolution?.candidateDefinition ? "red" : "yellow"} />
          <Badge label="wouldUseDefinition: false" tone="gray" />
          <Badge label="wouldChangePlan: false" tone="gray" />
          <Badge label="wouldChangeWorkflowCache: false" tone="gray" />
        </div>
        <div style={{ color: "#e5e7eb", fontSize: "13px", marginBottom: "6px" }}>
          Candidate: {resolution?.candidateDefinition ? `${resolution.candidateDefinition.key}@v${resolution.candidateDefinition.version}` : "-"}
        </div>
        <div style={{ color: "#777", fontSize: "12px", lineHeight: 1.6 }}>
          Blockers: {shortList(resolution?.blockers ?? [], 6)}
        </div>
      </section>

      <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
          <div>
            <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600 }}>Controlled Promotion</div>
            <div style={{ color: "#777", fontSize: "12px", marginTop: "3px" }}>
              Manual, scope-bound promotion metadata only. Compiler auto-use remains disabled.
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <Badge label="wouldUseDefinition: false" tone="gray" />
            <Badge label="wouldExecuteWorkflow: false" tone="gray" />
            <Badge label="safeToAutoApply: false" tone="gray" />
          </div>
        </div>
        {selected ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "8px", marginBottom: "12px" }}>
              {[
                ["Selected", `${selected.key}@v${selected.version}`],
                ["State", selected.promotion?.state ?? "review_only"],
                ["Scope", selected.promotion?.scope ?? "-"],
                ["Compiler eligible", String(selected.promotion?.compilerEligible ?? false)],
              ].map(([label, value]) => (
                <div key={label} style={{ background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px", minWidth: 0 }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>{label}</div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
              <input value={promotionScope} onChange={(event) => setPromotionScope(event.target.value)} placeholder="scope, e.g. definition:..." style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" }} />
              <input value={promotionNote} onChange={(event) => setPromotionNote(event.target.value)} placeholder="review note" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" }} />
              <button onClick={() => void promoteSelected()} disabled={promotionBusy || selected.promotion?.state === "limited_reuse"} style={{ background: selected.promotion?.state === "limited_reuse" ? "#1f1f1f" : "#166534", border: "1px solid #15803d", color: "#dcfce7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || selected.promotion?.state === "limited_reuse" ? "not-allowed" : "pointer" }}>Promote limited</button>
              <button onClick={() => void revokeSelected()} disabled={promotionBusy || selected.promotion?.state === "revoked"} style={{ background: selected.promotion?.state === "revoked" ? "#1f1f1f" : "#3a1618", border: "1px solid #7f1d1d", color: "#fecaca", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || selected.promotion?.state === "revoked" ? "not-allowed" : "pointer" }}>Revoke</button>
            </div>
            <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Promotion Audit</div>
            <div style={{ display: "grid", gap: "8px" }}>
              {promotionEvents.map((event) => (
                <div key={event.id} style={{ border: "1px solid #242424", borderRadius: "6px", padding: "10px", background: "#0d0d0d" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "5px" }}>
                    <Badge label={event.action === "promote_limited" ? "Promote limited" : "Revoke"} tone={event.action === "promote_limited" ? "green" : "red"} />
                    <span style={{ color: "#777", fontSize: "11px" }}>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</span>
                  </div>
                  <div style={{ color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }}>State: {event.previousState ?? "-"} → {event.nextState ?? "-"}</div>
                  <div style={{ color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }}>Actor: {event.actor ?? "-"} · Scope: {event.promotionScope ?? "-"}</div>
                  <div style={{ color: "#777", fontSize: "12px", overflowWrap: "anywhere" }}>Note: {event.note ?? "-"}</div>
                </div>
              ))}
              {promotionEvents.length === 0 && <div style={{ color: "#777", fontSize: "12px" }}>No promotion events for this definition yet.</div>}
            </div>
          </>
        ) : (
          <div style={{ color: "#777", fontSize: "12px" }}>Select a workflow definition.</div>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(260px, 1fr))", gap: "12px" }}>
        {definitions.map((definition) => (
          <button
            key={definition.id}
            onClick={() => setSelected(definition)}
            style={{
              padding: 0,
              margin: 0,
              background: "transparent",
              border: selected?.id === definition.id ? "1px solid #2563eb" : "1px solid transparent",
              borderRadius: "8px",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <DefinitionCard definition={definition} />
          </button>
        ))}
        {!definitions.length && <div style={{ color: "#777", fontSize: "12px" }}>No workflow definitions match the current filters.</div>}
      </div>
    </AgencyLayout>
  );
}
