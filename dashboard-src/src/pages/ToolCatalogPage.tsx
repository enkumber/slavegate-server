/**
 * ToolCatalogPage.tsx
 * Read-only registry of runtime capabilities available to workflow planning.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, ToolCatalogEntry } from "../api/agency";

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

function listText(values: string[]) {
  return values.length ? values.join(", ") : "-";
}

export function ToolCatalogPage() {
  const [items, setItems] = useState<ToolCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [policyMode, setPolicyMode] = useState("read_only_catalog");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  );

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await agencyApi.toolCatalog.list({
        category: categoryFilter || undefined,
        risk: riskFilter || undefined,
        source: sourceFilter || undefined,
      });
      setItems(data.items);
      setPolicyMode(data.policy.mode);
      setSelectedId((current) => current && data.items.some((item) => item.id === current) ? current : data.items[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Tool Catalog");
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, riskFilter, sourceFilter]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const categoryCount = new Set(items.map((item) => item.category)).size;
  const deviceCount = items.filter((item) => item.requiresDevice).length;
  const highRiskCount = items.filter((item) => item.risk === "high").length;
  const compilerVisibleCount = items.filter((item) => item.policy.compilerVisible).length;

  return (
    <AgencyLayout currentRoute="#/agency/tool-catalog">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Tool Catalog</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "12px", marginBottom: "18px" }}>
        {([
          ["Tools", items.length, "#4ade80"],
          ["Categories", categoryCount, "#60a5fa"],
          ["Device tools", deviceCount, "#fbbf24"],
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
        <span style={{ color: "#777", fontSize: "12px" }}>Catalogul este doar inventar declarativ în faza asta.</span>
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px", flexWrap: "wrap" }}>
        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          style={{ background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "180px" }}
        >
          <option value="">All categories</option>
          <option value="device_control">Device control</option>
          <option value="navigation">Navigation</option>
          <option value="input">Input</option>
          <option value="observation">Observation</option>
          <option value="workflow">Workflow</option>
          <option value="content">Content</option>
        </select>
        <select
          value={riskFilter}
          onChange={(event) => setRiskFilter(event.target.value)}
          style={{ background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "140px" }}
        >
          <option value="">All risks</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
          style={{ background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px", minWidth: "170px" }}
        >
          <option value="">All sources</option>
          <option value="device_job">Device job</option>
          <option value="workflow_runtime">Workflow runtime</option>
          <option value="server_skill">Server skill</option>
        </select>
        <button
          onClick={() => void loadCatalog()}
          style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {error && <div style={{ color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1.05fr) minmax(360px, 0.95fr)", gap: "16px", alignItems: "start" }}>
        <div style={{ border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 0.75fr 0.55fr 0.75fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }}>
            <div>Tool</div>
            <div>Source</div>
            <div>Risk</div>
            <div>Policy</div>
          </div>
          {loading ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>Loading...</div>
          ) : items.length === 0 ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>No tools match the filters.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: "1fr 0.75fr 0.55fr 0.75fr",
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
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }}>{item.name}</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>{item.id} · {item.category}</div>
                </div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>{item.source}</div>
                <div><Badge label={item.risk} tone={riskTone(item.risk)} /></div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <Badge label={item.policy.readOnly ? "read" : "write"} tone={item.policy.readOnly ? "green" : "yellow"} />
                  {item.policy.externalAction && <Badge label="external" tone="red" />}
                </div>
              </button>
            ))
          )}
        </div>

        <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }}>
          {selected ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }}>
                <div>
                  <h2 style={{ color: "#fff", fontSize: "16px", margin: "0 0 6px" }}>{selected.name}</h2>
                  <div style={{ color: "#777", fontSize: "12px" }}>{selected.id}</div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Badge label={selected.source} tone="blue" />
                  <Badge label={selected.risk} tone={riskTone(selected.risk)} />
                </div>
              </div>

              <div style={{ color: "#bbb", fontSize: "13px", lineHeight: 1.5, marginBottom: "12px" }}>{selected.description}</div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px", marginBottom: "12px" }}>
                {([
                  ["Requires device", selected.requiresDevice ? "yes" : "no"],
                  ["DirectWS", selected.availability.directWs ? "yes" : "no"],
                  ["Edge workflow", selected.availability.edgeWorkflow ? "yes" : "no"],
                  ["Server runtime", selected.availability.serverRuntime ? "yes" : "no"],
                  ["Compiler visible", selected.policy.compilerVisible ? "yes" : "no"],
                  ["Auto-use", selected.policy.autoUseEnabled ? "yes" : "no"],
                ] as Array<[string, string]>).map(([label, value]) => (
                  <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "10px" }}>
                    <div style={{ color: "#777", fontSize: "11px", marginBottom: "5px" }}>{label}</div>
                    <div style={{ color: "#e5e7eb", fontSize: "12px" }}>{value}</div>
                  </div>
                ))}
              </div>

              <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }}>
                <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Policy</div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <Badge label={selected.policy.readOnly ? "read-only" : "mutating"} tone={selected.policy.readOnly ? "green" : "yellow"} />
                  {selected.policy.destructive && <Badge label="destructive" tone="red" />}
                  {selected.policy.externalAction && <Badge label="external action" tone="red" />}
                  <Badge label="compiler hidden" tone="gray" />
                  <Badge label="auto-use disabled" tone="gray" />
                </div>
              </div>

              <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "12px", background: "#101010" }}>
                <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Schema</div>
                <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "6px" }}>Required: {listText(selected.inputSchema.required)}</div>
                <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "6px" }}>Optional: {listText(selected.inputSchema.optional)}</div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>Produces: {listText(selected.outputSchema.produces)}</div>
              </div>

              <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", background: "#101010" }}>
                <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Notes</div>
                <ul style={{ margin: 0, paddingLeft: "18px", color: "#aaa", fontSize: "12px", lineHeight: 1.6 }}>
                  {selected.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
                <div style={{ color: "#777", fontSize: "12px", marginTop: "10px" }}>
                  Side effects: {listText(selected.sideEffects)}
                </div>
              </div>
            </>
          ) : (
            <div style={{ color: "#777", textAlign: "center", padding: "28px" }}>Select a tool.</div>
          )}
        </div>
      </div>
    </AgencyLayout>
  );
}
