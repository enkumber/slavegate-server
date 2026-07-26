import { useCallback, useEffect, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, WorkflowValidationEvent, WorkflowValidationPipelineResponse } from "../api/agency";
import { statusTone } from "../utils/statusPresentation";

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

function stateTone(state: unknown): "green" | "yellow" | "gray" | "red" {
  const tone = statusTone(state);
  return tone === "blue" ? "gray" : tone;
}

function shortList(values: unknown, limit = 4) {
  if (!Array.isArray(values) || values.length === 0) return "-";
  return `${values.slice(0, limit).map(String).join(", ")}${values.length > limit ? " +" : ""}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function SummaryCard({ label, value, color }: { label: string; value: unknown; color: string }) {
  return (
    <div style={{ background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "12px" }}>
      <div style={{ color: "#777", fontSize: "11px", marginBottom: "4px" }}>{label}</div>
      <div style={{ color, fontSize: "22px", fontWeight: 700 }}>{String(value ?? 0)}</div>
    </div>
  );
}

function PipelineItem({ item }: { item: WorkflowValidationPipelineResponse["items"][number] }) {
  const branchCoverage = objectValue(item.dryRun.branchCoverage);
  const fixtureMatrix = arrayValue(item.dryRun.fixtureMatrix);
  const smokeScore = numberValue(item.smokeReadiness.score);
  const canaryScore = numberValue(item.canaryReadiness.score);
  const regressionScore = numberValue(item.regressionReadiness.score);
  return (
    <div style={{ background: "#101010", border: "1px solid #222", borderRadius: "6px", padding: "14px" }}>
      <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#e5e7eb", fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.definition.title}</div>
          <div style={{ color: "#666", fontSize: "11px", marginTop: "3px" }}>{item.definition.key}@v{item.definition.version}</div>
        </div>
        <Badge label={String(item.decision.outcome ?? "unknown")} tone="red" />
      </div>

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
        <Badge label={item.definition.platform} tone="blue" />
        <Badge label={item.definition.intent} tone="gray" />
        <Badge label={`static: ${String(item.staticValidation.state ?? "unknown")}`} tone={stateTone(item.staticValidation.state)} />
        <Badge label={`score: ${String(item.decision.validationScore ?? 0)}`} tone="yellow" />
        <Badge label="dry-run only" tone="yellow" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(90px, 1fr))", gap: "8px", marginBottom: "10px" }}>
        {([
          ["Errors", item.staticValidation.errors ?? 0],
          ["Warnings", item.staticValidation.warnings ?? 0],
          ["Coverage", `${String(branchCoverage.coveragePercent ?? 0)}%`],
          ["Fixtures", fixtureMatrix.length],
          ["Safe", String(item.decision.safeToAutoApply ?? false)],
        ] as Array<[string, unknown]>).map(([label, value]) => (
          <div key={String(label)} style={{ background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }}>
            <div style={{ color: "#666", fontSize: "10px" }}>{label}</div>
            <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }}>{String(value)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(90px, 1fr))", gap: "8px", marginBottom: "10px" }}>
        {([
          ["Smoke", item.smokeReadiness.state ?? "blocked", smokeScore],
          ["Canary", item.canaryReadiness.state ?? "blocked", canaryScore],
          ["Regression", item.regressionReadiness.state ?? "blocked", regressionScore],
        ] as Array<[string, unknown, number]>).map(([label, state, score]) => (
          <div key={String(label)} style={{ background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: "6px", padding: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
              <div style={{ color: "#666", fontSize: "10px" }}>{label}</div>
              <Badge label={`${score}%`} tone="gray" />
            </div>
            <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }}>{String(state)}</div>
          </div>
        ))}
      </div>

      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Blockers: {shortList(item.decision.blockers)}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Dry-run: wouldUseDefinition={String(item.dryRun.wouldUseDefinition)}; wouldExecuteWorkflow={String(item.dryRun.wouldExecuteWorkflow)}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Fixtures: {shortList(fixtureMatrix.map((fixture) => objectValue(fixture).id))}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Missing branches: {shortList(branchCoverage.missingBranches)}</div>
      <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.5 }}>Criteria: {shortList(item.definition.successCriteria)}</div>
    </div>
  );
}

function EventRow({ event }: { event: WorkflowValidationEvent }) {
  const decision = event.decision ?? {};
  const summary = event.summary ?? {};
  return (
    <div style={{ background: "#0b0b0b", border: "1px solid #202020", borderRadius: "6px", padding: "10px", display: "grid", gridTemplateColumns: "180px 1fr 160px", gap: "10px", alignItems: "center" }}>
      <div style={{ color: "#888", fontSize: "11px" }}>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "#e5e7eb", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.definitionKey ?? event.intent ?? "-"}</div>
        <div style={{ color: "#666", fontSize: "11px" }}>{event.platform ?? "-"} · {event.source ?? "-"} · score {String(summary.averageValidationScore ?? "-")}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Badge label={String(decision.outcome ?? "recorded")} tone="gray" />
      </div>
    </div>
  );
}

export function WorkflowValidationPipelinePage() {
  const [intent, setIntent] = useState("reddit_account_health_scan");
  const [platform, setPlatform] = useState("reddit");
  const [key, setKey] = useState("");
  const [pipeline, setPipeline] = useState<WorkflowValidationPipelineResponse | null>(null);
  const [events, setEvents] = useState<WorkflowValidationEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load validation pipeline");
    } finally {
      setLoading(false);
    }
  }, [intent, key, platform]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = pipeline?.summary ?? {};

  return (
    <AgencyLayout currentRoute="#/agency/workflow-validation-pipeline">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Validation Pipeline</h1>
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <Badge label="readOnly: true" tone="blue" />
        <Badge label="validationOnly: true" tone="gray" />
        <Badge label="autoPromotionEnabled: false" tone="gray" />
        <Badge label="wouldExecuteWorkflow: false" tone="gray" />
        <Badge label="workflowCacheChanging: false" tone="gray" />
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <input value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="Intent" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "240px" }} />
          <input value={platform} onChange={(event) => setPlatform(event.target.value)} placeholder="Platform" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "150px" }} />
          <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="Definition key" style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" }} />
          <button onClick={() => void load()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>Run validation preview</button>
          {loading && <span style={{ color: "#777", fontSize: "12px" }}>Loading...</span>}
          {error && <span style={{ color: "#f87171", fontSize: "12px" }}>{error}</span>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }}>
        <SummaryCard label="Definitions" value={summary.definitions} color="#e5e7eb" />
        <SummaryCard label="Static Passed" value={summary.staticPassed} color="#4ade80" />
        <SummaryCard label="Branch Coverage" value={`${String(summary.branchCoveragePercent ?? 0)}%`} color="#60a5fa" />
        <SummaryCard label="Validation Score" value={summary.averageValidationScore} color="#fbbf24" />
        <SummaryCard label="Safe Auto Apply" value={summary.safeToAutoApply} color="#f87171" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: "12px", marginBottom: "14px" }}>
        <SummaryCard label="Static Warnings" value={summary.staticWarnings} color="#fbbf24" />
        <SummaryCard label="Dry-run Fixtures" value={summary.dryRunFixtures} color="#60a5fa" />
        <SummaryCard label="Readiness Blocked" value={summary.readinessBlocked} color="#f87171" />
        <SummaryCard label="Would Promote" value={summary.wouldPromoteDefinition} color="#f87171" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "12px", marginBottom: "18px" }}>
        {(pipeline?.items ?? []).map((item) => <PipelineItem key={item.definition.id} item={item} />)}
        {pipeline && pipeline.items.length === 0 && <div style={{ color: "#777", fontSize: "13px" }}>No matching definitions.</div>}
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }}>
        <div style={{ color: "#e5e7eb", fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Validation Events</div>
        <div style={{ display: "grid", gap: "8px" }}>
          {events.map((event) => <EventRow key={event.id} event={event} />)}
          {events.length === 0 && <div style={{ color: "#777", fontSize: "13px" }}>No validation events yet.</div>}
        </div>
      </div>
    </AgencyLayout>
  );
}
