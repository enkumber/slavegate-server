/**
 * pages/TokenManagement.tsx
 * Token management page — list, generate, revoke API tokens.
 */

import { useState, useEffect, useCallback } from "react";
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

export function TokenManagement() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

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

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", fontSize: "22px", fontFamily: "monospace", margin: 0 }}>
          🔑 API Tokens
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
        <div style={{ background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: "8px", overflow: "hidden" }}>
          <TokenTable tokens={tokens} onRevoked={fetchTokens} />
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
