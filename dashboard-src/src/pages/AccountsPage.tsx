/**
 * AccountsPage.tsx
 * Agency accounts management — list, filter, add, edit status, delete.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { accountsApi, Account } from "../api/accounts";
import { agencyApi, Client } from "../api/agency";
import { api } from "../api/client";
import { statusCounts, statusLabel, statusStyle } from "../utils/statusPresentation";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Device {
  id: string;
  friendlyName: string | null;
  model: string;
  status: string;
}

// ─── Platform Config ──────────────────────────────────────────────────────────

const PLATFORMS: { value: Account["platform"]; label: string; icon: string; color: string }[] = [
  { value: "instagram", label: "Instagram", icon: "📸", color: "#E1306C" },
  { value: "tiktok", label: "TikTok", icon: "🎵", color: "#00f2ea" },
  { value: "facebook", label: "Facebook", icon: "📘", color: "#1877F2" },
  { value: "twitter", label: "Twitter", icon: "🐦", color: "#1DA1F2" },
  { value: "reddit", label: "Reddit", icon: "🔗", color: "#FF4500" },
];

// ─── Badges ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Account["status"] }) {
  const config = statusStyle(status);
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "10px",
        fontWeight: 500,
        background: config.bg,
        color: config.color,
        textTransform: "uppercase",
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

function PlatformBadge({ platform }: { platform: Account["platform"] }) {
  const p = PLATFORMS.find((x) => x.value === platform) || PLATFORMS[0];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "12px",
        color: p.color,
      }}
    >
      {p.icon}
    </span>
  );
}

function TypeBadge({ type }: { type: Account["type"] }) {
  const config = type === "business" 
    ? { icon: "💼", label: "Business", color: "#a78bfa" }
    : { icon: "🌱", label: "Farming", color: "#4ade80" };
  return (
    <span style={{ fontSize: "11px", color: config.color }}>
      {config.icon} {config.label}
    </span>
  );
}

// ─── Add Account Modal ────────────────────────────────────────────────────────

interface AddAccountModalProps {
  clients: Client[];
  devices: Device[];
  onAdd: () => void;
  onClose: () => void;
}

function AddAccountModal({ clients, devices, onAdd, onClose }: AddAccountModalProps) {
  const [platform, setPlatform] = useState<Account["platform"]>("instagram");
  const [username, setUsername] = useState("");
  const [clientId, setClientId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Type is derived from client selection and client type
  const selectedClient = clients.find(c => c.id === clientId);
  const type = selectedClient?.type === 'client' ? 'business' : 'farming';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (!deviceId) {
      setError("Device is required");
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
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
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
          background: "#111",
          borderRadius: "12px",
          border: "1px solid #333",
          width: "450px",
          padding: "24px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ color: "#fff", margin: "0 0 20px 0", fontSize: "16px" }}>
          Add Account
        </h3>

        <form onSubmit={handleSubmit}>
          {/* Device (required) */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }}>
              Device *
            </label>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "13px",
              }}
            >
              <option value="">Select device...</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.friendlyName || d.model} · {statusLabel(d.status)}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
            {/* Platform */}
            <div>
              <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }}>
                Platform
              </label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as Account["platform"])}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: "6px",
                  color: "#fff",
                  fontSize: "13px",
                }}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.icon} {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Type (auto-derived) */}
            <div>
              <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }}>
                Type
              </label>
              <div style={{ 
                padding: "10px 12px", 
                background: "#1a1a1a", 
                borderRadius: "6px",
                color: type === 'business' ? "#60a5fa" : "#4ade80",
                fontSize: "13px",
              }}>
                {type === 'business' ? "💼 Business" : "🌱 Farming"}
                <span style={{ color: "#666", marginLeft: "8px", fontSize: "11px" }}>
                  (auto: {selectedClient ? `${selectedClient.type} selected` : "no client"})
                </span>
              </div>
            </div>
          </div>

          {/* Username */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }}>
              Username *
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@username"
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "13px",
                fontFamily: "monospace",
              }}
            />
          </div>

          {/* Client (optional) */}
          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "6px" }}>
              Client (optional)
            </label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "13px",
              }}
            >
              <option value="">🌱 No client (Farming)</option>
              <optgroup label="👥 Clients">
                {clients.filter(c => c.type === 'client').map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="🌱 Farming Profiles">
                {clients.filter(c => c.type === 'farming').map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* Error */}
          {error && (
            <div style={{ color: "#f87171", fontSize: "12px", marginBottom: "16px" }}>
              ⚠️ {error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "10px 20px",
                background: "#333",
                border: "none",
                borderRadius: "6px",
                color: "#ccc",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "10px 20px",
                background: saving ? "#444" : "#2563eb",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                cursor: saving ? "not-allowed" : "pointer",
                fontSize: "13px",
              }}
            >
              {saving ? "Adding..." : "Add Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Account Row ──────────────────────────────────────────────────────────────

interface AccountRowProps {
  account: Account & { client_name?: string; device_name?: string };
  onStatusChange: (id: string, status: Account["status"]) => void;
  onDelete: (id: string) => void;
}

function AccountRow({ account, onStatusChange, onDelete }: AccountRowProps) {
  const handleDelete = () => {
    if (confirm(`Delete account @${account.username}?`)) {
      onDelete(account.id);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 140px 140px 100px 100px 100px auto",
        gap: "12px",
        alignItems: "center",
        padding: "14px 16px",
        background: "#111",
        borderRadius: "6px",
        border: "1px solid #222",
      }}
    >
      {/* Username + Platform */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <PlatformBadge platform={account.platform} />
        <span style={{ color: "#fff", fontSize: "13px", fontFamily: "monospace" }}>
          @{account.username}
        </span>
      </div>

      {/* Client */}
      <div style={{ color: account.client_name ? "#ccc" : "#555", fontSize: "12px" }}>
        {account.client_name || "—"}
      </div>

      {/* Device */}
      <div style={{ color: "#888", fontSize: "12px" }}>
        {account.device_name || account.deviceId?.slice(0, 8) || "—"}
      </div>

      {/* Status */}
      <div>
        <StatusBadge status={account.status} />
      </div>

      {/* Type */}
      <div>
        <TypeBadge type={account.type} />
      </div>

      {/* Created */}
      <div style={{ color: "#666", fontSize: "11px" }}>
        {new Date(account.createdAt).toLocaleDateString()}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <select
          value={account.status}
          onChange={(e) => onStatusChange(account.id, e.target.value as Account["status"])}
          style={{
            padding: "6px 10px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "4px",
            color: "#ccc",
            fontSize: "11px",
            cursor: "pointer",
          }}
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="warming">Warming</option>
          <option value="cooldown">Cooldown</option>
          <option value="blocked">Blocked</option>
        </select>
        <button
          onClick={handleDelete}
          style={{
            padding: "6px 10px",
            background: "transparent",
            border: "1px solid #7f1d1d",
            borderRadius: "4px",
            color: "#f87171",
            cursor: "pointer",
            fontSize: "11px",
          }}
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function AccountsPage() {
  const [accounts, setAccounts] = useState<(Account & { client_name?: string; device_name?: string })[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  // Filters
  const [clientFilter, setClientFilter] = useState("");
  const [deviceFilter, setDeviceFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Stats
  const stats = statusCounts(accounts, (account) => account.status);

  const fetchData = useCallback(async () => {
    try {
      const [accountsData, clientsData, farmingData, devicesData] = await Promise.all([
        accountsApi.list({
          clientId: clientFilter || undefined,
          deviceId: deviceFilter || undefined,
          platform: platformFilter || undefined,
          status: statusFilter || undefined,
          pageSize: 200,
        }),
        agencyApi.clients.list({ pageSize: 100, type: 'client' }),
        agencyApi.clients.list({ pageSize: 100, type: 'farming' }),
        api.get<{ items: Device[]; total: number }>("/devices"),
      ]);

      // Combine clients and farming profiles for the dropdown
      const allClients = [...clientsData.items, ...farmingData.items];

      // Extract devices from paginated response
      const devicesList = devicesData?.items || [];

      // Map client and device names to accounts
      const clientMap = new Map(allClients.map((c) => [c.id, c.name]));
      const deviceMap = new Map(
        devicesList.map((d: Device) => [
          d.id,
          d.friendlyName || d.model,
        ])
      );

      const enrichedAccounts = accountsData.items.map((a) => ({
        ...a,
        client_name: a.clientId ? clientMap.get(a.clientId) : undefined,
        device_name: a.deviceId ? deviceMap.get(a.deviceId) : undefined,
      }));

      setAccounts(enrichedAccounts);
      setClients(allClients);
      setDevices(devicesList);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [clientFilter, deviceFilter, platformFilter, statusFilter]);

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

  return (
    <AgencyLayout currentRoute="#/agency/accounts">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
        <div>
          <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>📱 Accounts</h1>
          <p style={{ color: "#666", margin: "8px 0 0", fontSize: "13px" }}>
            Manage social media accounts across all devices
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          style={{
            padding: "10px 20px",
            background: "#2563eb",
            border: "none",
            borderRadius: "6px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: 500,
          }}
        >
          + Add Account
        </button>
      </div>

      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "24px",
          flexWrap: "wrap",
        }}
      >
        {[
          { key: "", label: "All", count: accounts.length, color: "#a78bfa" },
          ...stats.map(({ status, count }) => ({
            key: status,
            label: statusLabel(status),
            count,
            color: statusStyle(status).color,
          })),
        ].map((stat) => (
          <div
            key={stat.key}
            onClick={() => setStatusFilter(stat.key)}
            style={{
              padding: "12px 24px",
              background: statusFilter === stat.key ? "#1a1a2e" : "#111",
              border: `1px solid ${statusFilter === stat.key ? "#333" : "#222"}`,
              borderRadius: "8px",
              cursor: "pointer",
              textAlign: "center",
              minWidth: "90px",
            }}
          >
            <div style={{ color: stat.color, fontSize: "22px", fontWeight: 600 }}>{stat.count}</div>
            <div style={{ color: "#888", fontSize: "11px" }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "13px",
            minWidth: "150px",
          }}
        >
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={deviceFilter}
          onChange={(e) => setDeviceFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "13px",
            minWidth: "150px",
          }}
        >
          <option value="">All Devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.friendlyName || d.model}
            </option>
          ))}
        </select>

        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "13px",
          }}
        >
          <option value="">All Platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.icon} {p.label}
            </option>
          ))}
        </select>

        <button
          onClick={fetchData}
          style={{
            padding: "8px 16px",
            background: "#1a1a2e",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            cursor: "pointer",
            fontSize: "13px",
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Table header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "200px 140px 140px 100px 100px 100px auto",
          gap: "12px",
          padding: "10px 16px",
          color: "#666",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          marginBottom: "8px",
        }}
      >
        <div>Account</div>
        <div>Client</div>
        <div>Device</div>
        <div>Status</div>
        <div>Type</div>
        <div>Created</div>
        <div style={{ textAlign: "right" }}>Actions</div>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "12px 16px",
            background: "#2a1515",
            borderRadius: "6px",
            color: "#f88",
            marginBottom: "16px",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>Loading...</div>
      ) : accounts.length === 0 ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>
          No accounts found.
          <br />
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              marginTop: "16px",
              padding: "10px 20px",
              background: "#2563eb",
              border: "none",
              borderRadius: "6px",
              color: "#fff",
              cursor: "pointer",
              fontSize: "13px",
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

      {/* Add Modal */}
      {showAddModal && (
        <AddAccountModal
          clients={clients}
          devices={devices}
          onAdd={fetchData}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </AgencyLayout>
  );
}
