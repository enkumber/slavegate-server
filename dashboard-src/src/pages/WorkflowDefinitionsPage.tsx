import { useCallback, useEffect, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import {
  agencyApi,
  WorkflowDefinition,
  WorkflowDefinitionPromotionEvent,
  WorkflowDefinitionResolutionResponse,
  WorkflowDefinitionRollbackPreviewResponse,
  WorkflowDefinitionVersionEvent,
} from "../api/agency";
import { statusTone as genericStatusTone } from "../utils/statusPresentation";

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

function statusTone(definition: WorkflowDefinition): "green" | "yellow" | "gray" | "red" {
  if (definition.statusCapabilities.terminal) {
    return definition.statusCapabilities.retryable ? "red" : "gray";
  }
  if (definition.statusCapabilities.dispatchable) return "green";
  const tone = genericStatusTone(definition.status);
  return tone === "blue" ? "gray" : tone;
}

function shortList(values: unknown[], limit = 3) {
  if (!values.length) return "-";
  return `${values.slice(0, limit).map(String).join(", ")}${values.length > limit ? " +" : ""}`;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function promotionReadinessLabel(definition: WorkflowDefinition) {
  return typeof definition.promotion?.readiness?.state === "string"
    ? definition.promotion.readiness.state
    : "not_evaluated";
}

function DefinitionCard({ definition }: { definition: WorkflowDefinition }) {
  const readiness = promotionReadinessLabel(definition);
  const branchCoverage = numberValue(definition.promotion?.readiness?.branchCoveragePercent);
  const validationScore = numberValue(definition.promotion?.readiness?.validationScore);
  return (
    <div style={{ background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "14px", minWidth: 0 }}>
      <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#e5e7eb", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{definition.title}</div>
          <div style={{ color: "#666", fontSize: "11px", marginTop: "3px" }}>{definition.key}@v{definition.version}</div>
        </div>
        <Badge label={definition.status} tone={statusTone(definition)} />
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
        <Badge label={definition.platform} tone="blue" />
        <Badge label={definition.intent} tone="gray" />
        <Badge label={definition.source} tone="gray" />
        <Badge label={`promotion: ${definition.promotion?.state ?? "-"}`} tone={definition.promotion?.stateCapabilities?.terminal ? "red" : definition.promotion?.reusable ? "green" : "gray"} />
        <Badge label={`confidence: ${Math.round(numberValue(definition.promotion?.confidence) * 100)}%`} tone="blue" />
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
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Readiness: {readiness} · score {validationScore} · branches {branchCoverage}%</div>
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
  const [resolveScope, setResolveScope] = useState("device:test-device");
  const [resolution, setResolution] = useState<WorkflowDefinitionResolutionResponse | null>(null);
  const [selected, setSelected] = useState<WorkflowDefinition | null>(null);
  const [promotionScope, setPromotionScope] = useState("definition:limited-review");
  const [promotionNote, setPromotionNote] = useState("");
  const [rollbackTargetId, setRollbackTargetId] = useState("");
  const [promotionBusy, setPromotionBusy] = useState(false);
  const [promotionEvents, setPromotionEvents] = useState<WorkflowDefinitionPromotionEvent[]>([]);
  const [versionEvents, setVersionEvents] = useState<WorkflowDefinitionVersionEvent[]>([]);
  const [versions, setVersions] = useState<WorkflowDefinition[]>([]);
  const [impactPreview, setImpactPreview] = useState<Record<string, unknown> | null>(null);
  const [hardeningPreview, setHardeningPreview] = useState<Record<string, unknown> | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<WorkflowDefinitionRollbackPreviewResponse | null>(null);
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
        scope: resolveScope || undefined,
      });
      setResolution(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve workflow definition");
    } finally {
      setLoading(false);
    }
  }, [intent, resolvePlatform, resolveScope]);

  const loadPromotionEvents = useCallback(async (definitionId?: string | null) => {
    if (!definitionId) {
      setPromotionEvents([]);
      return;
    }
    const response = await agencyApi.workflowDefinitions.listPromotionEvents({ definitionId, pageSize: 10 });
    setPromotionEvents(response.items);
  }, []);

  const loadRollbackPreview = useCallback(async (definitionId?: string | null) => {
    if (!definitionId) {
      setRollbackPreview(null);
      return;
    }
    const response = await agencyApi.workflowDefinitions.rollbackPreview(definitionId);
    setRollbackPreview(response);
  }, []);

  const loadVersioning = useCallback(async (definition?: WorkflowDefinition | null) => {
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
      await loadRollbackPreview(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to promote workflow definition");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadPromotionEvents, loadRollbackPreview, promotionNote, promotionScope, selected]);

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
      await loadRollbackPreview(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke workflow definition promotion");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadPromotionEvents, loadRollbackPreview, promotionNote, selected]);

  const rollbackSelected = useCallback(async () => {
    if (!selected) return;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to roll back workflow definition");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadPromotionEvents, loadRollbackPreview, promotionNote, rollbackTargetId, selected]);

  const createVersionSelected = useCallback(async () => {
    if (!selected) return;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create workflow definition version");
    } finally {
      setPromotionBusy(false);
    }
  }, [load, loadVersioning, promotionNote, selected]);

  const lifecycleSelected = useCallback(async (action: "archive" | "deprecate" | "activate" | "draft") => {
    if (!selected) return;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update workflow definition lifecycle");
    } finally {
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
          <input value={resolveScope} onChange={(event) => setResolveScope(event.target.value)} placeholder="Scope" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "190px" }} />
          <button onClick={() => void resolve()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>Resolve dry-run</button>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
          <Badge label={`outcome: ${resolution?.outcome ?? "-"}`} tone={resolution?.candidateDefinition ? "red" : "yellow"} />
          <Badge label={`wouldUseDefinition: ${String(resolution?.wouldUseDefinition ?? false)}`} tone={resolution?.wouldUseDefinition ? "yellow" : "gray"} />
          <Badge label={`wouldChangePlan: ${String(resolution?.wouldChangePlan ?? false)}`} tone={resolution?.wouldChangePlan ? "yellow" : "gray"} />
          <Badge label="wouldChangeWorkflowCache: false" tone="gray" />
          <Badge label="wouldExecuteWorkflow: false" tone="gray" />
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
                ["Confidence", `${Math.round(numberValue(selected.promotion?.confidence) * 100)}%`],
                ["Readiness", promotionReadinessLabel(selected)],
                ["Validation score", String(numberValue(selected.promotion?.readiness?.validationScore))],
                ["Branch coverage", `${numberValue(selected.promotion?.readiness?.branchCoveragePercent)}%`],
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
              <button onClick={() => void promoteSelected()} disabled={promotionBusy || selected.promotion.reusable} style={{ background: selected.promotion.reusable ? "#1f1f1f" : "#166534", border: "1px solid #15803d", color: "#dcfce7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || selected.promotion.reusable ? "not-allowed" : "pointer" }}>Promote limited</button>
              <button onClick={() => void revokeSelected()} disabled={promotionBusy || selected.promotion.stateCapabilities.terminal} style={{ background: selected.promotion.stateCapabilities.terminal ? "#1f1f1f" : "#3a1618", border: "1px solid #7f1d1d", color: "#fecaca", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || selected.promotion.stateCapabilities.terminal ? "not-allowed" : "pointer" }}>Revoke</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "8px", marginBottom: "12px" }}>
              <div style={{ background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Scope Details</div>
                <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                  {String(selected.promotion?.scopeDetails?.scopeType ?? "-")} · global allowed: {String(selected.promotion?.scopeDetails?.globalScopeAllowed ?? false)}
                </div>
              </div>
              <div style={{ background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Rollback Preview</div>
                <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                  {rollbackPreview?.available ? "target available" : "no previous version"} · wouldRollbackNow: {String(rollbackPreview?.wouldRollbackNow ?? false)}
                </div>
              </div>
              <div style={{ background: "#0a0a0a", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Promotion Mode</div>
                <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                  manual only · auto-use {String(selected.promotion?.autoUseEnabled ?? false)}
                </div>
              </div>
            </div>
            <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#0a0a0a", padding: "10px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                <div>
                  <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }}>Manual Rollback</div>
                  <div style={{ color: "#777", fontSize: "12px", marginTop: "3px" }}>
                    Switch limited reuse metadata to an older definition version. No compiler, cache, or execution path changes.
                  </div>
                </div>
                <Badge label="rollback: manual/audited" tone="blue" />
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                <select value={rollbackTargetId} onChange={(event) => setRollbackTargetId(event.target.value)} style={{ background: "#050505", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "260px" }}>
                  <option value="">Preview target: {rollbackPreview?.selectedTarget ? `${String(rollbackPreview.selectedTarget.key)}@v${String(rollbackPreview.selectedTarget.version)}` : "none"}</option>
                  {(rollbackPreview?.candidateTargets ?? []).map((target) => (
                    <option key={String(target.id)} value={String(target.id)}>
                      {String(target.key)}@v{String(target.version)} · {String(target.status)} · {String(target.promotionState)}
                    </option>
                  ))}
                </select>
                <button onClick={() => void rollbackSelected()} disabled={promotionBusy || !rollbackPreview?.available} style={{ background: rollbackPreview?.available ? "#1f2937" : "#1f1f1f", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy || !rollbackPreview?.available ? "not-allowed" : "pointer" }}>Rollback manual</button>
                <Badge label={`wouldChangeWorkflowCache: ${String(rollbackPreview?.wouldChangeWorkflowCache ?? false)}`} tone="gray" />
                <Badge label={`wouldExecuteWorkflow: ${String(rollbackPreview?.wouldExecuteWorkflow ?? false)}`} tone="gray" />
              </div>
            </div>
            <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#0a0a0a", padding: "10px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
                <div>
                  <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }}>Versioning & Lifecycle</div>
                  <div style={{ color: "#777", fontSize: "12px", marginTop: "3px" }}>
                    Create drafts, archive or deprecate definitions, and preview impact without touching execution.
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <Badge label={`versions: ${versions.length}`} tone="blue" />
                  <Badge label="workflowCacheChanging: false" tone="gray" />
                  <Badge label="wouldExecuteWorkflow: false" tone="gray" />
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }}>
                <button onClick={() => void createVersionSelected()} disabled={promotionBusy} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }}>Create draft version</button>
                <button onClick={() => void lifecycleSelected("activate")} disabled={promotionBusy} style={{ background: "#0f3323", border: "1px solid #166534", color: "#dcfce7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }}>Activate</button>
                <button onClick={() => void lifecycleSelected("deprecate")} disabled={promotionBusy} style={{ background: "#332b12", border: "1px solid #854d0e", color: "#fef3c7", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }}>Deprecate</button>
                <button onClick={() => void lifecycleSelected("archive")} disabled={promotionBusy} style={{ background: "#3a1618", border: "1px solid #7f1d1d", color: "#fecaca", borderRadius: "6px", padding: "8px 12px", cursor: promotionBusy ? "not-allowed" : "pointer" }}>Archive</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: "8px", marginBottom: "10px" }}>
                <div style={{ background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Impact Preview</div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                    versions {String(impactPreview?.versionCount ?? versions.length)} · promotions {Array.isArray(impactPreview?.promotionEvents) ? impactPreview.promotionEvents.length : 0}
                  </div>
                </div>
                <div style={{ background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Hardening</div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                    recommendation: {String(hardeningPreview?.recommendation ?? "-")}
                  </div>
                </div>
                <div style={{ background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "10px" }}>
                  <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>Hardening Blockers</div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", overflowWrap: "anywhere" }}>
                    {shortList(Array.isArray(hardeningPreview?.blockers) ? hardeningPreview.blockers : [], 4)}
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(180px, 1fr))", gap: "8px" }}>
                <div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>Versions</div>
                  <div style={{ display: "grid", gap: "6px" }}>
                    {versions.slice(0, 5).map((version) => (
                      <div key={version.id} style={{ display: "flex", justifyContent: "space-between", gap: "8px", background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }}>
                        <span style={{ color: "#ddd", fontSize: "12px" }}>{version.key}@v{version.version}</span>
                        <Badge label={version.status} tone={statusTone(version)} />
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#e5e7eb", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>Version Audit</div>
                  <div style={{ display: "grid", gap: "6px" }}>
                    {versionEvents.slice(0, 5).map((event) => (
                      <div key={event.id} style={{ background: "#050505", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }}>
                        <div style={{ color: "#ddd", fontSize: "12px" }}>{event.action} · v{event.definitionVersion ?? "-"}</div>
                        <div style={{ color: "#777", fontSize: "11px", marginTop: "3px" }}>{event.previousStatus ?? "-"} → {event.nextStatus ?? "-"} · {event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</div>
                      </div>
                    ))}
                    {!versionEvents.length && <div style={{ color: "#777", fontSize: "12px" }}>No version events yet.</div>}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Promotion Audit</div>
            <div style={{ display: "grid", gap: "8px" }}>
              {promotionEvents.map((event) => (
                <div key={event.id} style={{ border: "1px solid #242424", borderRadius: "6px", padding: "10px", background: "#0d0d0d" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginBottom: "5px" }}>
                    <Badge label={event.action === "promote_limited" ? "Promote limited" : event.action === "rollback" ? "Rollback" : "Revoke"} tone={event.action === "promote_limited" ? "green" : event.action === "rollback" ? "blue" : "red"} />
                    <span style={{ color: "#777", fontSize: "11px" }}>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</span>
                  </div>
                  <div style={{ color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }}>State: {event.previousState ?? "-"} → {event.nextState ?? "-"}</div>
                  <div style={{ color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }}>Actor: {event.actor ?? "-"} · Scope: {event.promotionScope ?? "-"}</div>
                  <div style={{ color: "#aaa", fontSize: "12px", overflowWrap: "anywhere" }}>Confidence: {Math.round(numberValue(event.promotionConfidence) * 100)}% · Readiness: {String(event.promotionReadiness?.state ?? "-")}</div>
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
