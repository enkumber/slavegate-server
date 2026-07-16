/**
 * pages/TokenManagement.tsx
 * Token management + Model configuration page.
 */

import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { api } from "../api/client";
import {
  buildCredentialRequest,
  credentialSummary,
  draftFromConfig,
  modelConfigApi,
  modelRoles,
  roleLabel,
  type CredentialMode,
  type ModelConfigDraft,
  type ModelRole,
  type RedactedModelConfig,
} from "../api/modelConfig";
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

export function TokenManagement() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  // Model config state
  const [modelConfigs, setModelConfigs] = useState<Record<ModelRole, RedactedModelConfig | null>>({ decision_llm: null, vision_vlm: null });
  const [modelDrafts, setModelDrafts] = useState<Record<ModelRole, ModelConfigDraft>>({ decision_llm: draftFromConfig(null), vision_vlm: draftFromConfig(null) });
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
      const rows = await modelConfigApi.list();
      const next: Record<ModelRole, RedactedModelConfig | null> = { decision_llm: null, vision_vlm: null };
      const nextDrafts: Record<ModelRole, ModelConfigDraft> = { decision_llm: draftFromConfig(null), vision_vlm: draftFromConfig(null) };
      for (const row of rows) {
        next[row.role] = row;
        nextDrafts[row.role] = draftFromConfig(row);
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

  async function saveModel(role: ModelRole) {
    setModelMsg(null);
    const draft = modelDrafts[role];
    try {
      let updated = await modelConfigApi.update(role, draft);
      const credentialRequest = buildCredentialRequest(draft);
      if (credentialRequest) updated = await modelConfigApi.updateCredential(role, credentialRequest);
      setModelConfigs((prev) => ({ ...prev, [role]: updated }));
      setModelDrafts((prev) => ({ ...prev, [role]: draftFromConfig(updated) }));
      setModelMsg(`${roleLabel(role)} saved`);
    } catch (err) {
      setModelMsg((err as Error).message);
    }
  }

  async function testModel(role: ModelRole) {
    setModelMsg(null);
    try {
      const updated = await modelConfigApi.test(role);
      setModelConfigs((prev) => ({ ...prev, [role]: updated }));
      setModelDrafts((prev) => ({ ...prev, [role]: draftFromConfig(updated) }));
      setModelMsg(`${roleLabel(role)} connection OK`);
    } catch (err) {
      await fetchModels();
      setModelMsg((err as Error).message);
    }
  }

  function updateDraft<K extends keyof ModelConfigDraft>(role: ModelRole, key: K, value: ModelConfigDraft[K]) {
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
        <div style={{ background: "#1a1a2e", border: "1px solid #3a3a5a", padding: "10px", borderRadius: "6px", marginBottom: "16px", color: modelMsg.includes("OK") || modelMsg.includes("saved") ? "#8be28b" : "#ff9a9a", fontFamily: "monospace", fontSize: "13px" }}>
          {modelMsg}
        </div>
      )}

      {modelLoading ? (
        <div style={{ color: "#777", fontFamily: "monospace" }}>Loading models…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "16px" }}>
          {modelRoles.map((role) => {
            const draft = modelDrafts[role];
            const config = modelConfigs[role];
            const testStatus = config?.lastTestStatus ?? "never";
            return (
              <section key={role} style={{ background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", padding: "18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", marginBottom: "12px" }}>
                  <h3 style={{ fontSize: "16px", margin: 0, color: "#fff", fontFamily: "monospace" }}>
                    {role === "decision_llm" ? "Decision LLM" : "Vision VLM"}
                  </h3>
                  <span style={statusPill(config)}>{statusLabel(config)}</span>
                </div>
                {!config && <div style={warningBox}>Missing server row. Saving creates the role with disabled-safe defaults.</div>}
                {config && !config.enabled && <div style={warningBox}>Disabled. Runtime calls fail closed until this role is enabled.</div>}
                <label style={labelStyle}>
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => updateDraft(role, "enabled", e.target.checked)} /> Enabled
                </label>
                <MField label="Provider" value={draft.provider} onChange={(v) => updateDraft(role, "provider", v)} placeholder="openai_compatible" />
                <MField label="Endpoint" value={draft.endpoint} onChange={(v) => updateDraft(role, "endpoint", v)} placeholder="https://host/v1" />
                <MField label="Model" value={draft.model} onChange={(v) => updateDraft(role, "model", v)} placeholder="model name" />
                <CredentialModePicker
                  value={draft.credentialMode}
                  onChange={(mode) => updateDraft(role, "credentialMode", mode)}
                />
                {draft.credentialMode === "replace" && (
                  <MField label="New API key/token" type="password" value={draft.credential} onChange={(v) => updateDraft(role, "credential", v)} placeholder="paste token; it is never shown again" />
                )}
                {draft.credentialMode === "reference" && (
                  <MField label="Credential reference" value={draft.credentialRef} onChange={(v) => updateDraft(role, "credentialRef", v)} placeholder="env:VAR_NAME or file:/path" />
                )}
                {draft.credentialMode === "clear" && <div style={dangerBox}>Saving clears the server-side credential for this role.</div>}
                <div style={{ color: "#888", fontSize: "11px", margin: "8px 0 14px", fontFamily: "monospace" }}>
                  Credential: {credentialSummary(config)} · Version: {config?.version ?? "-"}<br />
                  Last test: {testStatus} {config?.lastTestAt ? `@ ${new Date(config.lastTestAt).toLocaleString()}` : ""}
                  {config?.lastTestMessage && <span><br />{config.lastTestMessage}</span>}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button style={primaryBtn} onClick={() => saveModel(role)}>Save</button>
                  <button style={secondaryBtn} onClick={() => testModel(role)} disabled={!config} title={!config ? "Save the role before testing" : "Test provider connection"}>Test</button>
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

function CredentialModePicker({ value, onChange }: { value: CredentialMode; onChange: (mode: CredentialMode) => void }) {
  const options: Array<{ mode: CredentialMode; label: string }> = [
    { mode: "retain", label: "Retain" },
    { mode: "replace", label: "Replace" },
    { mode: "reference", label: "Reference" },
    { mode: "clear", label: "Clear" },
  ];
  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Credential action</legend>
      <div style={segmentedStyle}>
        {options.map((option) => {
          const selected = value === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              onClick={() => onChange(option.mode)}
              aria-pressed={selected}
              style={selected ? segmentActive : segmentButton}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const labelStyle: CSSProperties = { display: "block", color: "#ccc", fontSize: "13px", marginBottom: "10px", fontFamily: "monospace" };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: "5px", padding: "9px", background: "#0f0f23", color: "#fff", border: "1px solid #33385a", borderRadius: "4px", fontFamily: "monospace" };
const primaryBtn: CSSProperties = { background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontWeight: 600 };
const secondaryBtn: CSSProperties = { background: "transparent", border: "1px solid #4a9eff", color: "#9ecbff", padding: "8px 16px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace" };
const fieldsetStyle: CSSProperties = { border: "0", padding: 0, margin: "0 0 10px" };
const legendStyle: CSSProperties = { color: "#ccc", fontSize: "13px", marginBottom: "5px", fontFamily: "monospace", padding: 0 };
const segmentedStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "4px" };
const segmentButton: CSSProperties = { background: "#0f0f23", border: "1px solid #33385a", color: "#c8d2ef", padding: "8px 6px", borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px" };
const segmentActive: CSSProperties = { ...segmentButton, background: "#27456f", border: "1px solid #4a9eff", color: "#fff" };
const warningBox: CSSProperties = { background: "#2a2412", border: "1px solid #6b5520", color: "#ffd783", padding: "8px", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace", marginBottom: "12px" };
const dangerBox: CSSProperties = { background: "#32181e", border: "1px solid #7a2e3d", color: "#ffb4bf", padding: "8px", borderRadius: "4px", fontSize: "12px", fontFamily: "monospace", marginBottom: "10px" };

function statusLabel(config: RedactedModelConfig | null): string {
  if (!config) return "missing";
  if (!config.enabled) return "disabled";
  if (!(config.credentialConfigured ?? config.hasCredential)) return "credential missing";
  if (config.lastTestStatus === "ok") return "test ok";
  if (config.lastTestStatus === "error") return "test error";
  return "not tested";
}

function statusPill(config: RedactedModelConfig | null): CSSProperties {
  const label = statusLabel(config);
  const color = label === "test ok" ? "#8be28b" : label === "test error" || label.includes("missing") ? "#ff9a9a" : "#ffd783";
  return {
    border: `1px solid ${color}`,
    color,
    borderRadius: "999px",
    padding: "3px 8px",
    fontFamily: "monospace",
    fontSize: "11px",
    whiteSpace: "nowrap",
  };
}
