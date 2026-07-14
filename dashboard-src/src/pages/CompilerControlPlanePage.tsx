import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, CompilerControlPlaneEvent, CompilerControlPlaneResponse } from "../api/agency";

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

function toneForState(state?: string): "green" | "yellow" | "gray" | "red" {
  if (state === "enabled") return "green";
  if (state === "review_ready") return "yellow";
  if (state === "blocked") return "red";
  return "gray";
}

function textList(values: unknown, limit = 3) {
  const items = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  if (!items.length) return "-";
  return `${items.slice(0, limit).join(", ")}${items.length > limit ? " +" : ""}`;
}

export function CompilerControlPlanePage() {
  const [intent, setIntent] = useState("unlock device");
  const [scope, setScope] = useState("device:test-device");
  const [data, setData] = useState<CompilerControlPlaneResponse | null>(null);
  const [events, setEvents] = useState<CompilerControlPlaneEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [controlPlane, eventPage] = await Promise.all([
        agencyApi.compilerControlPlane.get({ intent: intent || undefined, scope: scope || undefined }),
        agencyApi.compilerControlPlane.listEvents({ pageSize: 5 }),
      ]);
      setData(controlPlane);
      setEvents(eventPage.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Compiler Control Plane");
    } finally {
      setLoading(false);
    }
  }, [intent, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const gateSummary = data?.policyGates.summary;
  const manifest = data?.capabilityManifest;
  const dryRun = data?.dryRun;
  const reuseSummary = data?.limitedReusePlan.summary;
  const visibleTools = useMemo(() => (manifest?.tools ?? []).slice(0, 10), [manifest?.tools]);

  return (
    <AgencyLayout currentRoute="#/agency/compiler-control-plane">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Compiler Control Plane</h1>
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "12px", marginBottom: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <Badge label="readOnly: true" tone="blue" />
        <Badge label="autoUseEnabled: false" tone="gray" />
        <Badge label="wouldChangePlan: false" tone="gray" />
        <Badge label="wouldExecuteStepLibrary: false" tone="gray" />
        <Badge label="workflowCacheChanging: false" tone="gray" />
      </div>

      <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="Intent"
            style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" }}
          />
          <input
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            placeholder="Scope"
            style={{ background: "#0a0a0a", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "220px" }}
          />
          <button onClick={() => void load()} style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}>
            Run read-only dry-run
          </button>
          {loading && <span style={{ color: "#777", fontSize: "12px" }}>Loading...</span>}
          {error && <span style={{ color: "#f87171", fontSize: "12px" }}>{error}</span>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: "12px", marginBottom: "14px" }}>
        {([
          ["Policy gates", gateSummary?.total ?? 0, "#60a5fa"],
          ["Blocked", gateSummary?.blocked ?? 0, "#f87171"],
          ["High risk", gateSummary?.highRisk ?? 0, "#fbbf24"],
          ["Safe auto apply", gateSummary?.safeToAutoApply ?? 0, "#a1a1aa"],
        ] as Array<[string, unknown, string]>).map(([label, value, color]) => (
          <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }}>
            <div style={{ color: "#777", fontSize: "11px", marginBottom: "6px" }}>{label}</div>
            <div style={{ color, fontSize: "22px", fontWeight: 600 }}>{String(value)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
        <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }}>
          <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Scoped Dry-Run</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
            <Badge label={`outcome: ${dryRun?.outcome ?? "-"}`} tone="red" />
            <Badge label="safeToAutoApply: false" tone="gray" />
          </div>
          <div style={{ color: "#888", fontSize: "12px", lineHeight: 1.6 }}>
            Blockers: {textList(dryRun?.blockers, 6)}
          </div>
          <div style={{ color: "#888", fontSize: "12px", lineHeight: 1.6 }}>
            Selected steps: {(dryRun?.selectedStepIds ?? []).length}
          </div>
          <div style={{ color: "#888", fontSize: "12px", lineHeight: 1.6 }}>
            Selected tools: {(dryRun?.selectedToolIds ?? []).length}
          </div>
        </section>

        <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }}>
          <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Capability Manifest</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
            <Badge label={manifest?.compatibility.state ?? "unknown_device"} tone={manifest?.compatibility.state === "known_device" ? "green" : "yellow"} />
            <Badge label={`device: ${manifest?.deviceName ?? "-"}`} tone="gray" />
            <Badge label={`agent: ${manifest?.agentVersion ?? "-"}`} tone="gray" />
          </div>
          <div style={{ color: "#888", fontSize: "12px", lineHeight: 1.6 }}>
            Available tools: {String(manifest?.compatibility.availableTools ?? 0)} / {String(manifest?.compatibility.totalTools ?? 0)}
          </div>
          <div style={{ color: "#666", fontSize: "11px", marginTop: "8px" }}>
            Source: {manifest?.source ?? "-"} · device published: {manifest?.publishedByDevice ? "yes" : "no"}
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
            {visibleTools.slice(0, 6).map((tool) => (
              <Badge key={String(tool.id)} label={`${String(tool.id)}: ${tool.available ? "available" : "blocked"}`} tone={tool.available ? "green" : "gray"} />
            ))}
          </div>
        </section>
      </div>

      <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Limited Reuse Plan</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
          <Badge label={`candidates: ${String(reuseSummary?.candidates ?? 0)}`} tone="blue" />
          <Badge label={`scope matches: ${String(reuseSummary?.scopeMatches ?? 0)}`} tone="gray" />
          <Badge label={`capability matches: ${String(reuseSummary?.capabilityMatches ?? 0)}`} tone="gray" />
          <Badge label="wouldUse: 0" tone="gray" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: "10px" }}>
          {data?.limitedReusePlan.items.map((item) => (
            <div key={`${item.stepId ?? item.action}`} style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }}>
              <div style={{ color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name ?? item.action ?? item.stepId}</div>
              <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>{item.promotionScope ?? "no scope"}</div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                <Badge label={`scope: ${item.scopeMatch ? "match" : "blocked"}`} tone={item.scopeMatch ? "green" : "red"} />
                <Badge label={`cap: ${item.capabilityMatch ? "match" : "blocked"}`} tone={item.capabilityMatch ? "green" : "red"} />
              </div>
              <div style={{ color: "#777", fontSize: "11px", lineHeight: 1.45, marginTop: "8px" }}>Blockers: {textList(item.blockers, 4)}</div>
            </div>
          ))}
          {!data?.limitedReusePlan.items.length && <div style={{ color: "#777", fontSize: "12px" }}>No matching limited reuse candidates.</div>}
        </div>
      </section>

      <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px", marginBottom: "14px" }}>
        <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Policy Gate State</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(190px, 1fr))", gap: "10px" }}>
          {data?.policyGates.items.map((gate) => (
            <div key={gate.id} style={{ background: "#0d0d0d", border: "1px solid #222", borderRadius: "6px", padding: "12px", minWidth: 0 }}>
              <div style={{ color: "#e5e7eb", fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gate.title}</div>
              <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>{gate.id}</div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                <Badge label={gate.state} tone={toneForState(gate.state)} />
                <Badge label={`v${gate.version ?? 1}`} tone="blue" />
                <Badge label={gate.risk} tone={gate.risk === "high" ? "red" : gate.risk === "medium" ? "yellow" : "green"} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: "1px solid #222", borderRadius: "6px", background: "#101010", padding: "14px" }}>
        <div style={{ color: "#fff", fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>Recent Control Plane Checks</div>
        <div style={{ display: "grid", gap: "8px" }}>
          {events.map((event) => (
            <div key={event.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 140px", gap: "10px", alignItems: "center", borderBottom: "1px solid #1f1f1f", paddingBottom: "8px" }}>
              <div style={{ color: "#e5e7eb", fontSize: "12px" }}>{event.intent ?? "-"}</div>
              <div style={{ color: "#888", fontSize: "12px" }}>{event.requestedScope ?? "-"}</div>
              <div style={{ color: "#666", fontSize: "11px" }}>{event.createdAt ? new Date(event.createdAt).toLocaleString() : "-"}</div>
            </div>
          ))}
          {!events.length && <div style={{ color: "#777", fontSize: "12px" }}>No control plane checks yet.</div>}
        </div>
      </section>
    </AgencyLayout>
  );
}
