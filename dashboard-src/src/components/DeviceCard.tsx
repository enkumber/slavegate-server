/**
 * DeviceCard.tsx
 * Single device card — status indicator, health metrics, quick actions.
 * Supports inline rename: click friendly name → edit → Enter/blur saves, Escape cancels.
 */

import { useState, useRef, useEffect } from "react";
import { api } from "../api/client";
import type { Device } from "../../../shared/protocol/api-types";
import { statusLabel, statusStyle } from "../utils/statusPresentation";

type DeviceCardHealth = NonNullable<Device["health"]> & {
  publicIp?: string;
  connectionType?: "wireguard" | "relay" | string;
};

interface Props {
  device: Device;
  accountsCount?: number;   // number of accounts on this device
  onApprove?: (id: string) => void;
  onDispatchJob?: (device: Device) => void;
  onHumanWorkflow?: (device: Device) => void;
  onRevoke?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRenamed?: () => void;   // optional refresh callback after rename
  onOtaPush?: (deviceId: string) => void;  // push OTA to single device
  onAccountsClick?: (device: Device) => void;  // open accounts modal
}

export function DeviceCard({ device, accountsCount, onApprove, onDispatchJob, onHumanWorkflow, onRevoke, onDelete, onRenamed, onOtaPush, onAccountsClick }: Props) {
  const health = device.health as DeviceCardHealth | undefined;
  const statusColor = statusStyle(device.status).color;

  // ─── Inline rename state ──────────────────────────────────────────────────
  const [editing, setEditing]   = useState(false);
  const [draft, setDraft]       = useState(device.friendlyName ?? "");
  const [saving, setSaving]     = useState(false);
  const inputRef                = useRef<HTMLInputElement>(null);

  // Sync draft if parent updates device
  useEffect(() => {
    if (!editing) setDraft(device.friendlyName ?? "");
  }, [device.friendlyName, editing]);

  // Focus + select all when entering edit mode
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(device.friendlyName ?? "");
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(device.friendlyName ?? "");
    setEditing(false);
  };

  const commitEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === device.friendlyName) { cancelEdit(); return; }
    setSaving(true);
    try {
      await api.patch(`/devices/${device.id}`, { friendlyName: trimmed });
      setEditing(false);
      onRenamed?.();
    } catch (e) {
      alert(`Rename failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      border: `2px solid ${statusColor}`,
      borderRadius: "8px",
      padding: "12px 16px",
      background: "#1a1a2e",
      color: "#e2e8f0",
      minWidth: "220px",
      fontFamily: "monospace",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
          <span style={{
            width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
            background: statusColor, display: "inline-block",
            boxShadow: device.statusCapabilities.dispatchable ? `0 0 6px ${statusColor}` : "none",
          }} />

          {/* ── Inline rename ────────────────────────────────────────────── */}
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              disabled={saving}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter")  commitEdit();
                if (e.key === "Escape") cancelEdit();
              }}
              onBlur={commitEdit}
              style={{
                background: "#0f172a",
                border: "1px solid #3b82f6",
                borderRadius: "4px",
                color: "#e2e8f0",
                fontFamily: "monospace",
                fontSize: "14px",
                fontWeight: "bold",
                padding: "1px 6px",
                width: "100%",
                outline: "none",
                opacity: saving ? 0.5 : 1,
              }}
            />
          ) : (
            <span
              title="Click to rename"
              onClick={startEdit}
              style={{
                fontSize: "14px", fontWeight: "bold",
                cursor: "text", display: "flex", alignItems: "center", gap: "4px",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {device.friendlyName ?? device.model ?? "Unnamed"}
              <span style={{ fontSize: "10px", color: "#475569", flexShrink: 0 }}>✏️</span>
            </span>
          )}

          {device.isCanary && (
            <span style={{ fontSize: "10px", background: "#7c3aed", padding: "2px 6px", borderRadius: "4px", flexShrink: 0 }}>
              CANARY
            </span>
          )}
        </div>
        <span style={{ fontSize: "11px", color: "#94a3b8", flexShrink: 0, marginLeft: "8px" }}>
          {statusLabel(device.status)}
        </span>
      </div>

      {/* Device info */}
      <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "8px" }}>
        <div>{device.model ?? "Unknown model"} · Android {device.androidVersion ?? "?"}</div>
        <div>Agent v{device.agentVersion ?? "?"}</div>
        {health?.publicIp && <div>🌐 Public IP: {health.publicIp}</div>}
        {health?.connectionType && (
          <div>
            🔗 Connection: {" "}
            <span style={{ color: health.connectionType === "wireguard" ? "#22c55e" : "#f59e0b" }}>
              {health.connectionType === "wireguard" ? "🛡 WireGuard" : "☁️ Relay"}
            </span>
          </div>
        )}
        {!health?.publicIp && device.lastIp && <div>IP: {device.lastIp}</div>}
        {device.lastSeenAt && (
          <div>Last seen: {new Date(device.lastSeenAt).toLocaleString()}</div>
        )}
      </div>

      {/* Health */}
      {health && (
        <div style={{ fontSize: "11px", marginBottom: "8px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <span title="Battery">🔋 {health.batteryLevel}%{health.charging ? "⚡" : ""}</span>
          <span title="Network">📡 {health.networkType}/{health.networkQuality}</span>
          <span title="Thermal" style={{
            color: health.thermalStatus === "nominal" ? "#22c55e" :
                   health.thermalStatus === "light"   ? "#f59e0b" :
                   health.thermalStatus === "moderate" ? "#f97316" : "#ef4444",
          }}>
            🌡 {health.thermalStatus}
          </span>
          <span title="Storage">💾 {Math.round(health.storageFreeBytes / 1024 / 1024)}MB free</span>
        </div>
      )}

      {/* Accounts badge */}
      {onAccountsClick && (
        <div style={{ marginBottom: "8px" }}>
          <button
            onClick={(e) => { e.stopPropagation(); onAccountsClick(device); }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              background: accountsCount && accountsCount > 0 ? "#1e3a5f" : "#1a1a2e",
              border: "1px solid #333",
              borderRadius: "4px",
              color: accountsCount && accountsCount > 0 ? "#60a5fa" : "#666",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "monospace",
            }}
          >
            📱 {accountsCount ?? 0} accounts
          </button>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {device.statusCapabilities.initial && onApprove && (
          <button onClick={() => onApprove(device.id)} style={btnStyle("#22c55e")}>
            Approve
          </button>
        )}
        {device.statusCapabilities.dispatchable && onDispatchJob && (
          <button onClick={() => onDispatchJob(device)} style={btnStyle("#3b82f6")}>
            Dispatch Job
          </button>
        )}
        {device.statusCapabilities.dispatchable && onHumanWorkflow && (
          <button onClick={() => onHumanWorkflow(device)} style={btnStyle("#0ea5e9")}>
            AI Workflow
          </button>
        )}
        {device.statusCapabilities.dispatchable && onOtaPush && (
          <button onClick={() => onOtaPush(device.id)} style={btnStyle("#8b5cf6")}>
            📦 OTA
          </button>
        )}
        {!device.statusCapabilities.administrative && onRevoke && (
          <button
            onClick={() => { if (confirm(`Revoke ${device.friendlyName}?`)) onRevoke(device.id); }}
            style={btnStyle("#ef4444")}
          >
            Revoke
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => {
              if (confirm(`⚠️ DELETE ${device.friendlyName ?? device.model}?\n\nThis will permanently remove the device and all its job history. This action cannot be undone.`)) {
                onDelete(device.id);
              }
            }}
            style={btnStyle("#dc2626")}
          >
            🗑️ Delete
          </button>
        )}
      </div>
    </div>
  );
}

const btnStyle = (color: string): React.CSSProperties => ({
  background: "transparent",
  border: `1px solid ${color}`,
  color,
  padding: "3px 10px",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "11px",
  fontFamily: "monospace",
});
