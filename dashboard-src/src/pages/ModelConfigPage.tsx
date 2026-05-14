import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api/client";

type Role = "decision_llm" | "vision_vlm";

interface ModelConfig {
  role: Role;
  provider: string;
  endpoint: string | null;
  model: string;
  credentialRef: string | null;
  apiKeyFingerprint: string | null;
  enabled: boolean;
  version: number;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestAt: string | null;
  updatedAt: string;
  hasCredential: boolean;
}

const roles: Role[] = ["decision_llm", "vision_vlm"];

export function ModelConfigPage() {
  const [configs, setConfigs] = useState<Record<Role, ModelConfig | null>>({ decision_llm: null, vision_vlm: null });
  const [drafts, setDrafts] = useState<Record<Role, any>>({ decision_llm: {}, vision_vlm: {} });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const rows = await api.get<ModelConfig[]>("/server/models");
      const next = { decision_llm: null, vision_vlm: null } as Record<Role, ModelConfig | null>;
      const nextDrafts = { decision_llm: {}, vision_vlm: {} } as Record<Role, any>;
      for (const row of rows) {
        next[row.role] = row;
        nextDrafts[row.role] = { ...row, credential: "" };
      }
      setConfigs(next);
      setDrafts(nextDrafts);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save(role: Role) {
    setMessage(null);
    const draft = drafts[role];
    try {
      const body: any = {
        provider: draft.provider,
        endpoint: draft.endpoint || null,
        model: draft.model,
        enabled: Boolean(draft.enabled),
      };
      let updated = await api.patch<ModelConfig>(`/server/models/${role}`, body);
      if (draft.credential) {
        updated = await api.post<ModelConfig>(`/server/models/${role}/credential`, { credential: draft.credential });
      } else if (draft.credentialRef) {
        updated = await api.post<ModelConfig>(`/server/models/${role}/credential`, { credentialRef: draft.credentialRef });
      }
      setConfigs((prev) => ({ ...prev, [role]: updated }));
      setDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
      setMessage(`${role} saved`);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function test(role: Role) {
    setMessage(null);
    try {
      const updated = await api.post<ModelConfig>(`/server/models/${role}/test`);
      setConfigs((prev) => ({ ...prev, [role]: updated }));
      setDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
      setMessage(`${role} connection OK`);
    } catch (err) {
      await load();
      setMessage((err as Error).message);
    }
  }

  function updateDraft(role: Role, key: string, value: unknown) {
    setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1100px", margin: "0 auto", color: "#fff", fontFamily: "monospace" }}>
      <h1 style={{ fontSize: "22px", marginBottom: "6px" }}>🔑 Tokens / Models</h1>
      <p style={{ color: "#aaa", marginTop: 0 }}>Configure server-side LLM/VLM providers. Stored credentials are never shown to phones or returned by the API.</p>
      {message && <div style={{ background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: message.includes("OK") || message.includes("saved") ? "#8be28b" : "#ff9a9a" }}>{message}</div>}
      {loading ? <div style={{ color: "#777" }}>Loading…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }}>
          {roles.map((role) => {
            const draft = drafts[role] ?? {};
            const config = configs[role];
            return (
              <section key={role} style={{ background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }}>
                <h2 style={{ fontSize: "18px", marginTop: 0 }}>{role === "decision_llm" ? "🧠 Decision LLM" : "👁️ Vision VLM"}</h2>
                <label style={labelStyle}><input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => updateDraft(role, "enabled", e.target.checked)} /> Enabled</label>
                <Field label="Provider" value={draft.provider ?? ""} onChange={(v) => updateDraft(role, "provider", v)} placeholder="openai_compatible" />
                <Field label="Endpoint" value={draft.endpoint ?? ""} onChange={(v) => updateDraft(role, "endpoint", v)} placeholder="https://host/v1 or .../chat/completions" />
                <Field label="Model" value={draft.model ?? ""} onChange={(v) => updateDraft(role, "model", v)} placeholder="model name" />
                <Field label="Credential ref" value={draft.credentialRef ?? ""} onChange={(v) => updateDraft(role, "credentialRef", v)} placeholder="env:VAR_NAME or file:/path/to/token" />
                <Field label="New API key/token" type="password" value={draft.credential ?? ""} onChange={(v) => updateDraft(role, "credential", v)} placeholder={config?.hasCredential ? "stored — leave blank to keep" : "paste token"} />
                <div style={{ color: "#aaa", fontSize: "12px", margin: "8px 0 14px" }}>
                  Credential: {config?.hasCredential ? `stored (${config.apiKeyFingerprint ?? "ref"})` : "missing"}<br />
                  Version: {config?.version ?? "—"} · Last test: {config?.lastTestStatus ?? "never"} {config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : ""}<br />
                  {config?.lastTestMessage && <span>{config.lastTestMessage}</span>}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button style={primaryButton} onClick={() => save(role)}>Save</button>
                  <button style={secondaryButton} onClick={() => test(role)}>Test connection</button>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <label style={labelStyle}>{label}<input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle} /></label>;
}

const labelStyle: CSSProperties = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px" };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryButton: CSSProperties = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryButton: CSSProperties = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
