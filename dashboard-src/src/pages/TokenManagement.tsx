/**
 * pages/TokenManagement.tsx
 * Token management + Model configuration page.
 */

import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { api } from "../api/client";
import { TokenTable } from "../components/TokenTable";
import { GenerateTokenModal } from "../components/GenerateTokenModal";

interface TokenRow {
  id: string;
  token_hash_truncated: string;
  purpose: string;
  expires_at: string;
  created_at: string;
  revoked: boolean;
}

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

const modelRoles: Role[] = ["decision_llm", "vision_vlm"];

export function TokenManagement() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Model config state
  const [modelConfigs, setModelConfigs] = useState<Record<Role, ModelConfig | null>>({ decision_llm: null, vision_vlm: null });
  const [modelDrafts, setModelDrafts] = useState<Record<Role, any>>({ decision_llm: {}, vision_vlm: {} });
  const [modelLoading, setModelLoading] = useState(true);
  const [modelMsg, setModelMsg] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    try {
      const data = await api.get<TokenRow[]>("/device-tokens/list");
      setTokens(data);
    } catch (err) {
      console.error("Failed to fetch tokens:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchModels = useCallback(async () => {
    setModelLoading(true);
    try {
      const rows = await api.get<ModelConfig[]>("/server/models");
      const next: Record<Role, ModelConfig | null> = { decision_llm: null, vision_vlm: null };
      const nextDrafts: Record<Role, any> = { decision_llm: {}, vision_vlm: {} };
      for (const row of rows) {
        next[row.role] = row;
        nextDrafts[row.role] = { ...row, credential: "" };
      }
      setModelConfigs(next);
      setModelDrafts(nextDrafts);
    } catch (err) {
      console.error("Failed to fetch models:", err);
    } finally {
      setModelLoading(false);
    }
  }, []);

  useEffect(() => { fetchTokens(); fetchModels(); }, [fetchTokens, fetchModels]);

  async function saveModel(role: Role) {
    setModelMsg(null);
    const draft = modelDrafts[role];
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
      setModelConfigs((prev) => ({ ...prev, [role]: updated }));
      setModelDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
      setModelMsg(`${role === "decision_llm" ? "Decision LLM" : "Vision VLM"} saved ✓`);
    } catch (err) {
      setModelMsg((err as Error).message);
    }
  }

  async function testModel(role: Role) {
    setModelMsg(null);
    try {
      const updated = await api.post<ModelConfig>(`/server/models/${role}/test`);
      setModelConfigs((prev) => ({ ...prev, [role]: updated }));
      setModelDrafts((prev) => ({ ...prev, [role]: { ...updated, credential: "" } }));
      setModelMsg(`${role === "decision_llm" ? "Decision LLM" : "Vision VLM"} connection OK ✓`);
    } catch (err) {
      await fetchModels();
      setModelMsg((err as Error).message);
    }
  }

  function updateDraft(role: Role, key: string, value: unknown) {
    setModelDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1100px", margin: "0 auto" }}>
      {/* ─── Tokens Section ─── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", fontSize: "22px", fontFamily: "monospace", margin: 0 }}>
          🔑 Tokens & Models
        </h1>
        <button
          onClick={() => setShowModal(true)}
          style={{
            background: "#4a9eff", border: "none", color: "#fff",
            padding: "8px 20px", borderRadius: "4px", cursor: "pointer",
            fontFamily: "monospace", fontSize: "14px", fontWeight: 600,
          }}
        >
          + Generate Token
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px", color: "#666" }}>Loading…</div>
      ) : (
        <div style={{ background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", overflow: "hidden", marginBottom: "32px" }}>
          <TokenTable tokens={tokens} onRevoked={fetchTokens} />
        </div>
      )}

      {/* ─── Models Section ─── */}
      <h2 style={{ color: "#fff", fontSize: "20px", fontFamily: "monospace", margin: "0 0 6px", borderBottom: "1px solid #2a2a4a", paddingBottom: "10px" }}>
        🧠 Server Models
      </h2>
      <p style={{ color: "#aaa", fontSize: "13px", fontFamily: "monospace", marginTop: 0, marginBottom: "16px" }}>
        Configure LLM/VLM providers. Stored credentials are never shown to phones or returned by the API.
      </p>

      {modelMsg && (
        <div style={{ background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: modelMsg.includes("OK") || modelMsg.includes("saved") || modelMsg.includes("✓") ? "#8be28b" : "#ff9a9a", fontFamily: "monospace", fontSize: "13px" }}>
          {modelMsg}
        </div>
      )}

      {modelLoading ? (
        <div style={{ color: "#777", fontFamily: "monospace" }}>Loading models…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }}>
          {modelRoles.map((role) => {
            const draft = modelDrafts[role] ?? {};
            const config = modelConfigs[role];
            return (
              <section key={role} style={{ background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }}>
                <h3 style={{ fontSize: "16px", marginTop: 0, color: "#fff", fontFamily: "monospace" }}>
                  {role === "decision_llm" ? "🧠 Decision LLM" : "👁️ Vision VLM"}
                </h3>
                <label style={labelStyle}>
                  <input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => updateDraft(role, "enabled", e.target.checked)} /> Enabled
                </label>
                <MField label="Provider" value={draft.provider ?? ""} onChange={(v) => updateDraft(role, "provider", v)} placeholder="openai_compatible" />
                <MField label="Endpoint" value={draft.endpoint ?? ""} onChange={(v) => updateDraft(role, "endpoint", v)} placeholder="https://host/v1" />
                <MField label="Model" value={draft.model ?? ""} onChange={(v) => updateDraft(role, "model", v)} placeholder="model name" />
                <MField label="Credential ref" value={draft.credentialRef ?? ""} onChange={(v) => updateDraft(role, "credentialRef", v)} placeholder="env:VAR_NAME or file:/path" />
                <MField label="New API key/token" type="password" value={draft.credential ?? ""} onChange={(v) => updateDraft(role, "credential", v)} placeholder={config?.hasCredential ? "stored — leave blank to keep" : "paste token"} />
                <div style={{ color: "#888", fontSize: "11px", margin: "8px 0 14px", fontFamily: "monospace" }}>
                  Credential: {config?.hasCredential ? `stored (${config.apiKeyFingerprint ?? "ref"})` : "missing"} · Version: {config?.version ?? "—"}<br />
                  Last test: {config?.lastTestStatus ?? "never"} {config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : ""}
                  {config?.lastTestMessage && <span><br />{config.lastTestMessage}</span>}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button style={primaryBtn} onClick={() => saveModel(role)}>Save</button>
                  <button style={secondaryBtn} onClick={() => testModel(role)}>Test</button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {showModal && (
        <GenerateTokenModal
          onClose={() => setShowModal(false)}
          onGenerated={fetchTokens}
        />
      )}
    </div>
  );
}

function MField({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label style={labelStyle}>{label}<input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle} /></label>
  );
}

const labelStyle: CSSProperties = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px", fontFamily: "monospace" };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryBtn: CSSProperties = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryBtn: CSSProperties = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
