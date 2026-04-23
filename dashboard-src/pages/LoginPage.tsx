/**
 * LoginPage.tsx
 * JWT login form — single admin user (Phase 4 adds proper user management).
 */

import { useState } from "react";
import { api } from "../api/client";

interface Props {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.login(username, password);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: "#0f0f23", fontFamily: "monospace",
    }}>
      <form onSubmit={handleSubmit} style={{
        background: "#1a1a2e", border: "1px solid #334155", borderRadius: "10px",
        padding: "32px", width: "320px", color: "#e2e8f0",
      }}>
        <h1 style={{ margin: "0 0 24px", fontSize: "18px", textAlign: "center" }}>
          ⚡ Phone Network
        </h1>

        <label style={{ fontSize: "12px", color: "#94a3b8" }}>Username</label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          required
          style={inputStyle}
        />

        <label style={{ fontSize: "12px", color: "#94a3b8", display: "block", marginTop: "12px" }}>Password</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          style={inputStyle}
        />

        {error && (
          <div style={{ marginTop: "10px", color: "#ef4444", fontSize: "12px" }}>
            ❌ {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            display: "block", width: "100%", marginTop: "20px",
            background: "#3b82f6", border: "none", color: "#fff",
            padding: "10px", borderRadius: "6px", fontFamily: "monospace",
            fontSize: "14px", cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", marginTop: "4px",
  background: "#0f0f23", border: "1px solid #334155", color: "#e2e8f0",
  padding: "8px", borderRadius: "4px", fontFamily: "monospace",
  fontSize: "13px", boxSizing: "border-box",
};
