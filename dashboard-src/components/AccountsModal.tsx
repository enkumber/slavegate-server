/**
 * AccountsModal.tsx
 * Modal for managing accounts on a device — list, add, edit status, delete.
 */

import { useState, useEffect, useCallback } from "react";
import { accountsApi, Account } from "../api/accounts";
import { agencyApi, Client } from "../api/agency";

// ─── Platform Config ──────────────────────────────────────────────────────────

const PLATFORMS: { value: Account["platform"]; label: string; icon: string; color: string }[] = [
  { value: "instagram", label: "Instagram", icon: "📸", color: "#E1306C" },
  { value: "tiktok", label: "TikTok", icon: "🎵", color: "#00f2ea" },
  { value: "facebook", label: "Facebook", icon: "📘", color: "#1877F2" },
  { value: "twitter", label: "Twitter", icon: "🐦", color: "#1DA1F2" },
  { value: "reddit", label: "Reddit", icon: "🔗", color: "#FF4500" },
];

const STATUS_CONFIG: Record<Account["status"], { color: string; bg: string; label: string }> = {
  created: { color: "#9ca3af", bg: "#1f1f1f", label: "Created" },
  active: { color: "#4ade80", bg: "#0d3320", label: "Active" },
  paused: { color: "#fbbf24", bg: "#3d3d00", label: "Paused" },
  blocked: { color: "#f87171", bg: "#3d1515", label: "Blocked" },
  warming: { color: "#60a5fa", bg: "#1e3a5f", label: "Warming" },
  cooldown: { color: "#c4b5fd", bg: "#2e1065", label: "Cooldown" },
};

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Account["status"] }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "10px",
        fontWeight: 500,
        background: config.bg,
        color: config.color,
        textTransform: "uppercase",
      }}
    >
      {config.label}
    </span>
  );
}

// ─── Platform Badge ───────────────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform: Account["platform"] }) {
  const p = PLATFORMS.find((x) => x.value === platform) || PLATFORMS[0];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "10px",
        background: `${p.color}20`,
        color: p.color,
      }}
    >
      {p.icon} {p.label}
    </span>
  );
}

// ─── Add Account Form ─────────────────────────────────────────────────────────

interface AddAccountFormProps {
  deviceId: string;
  clients: Client[];
  onAdd: () => void;
  onCancel: () => void;
}

function AddAccountForm({ deviceId, clients, onAdd, onCancel }: AddAccountFormProps) {
  const [platform, setPlatform] = useState<Account["platform"]>("instagram");
  const [username, setUsername] = useState("");
  const [type, setType] = useState<Account["type"]>("farming");
  const [clientId, setClientId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError("Username is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await accountsApi.create({
        deviceId,
        platform,
        username: username.trim().replace(/^@/, ""),
        type,
        clientId: clientId || undefined,
      });
      onAdd();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ padding: "16px", background: "#0a0a0a", borderRadius: "8px" }}>
      <h4 style={{ color: "#fff", margin: "0 0 16px 0", fontSize: "14px" }}>Add Account</h4>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
        {/* Platform */}
        <div>
          <label style={{ display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }}>
            Platform
          </label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Account["platform"])}
            style={{
              width: "100%",
              padding: "8px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "4px",
              color: "#fff",
              fontSize: "12px",
            }}
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.icon} {p.label}
              </option>
            ))}
          </select>
        </div>

        {/* Type */}
        <div>
          <label style={{ display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }}>
            Type
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as Account["type"])}
            style={{
              width: "100%",
              padding: "8px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "4px",
              color: "#fff",
              fontSize: "12px",
            }}
          >
            <option value="farming">🌱 Farming</option>
            <option value="business">💼 Business</option>
          </select>
        </div>
      </div>

      {/* Username */}
      <div style={{ marginBottom: "12px" }}>
        <label style={{ display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }}>
          Username
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="@username"
          style={{
            width: "100%",
            padding: "8px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "12px",
            fontFamily: "monospace",
          }}
        />
      </div>

      {/* Client (optional) */}
      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", color: "#888", fontSize: "11px", marginBottom: "4px" }}>
          Client (optional)
        </label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{
            width: "100%",
            padding: "8px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "12px",
          }}
        >
          <option value="">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div style={{ color: "#f87171", fontSize: "12px", marginBottom: "12px" }}>⚠️ {error}</div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "8px 16px",
            background: "#333",
            border: "none",
            borderRadius: "4px",
            color: "#ccc",
            cursor: "pointer",
            fontSize: "12px",
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          style={{
            padding: "8px 16px",
            background: saving ? "#444" : "#2563eb",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: "12px",
          }}
        >
          {saving ? "Adding..." : "Add Account"}
        </button>
      </div>
    </form>
  );
}

// ─── Account Row ──────────────────────────────────────────────────────────────

