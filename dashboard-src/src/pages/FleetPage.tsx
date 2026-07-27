/**
 * FleetPage.tsx
 * Main fleet view — devices grouped by physical location.
 * Includes "Pending Approval" section with Approve/Block actions.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { DeviceCard } from "../components/DeviceCard";
import { AccountsModal } from "../components/AccountsModal";
import { HumanWorkflowModal } from "../components/HumanWorkflowModal";
import { api } from "../api/client";
import { accountsApi, Account } from "../api/accounts";
import type { Device } from "../../../shared/protocol/api-types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApproveModal {
  device: Device;
}

interface JobDispatchModalState {
  device: Device;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FleetPage() {
  const [grouped, setGrouped]         = useState<Record<string, Device[]>>({});
  const [pending, setPending]         = useState<Device[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [approveModal, setApproveModal] = useState<ApproveModal | null>(null);
  const [dispatchModal, setDispatchModal] = useState<JobDispatchModalState | null>(null);
  const [accountsModal, setAccountsModal] = useState<Device | null>(null);
  const [humanWorkflowDevice, setHumanWorkflowDevice] = useState<Device | null>(null);
  const [accountsCounts, setAccountsCounts] = useState<Record<string, number>>({});
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // ─── Fetch fleet (grouped) ──────────────────────────────────────────────────

  const fetchFleet = useCallback(async () => {
    try {
      const data = await api.get<Record<string, Device[]>>("/devices?grouped=true");
      setGrouped(data);
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Fetch pending — separate call, faster poll ─────────────────────────────

  const fetchPending = useCallback(async () => {
    try {
      const data = await api.get<{ items: Device[] }>("/devices?status=pending");
      setPending(data.items ?? []);
    } catch { /* non-fatal — fleet still shows */ }
  }, []);

  // ─── Fetch accounts counts per device ─────────────────────────────────────

  const fetchAccountsCounts = useCallback(async () => {
    try {
      // Fetch all accounts and group by deviceId
      const data = await accountsApi.list({ pageSize: 500 });
      const counts: Record<string, number> = {};
      for (const account of data.items) {
        if (account.deviceId) {
          counts[account.deviceId] = (counts[account.deviceId] || 0) + 1;
        }
      }
      setAccountsCounts(counts);
    } catch { /* non-fatal */ }
  }, []);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchFleet(), fetchPending(), fetchAccountsCounts()]);
  }, [fetchFleet, fetchPending, fetchAccountsCounts]);

  // Fleet: 15s poll. Pending: 10s poll (devices can appear any time).
  useEffect(() => {
    fetchAll();
    const fleetInterval   = setInterval(fetchFleet,   15_000);
    const pendingInterval = setInterval(fetchPending, 10_000);
    return () => { clearInterval(fleetInterval); clearInterval(pendingInterval); };
  }, [fetchAll, fetchFleet, fetchPending]);

  // ─── Approve ────────────────────────────────────────────────────────────────

  const handleApprove = async (deviceId: string, friendlyName: string) => {
    await api.post(`/devices/${deviceId}/approve`, { friendlyName });
    setApproveModal(null);
    await fetchAll();
  };

  // ─── Block ──────────────────────────────────────────────────────────────────

  const handleBlock = async (deviceId: string) => {
    if (!confirm("Block this device? It will be disconnected immediately.")) return;
    await api.post(`/devices/${deviceId}/block`, { reason: "Blocked by admin" });
    await fetchAll();
  };

  // ─── Revoke ─────────────────────────────────────────────────────────────────

  const handleRevoke = async (deviceId: string) => {
    try {
      await api.post(`/devices/${deviceId}/revoke`);
      await fetchAll();
    } catch (e) {
      alert(`Revoke failed: ${(e as Error).message}`);
    }
  };

  // ─── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async (deviceId: string) => {
    try {
      await api.delete(`/devices/${deviceId}`);
      await fetchAll();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  };

  // ─── OTA Push ───────────────────────────────────────────────────────────────

  const [otaPushing, setOtaPushing] = useState(false);

  const handleOtaPush = async (deviceIds?: string[]) => {
    const target = deviceIds ? `${deviceIds.length} device(s)` : "all online devices";
    if (!confirm(`Push OTA update to ${target}?`)) return;
    
    setOtaPushing(true);
    try {
      const res = await api.post<{ count: number; version: string; versionCode: number }>("/ota/push", { 
        deviceIds,
      });
      alert(`✅ OTA ${res.version} (${res.versionCode}) pushed to ${res.count} device(s)`);
    } catch (e) {
      alert(`OTA failed: ${(e as Error).message}`);
    } finally {
      setOtaPushing(false);
    }
  };

  const handleOtaPushSingle = (deviceId: string) => handleOtaPush([deviceId]);

  // ─── Stats ──────────────────────────────────────────────────────────────────

  const allDevices = Object.values(grouped).flat();
  const online     = allDevices.filter(d => d.statusCapabilities.dispatchable).length;
  const total      = allDevices.length;
  const locations  = Object.keys(grouped).filter(k => k !== "unassigned");

  return (
    <div style={{ padding: "24px", background: "#0f0f23", minHeight: "100vh", color: "#e2e8f0" }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "18px", fontFamily: "monospace", color: "#e2e8f0" }}>
            Fleet Overview
          </h2>
          <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
            {total} devices · {locations.length} locations · refreshed {lastRefresh.toLocaleTimeString()}
          </div>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button
            onClick={() => handleOtaPush()}
            disabled={otaPushing || online === 0}
            style={{
              padding: "8px 16px",
              backgroundColor: otaPushing ? "#6b7280" : "#8b5cf6",
              color: "#fff",
              borderRadius: "6px",
              border: "none",
              fontSize: "13px",
              fontWeight: 600,
              cursor: otaPushing || online === 0 ? "not-allowed" : "pointer",
              opacity: online === 0 ? 0.5 : 1,
            }}
          >
            {otaPushing ? "⏳ Pushing..." : "📦 OTA All"}
          </button>
          <a
            href="#/provision"
            style={{
              padding: "8px 16px",
              backgroundColor: "#4CAF50",
              color: "#fff",
              borderRadius: "6px",
              textDecoration: "none",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            ➕ Add Device
          </a>
          <Badge label="Online"  value={online}         color="#22c55e" />
          <Badge label="Total"   value={total}          color="#3b82f6" />
          {pending.length > 0 && <Badge label="Pending" value={pending.length} color="#f59e0b" />}
        </div>
      </div>

      {error && (
        <div style={{ background: "#450a0a", border: "1px solid #ef4444", borderRadius: "6px", padding: "10px 14px", marginBottom: "16px", color: "#fca5a5", fontSize: "13px" }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Pending Approval section ─────────────────────────────────────────── */}
      {pending.length > 0 && (
        <div style={{
          background: "#1a1200", border: "1px solid #78350f",
          borderRadius: "8px", padding: "16px", marginBottom: "28px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
            <span style={{ fontSize: "16px" }}>⏳</span>
            <h2 style={{ margin: 0, fontSize: "15px", color: "#fbbf24", fontFamily: "monospace" }}>
              Pending Approval ({pending.length})
            </h2>
            <span style={{ fontSize: "11px", color: "#92400e", marginLeft: "4px" }}>
              — new devices waiting for admin approval
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {pending.map(device => (
              <PendingDeviceRow
                key={device.id}
                device={device}
                onApprove={() => setApproveModal({ device })}
                onBlock={() => handleBlock(device.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Fleet by location ────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ color: "#64748b", fontFamily: "monospace" }}>Loading fleet...</div>
      ) : (
        <>
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([locationId, devices]) => (
            <LocationGroup
              key={locationId}
              locationId={locationId}
              devices={devices}
              accountsCounts={accountsCounts}
              onApprove={(id) => {
                const d = devices.find(x => x.id === id);
                if (d) setApproveModal({ device: d });
              }}
              onDispatchJob={(d) => setDispatchModal({ device: d })}
              onHumanWorkflow={(d) => setHumanWorkflowDevice(d)}
              onRevoke={handleRevoke}
              onDelete={handleDelete}
              onRenamed={fetchAll}
              onOtaPush={handleOtaPushSingle}
              onAccountsClick={(d) => setAccountsModal(d)}
            />
          ))}

          {total === 0 && pending.length === 0 && (
            <div style={{ color: "#64748b", fontFamily: "monospace", textAlign: "center", marginTop: "60px" }}>
              No devices yet.<br />
              Install the agent on a device — it will appear here automatically.
            </div>
          )}
        </>
      )}

      {/* ── Approve modal ────────────────────────────────────────────────────── */}
      {approveModal && (
        <ApproveDeviceModal
          device={approveModal.device}
          onApprove={handleApprove}
          onClose={() => setApproveModal(null)}
        />
      )}

      {/* ── Job Dispatch Modal ───────────────────────────────────────────────── */}
      {dispatchModal && (
        <JobDispatchModal
          device={dispatchModal.device}
          onClose={() => setDispatchModal(null)}
          onDispatched={fetchAll}
        />
      )}

      {/* ── Accounts Modal ───────────────────────────────────────────────────── */}
      {accountsModal && (
        <AccountsModal
          deviceId={accountsModal.id}
          deviceName={accountsModal.friendlyName ?? accountsModal.model ?? "Device"}
          onClose={() => { setAccountsModal(null); fetchAccountsCounts(); }}
        />
      )}

      {/* ── Human Workflow Modal ─────────────────────────────────────────────── */}
      {humanWorkflowDevice && (
        <HumanWorkflowModal
          device={humanWorkflowDevice}
          onClose={() => setHumanWorkflowDevice(null)}
        />
      )}
    </div>
  );
}

// ─── PendingDeviceRow ─────────────────────────────────────────────────────────

function PendingDeviceRow({
  device, onApprove, onBlock,
}: { device: Device; onApprove: () => void; onBlock: () => void }) {
  const created = device.createdAt ? new Date(device.createdAt).toLocaleString() : "–";
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "#0f0a00", borderRadius: "6px", padding: "10px 14px",
      border: "1px solid #292000",
    }}>
      <div style={{ fontFamily: "monospace", fontSize: "13px" }}>
        <span style={{ color: "#fbbf24", fontWeight: "bold" }}>{device.model ?? "Unknown"}</span>
        <span style={{ color: "#64748b", marginLeft: "10px" }}>Android {device.androidVersion ?? "?"}</span>
        <span style={{ color: "#475569", marginLeft: "10px", fontSize: "11px" }}>
          UUID: {device.hardwareUuid?.slice(0, 8) ?? device.id.slice(0, 8)}…
        </span>
        {device.lastIp && (
          <span style={{ color: "#475569", marginLeft: "10px", fontSize: "11px" }}>IP: {device.lastIp}</span>
        )}
        <span style={{ color: "#374151", marginLeft: "10px", fontSize: "11px" }}>Since: {created}</span>
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={onApprove}
          style={{
            background: "#166534", color: "#bbf7d0", border: "none",
            borderRadius: "5px", padding: "6px 14px", cursor: "pointer",
            fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
          }}
        >
          ✓ Approve
        </button>
        <button
          onClick={onBlock}
          style={{
            background: "#450a0a", color: "#fca5a5", border: "none",
            borderRadius: "5px", padding: "6px 12px", cursor: "pointer",
            fontFamily: "monospace", fontSize: "12px",
          }}
        >
          ✕ Block
        </button>
      </div>
    </div>
  );
}

// ─── ApproveDeviceModal ───────────────────────────────────────────────────────

function ApproveDeviceModal({
  device, onApprove, onClose,
}: {
  device: Device;
  onApprove: (deviceId: string, friendlyName: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName]       = useState(device.friendlyName || device.model || "");
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const submit = async () => {
    if (!name.trim()) { setErr("Friendly name required"); return; }
    setBusy(true);
    try {
      await onApprove(device.id, name.trim());
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "10px",
        padding: "24px", width: "380px",
      }}>
        <h3 style={{ margin: "0 0 4px", fontFamily: "monospace", color: "#e2e8f0" }}>
          ✓ Approve Device
        </h3>
        <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "18px" }}>
          {device.model} · Android {device.androidVersion ?? "?"} · {device.lastIp ?? "unknown IP"}
        </div>

        <label style={{ fontSize: "12px", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
          Friendly name
        </label>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
          placeholder="e.g. OnePlus 5T - Cluj"
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#1e293b", border: "1px solid #334155",
            borderRadius: "6px", padding: "8px 10px",
            color: "#e2e8f0", fontFamily: "monospace", fontSize: "13px",
          }}
        />
        {err && <div style={{ color: "#f87171", fontSize: "12px", marginTop: "6px" }}>{err}</div>}

        <div style={{ display: "flex", gap: "10px", marginTop: "18px", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              background: "transparent", color: "#64748b",
              border: "1px solid #334155", borderRadius: "6px",
              padding: "7px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            style={{
              background: busy ? "#064e3b" : "#065f46", color: "#6ee7b7",
              border: "none", borderRadius: "6px",
              padding: "7px 20px", cursor: busy ? "not-allowed" : "pointer",
              fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
            }}
          >
            {busy ? "Approving…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── LocationGroup (unchanged) ────────────────────────────────────────────────

function LocationGroup({
  locationId, devices, accountsCounts, onApprove, onDispatchJob, onHumanWorkflow, onRevoke, onDelete, onRenamed, onOtaPush, onAccountsClick,
}: {
  locationId: string;
  devices: Device[];
  accountsCounts: Record<string, number>;
  onApprove: (id: string) => void;
  onDispatchJob: (d: Device) => void;
  onHumanWorkflow: (d: Device) => void;
  onRevoke: (id: string) => void;
  onDelete: (id: string) => void;
  onRenamed: () => void;
  onOtaPush: (id: string) => void;
  onAccountsClick: (d: Device) => void;
}) {
  const online = devices.filter(d => d.statusCapabilities.dispatchable).length;
  const label  = locationId === "unassigned" ? "Unassigned" : locationId.toUpperCase();

  return (
    <div style={{ marginBottom: "28px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "10px",
        marginBottom: "12px", borderBottom: "1px solid #1e293b", paddingBottom: "8px",
      }}>
        <span style={{ fontFamily: "monospace", fontSize: "13px", color: "#64748b" }}>
          📍 {label}
        </span>
        <span style={{ fontSize: "11px", color: "#475569" }}>
          {online}/{devices.length} online
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "12px" }}>
        {devices.map(device => (
          <DeviceCard
            key={device.id}
            device={device}
            accountsCount={accountsCounts[device.id] ?? 0}
            onApprove={() => onApprove(device.id)}
            onDispatchJob={() => onDispatchJob(device)}
            onHumanWorkflow={() => onHumanWorkflow(device)}
            onRevoke={() => onRevoke(device.id)}
            onDelete={() => onDelete(device.id)}
            onRenamed={onRenamed}
            onOtaPush={() => onOtaPush(device.id)}
            onAccountsClick={() => onAccountsClick(device)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: "#0f172a", border: `1px solid ${color}33`,
      borderRadius: "6px", padding: "6px 12px", textAlign: "center",
    }}>
      <div style={{ fontSize: "18px", fontWeight: "bold", color, fontFamily: "monospace" }}>{value}</div>
      <div style={{ fontSize: "10px", color: "#64748b", textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}

// ─── JobDispatchModal ────────────────────────────────────────────────────────

interface JobActionPolicyDefinition {
  actionKey: string;
  label: string;
  allowed: boolean;
  requiresRoot: boolean;
  defaultParams: Record<string, unknown>;
}

function JobDispatchModal({ device, onClose, onDispatched }: {
  device: Device; onClose: () => void; onDispatched: () => void;
}) {
  const [jobTypes, setJobTypes] = useState<JobActionPolicyDefinition[]>([]);
  const [jobType, setJobType] = useState("");
  const [params, setParams]   = useState("{}");
  const [busy, setBusy]       = useState(false);
  const [paramsError, setParamsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<JobActionPolicyDefinition[]>("/jobs/action-policies")
      .then((definitions) => {
        if (cancelled) return;
        const allowed = definitions.filter((definition) => definition.allowed);
        setJobTypes(allowed);
        if (allowed[0]) {
          setJobType(allowed[0].actionKey);
          setParams(JSON.stringify(allowed[0].defaultParams ?? {}, null, 2));
        }
      })
      .catch((error) => {
        if (!cancelled) setParamsError((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTypeChange = (newType: string) => {
    setJobType(newType);
    const preset = jobTypes.find((definition) => definition.actionKey === newType);
    if (preset) setParams(JSON.stringify(preset.defaultParams ?? {}, null, 2));
    setParamsError(null);
  };

  const dispatch = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params);
    } catch {
      setParamsError("Invalid JSON");
      return;
    }
    setParamsError(null);
    setBusy(true);
    try {
      await api.post("/jobs", {
        deviceId: device.id,
        type: jobType,
        params: parsed,
      });
      onDispatched();
      onClose();
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  };

  const requiresRoot = jobTypes.find((definition) => definition.actionKey === jobType)?.requiresRoot === true;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: "10px",
        padding: "24px", width: "440px",
      }}>
        <h3 style={{ margin: "0 0 16px", fontFamily: "monospace", color: "#e2e8f0" }}>
          Dispatch Job — {device.friendlyName ?? device.model}
        </h3>

        <label style={{ fontSize: "12px", color: "#94a3b8" }}>Job type</label>
        <select
          value={jobType}
          onChange={e => handleTypeChange(e.target.value)}
          style={{
            width: "100%", boxSizing: "border-box", background: "#1e293b",
            border: `1px solid ${requiresRoot ? "#ef4444" : "#334155"}`,
            borderRadius: "6px", padding: "7px 10px",
            color: requiresRoot ? "#fca5a5" : "#e2e8f0",
            fontFamily: "monospace", fontSize: "12px",
            marginBottom: "12px", marginTop: "4px", cursor: "pointer",
          }}
        >
          {jobTypes.map((definition) => (
            <option key={definition.actionKey} value={definition.actionKey}>{definition.label}</option>
          ))}
        </select>

        {requiresRoot && (
          <div style={{
            background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444",
            borderRadius: "6px", padding: "8px 12px", marginBottom: "12px",
            fontSize: "11px", color: "#fca5a5", fontFamily: "monospace",
          }}>
            ⚠️ Privileged operation — requires root. Confirm params carefully.
          </div>
        )}

        <label style={{ fontSize: "12px", color: "#94a3b8" }}>Params (JSON)</label>
        <textarea
          value={params}
          onChange={e => { setParams(e.target.value); setParamsError(null); }}
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box", background: "#1e293b",
            border: `1px solid ${paramsError ? "#ef4444" : "#334155"}`,
            borderRadius: "6px", padding: "7px 10px", color: "#e2e8f0",
            fontFamily: "monospace", fontSize: "12px", marginTop: "4px", resize: "vertical",
          }}
        />
        {paramsError && (
          <div style={{ color: "#ef4444", fontSize: "11px", fontFamily: "monospace", marginTop: "4px" }}>
            {paramsError}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ background: "transparent", color: "#64748b", border: "1px solid #334155", borderRadius: "6px", padding: "7px 16px", cursor: "pointer", fontFamily: "monospace", fontSize: "12px" }}>
            Cancel
          </button>
          <button onClick={dispatch} disabled={busy}
            style={{
              background: requiresRoot ? "#7f1d1d" : "#1d4ed8",
              color: requiresRoot ? "#fca5a5" : "#bfdbfe",
              border: "none", borderRadius: "6px", padding: "7px 20px",
              cursor: "pointer", fontFamily: "monospace", fontSize: "12px", fontWeight: "bold",
              opacity: busy ? 0.6 : 1,
            }}>
            {busy ? "Sending…" : requiresRoot ? "⚠️ Dispatch" : "Dispatch"}
          </button>
        </div>
      </div>
    </div>
  );
}
