/**
 * components/GenerateTokenModal.tsx
 * Modal dialog for generating a new API token with purpose selection.
 */

import { useState } from "react";
import { api } from "../api/client";

interface GenerateResult {
  id: string;
  token: string;
  purpose: string;
  expires_at: string;
  created_at: string;
}

export function GenerateTokenModal({ onClose, onGenerated }: {
  onClose: () => void;
  onGenerated: () => void;
}) {
  const [purpose, setPurpose] = useState("openclaw_agent");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const data = await api.post<GenerateResult>("/device-tokens/generate", { purpose });
      setResult(data);
      onGenerated();
    } catch (err: any) {
      alert(err.message || "Failed to generate token");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (result) {
      navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000,
    }} onClick={onClose}>
      <div style={{
        background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px",
        padding: "24px", width: "480px", maxWidth: "90vw",
      }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ color: "#fff", margin: "0 0 20px 0", fontSize: "18px", fontFamily: "monospace" }}>
          🔑 Generate API Token
        </h2>

        {!result ? (
          <>
            <label style={{ color: "#888", fontSize: "13px", display: "block", marginBottom: "6px", fontFamily: "monospace" }}>
              Purpose
            </label>
            <select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", background: "#0f0f23", border: "1px solid #2a2a4a",
                color: "#fff", borderRadius: "4px", fontSize: "14px", fontFamily: "monospace",
                marginBottom: "20px",
              }}
            >
              <option value="openclaw_agent">openclaw_agent</option>
              <option value="admin">admin</option>
              <option value="monitoring">monitoring</option>
            </select>

            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
              <button onClick={handleGenerate} disabled={loading} style={genBtnStyle}>
                {loading ? "Generating…" : "Generate"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ color: "#51cf66", fontSize: "13px", fontFamily: "monospace", marginBottom: "12px" }}>
              ✅ Token generated! Copy it now — it won't be shown again.
            </p>
            <div style={{
              background: "#0f0f23", border: "1px solid #2a2a4a", borderRadius: "4px",
              padding: "12px", fontFamily: "monospace", fontSize: "13px", color: "#ccc",
              wordBreak: "break-all", marginBottom: "12px", position: "relative",
            }}>
              {result.token}
            </div>
            <div style={{ display: "flex", gap: "12px", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "#888", fontSize: "12px" }}>
                Expires: {new Date(result.expires_at).toLocaleDateString()}
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={handleCopy} style={genBtnStyle}>
                  {copied ? "✓ Copied!" : "📋 Copy"}
                </button>
                <button onClick={onClose} style={cancelBtnStyle}>Close</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const genBtnStyle: React.CSSProperties = {
  background: "#4a9eff", border: "none", color: "#fff", padding: "8px 16px",
  borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "13px",
};

const cancelBtnStyle: React.CSSProperties = {
  background: "transparent", border: "1px solid #2a2a4a", color: "#888", padding: "8px 16px",
  borderRadius: "4px", cursor: "pointer", fontFamily: "monospace", fontSize: "13px",
};