interface AccountRowProps {
  account: Account;
  onStatusChange: (id: string, status: Account["status"]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function AccountRow({ account, onStatusChange, onDelete }: AccountRowProps) {
  const [acting, setActing] = useState(false);

  const handleStatusChange = async (newStatus: Account["status"]) => {
    setActing(true);
    try {
      await onStatusChange(account.id, newStatus);
    } finally {
      setActing(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete account @${account.username}?`)) return;
    setActing(true);
    try {
      await onDelete(account.id);
    } finally {
      setActing(false);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto auto",
        gap: "12px",
        alignItems: "center",
        padding: "12px",
        background: "#111",
        borderRadius: "6px",
        border: "1px solid #222",
        opacity: acting ? 0.6 : 1,
      }}
    >
      {/* Account info */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ color: "#fff", fontSize: "13px", fontFamily: "monospace" }}>
            @{account.username}
          </span>
          <PlatformBadge platform={account.platform} />
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <StatusBadge status={account.status} />
          <span style={{ color: "#666", fontSize: "10px" }}>
            {account.type === "business" ? "💼" : "🌱"} {account.type}
          </span>
        </div>
      </div>

      {/* Status actions */}
      <select
        value={account.status}
        onChange={(e) => handleStatusChange(e.target.value as Account["status"])}
        disabled={acting}
        style={{
          padding: "6px 10px",
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: "4px",
          color: "#ccc",
          fontSize: "11px",
          cursor: acting ? "not-allowed" : "pointer",
        }}
      >
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="warming">Warming</option>
        <option value="cooldown">Cooldown</option>
        <option value="blocked">Blocked</option>
      </select>

      {/* Delete */}
      <button
        onClick={handleDelete}
        disabled={acting}
        style={{
          padding: "6px 10px",
          background: "transparent",
          border: "1px solid #7f1d1d",
          borderRadius: "4px",
          color: "#f87171",
          cursor: acting ? "not-allowed" : "pointer",
          fontSize: "11px",
        }}
      >
        🗑️
      </button>
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

interface AccountsModalProps {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}

export function AccountsModal({ deviceId, deviceName, onClose }: AccountsModalProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [accountsData, clientsData] = await Promise.all([
        accountsApi.list({ deviceId, pageSize: 50 }),
        agencyApi.clients.list({ active: true, pageSize: 100 }),
      ]);
      setAccounts(accountsData.items);
      setClients(clientsData.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleStatusChange = async (id: string, status: Account["status"]) => {
    try {
      await accountsApi.updateStatus(id, status);
      await fetchData();
    } catch (e) {
      alert(`Failed to update status: ${(e as Error).message}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await accountsApi.delete(id);
      await fetchData();
    } catch (e) {
      alert(`Failed to delete: ${(e as Error).message}`);
    }
  };

  const handleAdd = () => {
    setShowAddForm(false);
    fetchData();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#0a0a0a",
          borderRadius: "12px",
          border: "1px solid #333",
          width: "600px",
          maxHeight: "80vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #222",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <h3 style={{ color: "#fff", margin: 0, fontSize: "16px" }}>
              📱 Accounts
            </h3>
            <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>
              {deviceName}
            </div>
          </div>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              style={{
                padding: "6px 14px",
                background: showAddForm ? "#333" : "#2563eb",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                cursor: "pointer",
                fontSize: "12px",
              }}
            >
              {showAddForm ? "Cancel" : "+ Add"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "#666",
                fontSize: "20px",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {/* Add form */}
          {showAddForm && (
            <div style={{ marginBottom: "16px" }}>
              <AddAccountForm
                deviceId={deviceId}
                clients={clients}
                onAdd={handleAdd}
                onCancel={() => setShowAddForm(false)}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ color: "#f87171", fontSize: "12px", marginBottom: "16px" }}>
              ⚠️ {error}
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div style={{ color: "#666", textAlign: "center", padding: "24px" }}>Loading...</div>
          ) : accounts.length === 0 ? (
            <div style={{ color: "#666", textAlign: "center", padding: "24px" }}>
              No accounts on this device yet.
              <br />
              <button
                onClick={() => setShowAddForm(true)}
                style={{
                  marginTop: "12px",
                  padding: "8px 16px",
                  background: "#2563eb",
                  border: "none",
                  borderRadius: "4px",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: "12px",
                }}
              >
                + Add first account
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer stats */}
        {accounts.length > 0 && (
          <div
            style={{
              padding: "12px 20px",
              borderTop: "1px solid #222",
              display: "flex",
              gap: "16px",
              fontSize: "11px",
              color: "#666",
            }}
          >
            <span>Total: {accounts.length}</span>
            <span style={{ color: "#4ade80" }}>
              Active: {accounts.filter((a) => a.status === "active").length}
            </span>
            <span style={{ color: "#fbbf24" }}>
              Paused: {accounts.filter((a) => a.status === "paused").length}
            </span>
            <span style={{ color: "#f87171" }}>
              Blocked: {accounts.filter((a) => a.status === "blocked").length}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
