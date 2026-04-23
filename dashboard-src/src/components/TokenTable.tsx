/**
 * components/TokenTable.tsx
 * Displays API tokens in a table with revoke buttons.
 */

import { useState } from "react";
import { api } from "../api/client";

interface TokenRow {
  id: string;
  token_hash_truncated: string;
  purpose: string;
  expires_at: string;
  created_at: string;
  revoked: boolean;
}

export function TokenTable({ tokens, onRevoked }: {
  tokens: TokenRow[];
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);

  const handleRevoke = async (id: string) => {
    if (!confirm("Revoke this token? This cannot be undone.")) return;
    setRevoking(id);
    try {
      await api.delete(`/device-tokens/${id}`);
      onRevoked();
    } catch (err: any) {
      alert(err.message || "Failed to revoke");
    } finally {
      setRevoking(null);
    }
  };

  const purposeColors: Record<string, string> = {
    openclaw_agent: "#4a9eff",
    admin: "#ff6b6b",
    monitoring: "#51cf66",
  };

  if (tokens.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px", color: "#666" }}>
        No tokens found. Generate one above.
      </div>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
      <thead>
        <tr style={{ borderBottom: "1px solid #2a2a4a" }}>
          <th style={thStyle}>Hash</th>
          <th style={thStyle}>Purpose</th>
          <th style={thStyle}>Created</th>
          <th style={thStyle}>Expires</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Action</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => (
          <tr key={t.id} style={{ borderBottom: "1px solid #1a1a2e" }}>
            <td style={tdStyle}><code style={{ color: "#aaa" }}>{t.token_hash_truncated}</code></td>
            <td style={tdStyle}>
              <span style={{
                background: purposeColors[t.purpose] ?? "#888",
                color: "#fff",
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "12px",
                fontWeight: 600,
              }}>
                {t.purpose}
              </span>
            </td>
            <td style={tdStyle}>{new Date(t.created_at).toLocaleDateString()}</td>
            <td style={tdStyle}>{new Date(t.expires_at).toLocaleDateString()}</td>
            <td style={tdStyle}>
              {t.revoked
                ? <span style={{ color: "#ff6b6b" }}>Revoked</span>
                : new Date(t.expires_at) < new Date()
                  ? <span style={{ color: "#888" }}>Expired</span>
                  : <span style={{ color: "#51cf66" }}>Active</span>
              }
            </td>
            <td style={tdStyle}>
              {!t.revoked && (
                <button
                  onClick={() => handleRevoke(t.id)}
                  disabled={revoking === t.id}
                  style={{
                    background: "transparent",
                    border: "1px solid #ff6b6b",
                    color: "#ff6b6b",
                    padding: "4px 12px",
                    borderRadius: "4px",
                    cursor: revoking === t.id ? "wait" : "pointer",
                    fontSize: "12px",
                    fontFamily: "monospace",
                  }}
                >
                  {revoking === t.id ? "Revoking…" : "Revoke"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  color: "#888",
  fontWeight: 500,
  fontFamily: "monospace",
  fontSize: "12px",
  textTransform: "uppercase",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "#ccc",
};
