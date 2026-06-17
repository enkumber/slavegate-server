/**
 * ClientsPage.tsx
 * Agency clients list + detail/edit modal.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, Client } from "../api/agency";

// ─── Strategy Editor ──────────────────────────────────────────────────────────

interface StrategyEditorProps {
  strategy: Record<string, unknown>;
  onChange: (strategy: Record<string, unknown>) => void;
}

function StrategyEditor({ strategy, onChange }: StrategyEditorProps) {
  const linkFields = [
    { key: "website", label: "Website", placeholder: "https://example.com" },
    { key: "instagram", label: "Instagram", placeholder: "https://instagram.com/brand or @brand" },
    { key: "facebook", label: "Facebook", placeholder: "https://facebook.com/brand" },
    { key: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/company/brand" },
    { key: "tiktok", label: "TikTok", placeholder: "https://tiktok.com/@brand or @brand" },
  ];

  const fields = [
    { key: "goal", label: "Goal", type: "text" },
    { key: "target_audience", label: "Target Audience", type: "textarea" },
    { key: "brand_voice", label: "Brand Voice", type: "text" },
    { key: "kpis", label: "KPIs", type: "textarea" },
    { key: "content_direction", label: "Content Direction", type: "textarea" },
    { key: "competitors", label: "Competitors", type: "text" },
    { key: "budget_level", label: "Budget Level", type: "select", options: ["low", "medium", "high"] },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div>
        <h5 style={{ color: "#aaa", fontSize: "12px", margin: "0 0 10px" }}>Links</h5>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {linkFields.map((field) => (
            <div key={field.key}>
              <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "4px" }}>
                {field.label}
              </label>
              <input
                type="text"
                value={(strategy[field.key] as string) ?? ""}
                onChange={(e) => onChange({ ...strategy, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: "4px",
                  color: "#fff",
                  fontSize: "13px",
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderTop: "1px solid #222", paddingTop: "12px" }}>
        <h5 style={{ color: "#aaa", fontSize: "12px", margin: "0 0 10px" }}>Positioning</h5>
      </div>

      {fields.map((field) => (
        <div key={field.key}>
          <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "4px" }}>
            {field.label}
          </label>
          {field.type === "textarea" ? (
            <textarea
              value={(strategy[field.key] as string) ?? ""}
              onChange={(e) => onChange({ ...strategy, [field.key]: e.target.value })}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "13px",
                minHeight: "60px",
                resize: "vertical",
              }}
            />
          ) : field.type === "select" ? (
            <select
              value={(strategy[field.key] as string) ?? ""}
              onChange={(e) => onChange({ ...strategy, [field.key]: e.target.value })}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "13px",
              }}
            >
              <option value="">Select...</option>
              {field.options?.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={(strategy[field.key] as string) ?? ""}
              onChange={(e) => onChange({ ...strategy, [field.key]: e.target.value })}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "13px",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Client Modal ─────────────────────────────────────────────────────────────

interface ClientModalProps {
  client: Client | null;
  isNew: boolean;
  onClose: () => void;
  onSave: () => void;
}

function ClientModal({ client, isNew, onClose, onSave }: ClientModalProps) {
  const [name, setName] = useState(client?.name ?? "");
  const [active, setActive] = useState(client?.active ?? true);
  const [strategy, setStrategy] = useState<Record<string, unknown>>(client?.strategy ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isNew) {
        await agencyApi.clients.create({ name: name.trim(), strategy, type: 'client' });
      } else if (client) {
        await agencyApi.clients.update(client.id, { name: name.trim(), active, strategy });
      }
      onSave();
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
        background: "rgba(0,0,0,0.8)",
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
          borderRadius: "8px",
          border: "1px solid #333",
          width: "500px",
          maxHeight: "80vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #222" }}>
          <h3 style={{ color: "#fff", margin: 0, fontSize: "16px" }}>
            {isNew ? "New Client" : `Edit: ${client?.name}`}
          </h3>
        </div>

        {/* Body */}
        <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
          {/* Name */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", color: "#888", fontSize: "12px", marginBottom: "4px" }}>
              Client Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Corp"
              style={{
                width: "100%",
                padding: "10px 12px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#fff",
                fontSize: "14px",
              }}
            />
          </div>

          {/* Active toggle (only for edit) */}
          {!isNew && (
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                <span style={{ color: "#ccc", fontSize: "13px" }}>Active</span>
              </label>
            </div>
          )}

          {/* Strategy */}
          <div>
            <h4 style={{ color: "#aaa", fontSize: "13px", marginBottom: "12px" }}>Strategy</h4>
            <StrategyEditor strategy={strategy} onChange={setStrategy} />
          </div>

          {/* Error */}
          {error && (
            <div style={{ marginTop: "16px", color: "#f55", fontSize: "13px" }}>
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 20px",
            borderTop: "1px solid #222",
            display: "flex",
            justifyContent: "flex-end",
            gap: "12px",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              background: "#333",
              border: "none",
              borderRadius: "4px",
              color: "#ccc",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "8px 16px",
              background: saving ? "#444" : "#2563eb",
              border: "none",
              borderRadius: "4px",
              color: "#fff",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [modalState, setModalState] = useState<{ open: boolean; client: Client | null; isNew: boolean }>({
    open: false,
    client: null,
    isNew: false,
  });

  const fetchClients = useCallback(async () => {
    try {
      const data = await agencyApi.clients.list({ 
        active: showActiveOnly ? true : undefined,
        type: 'client'
      });
      setClients(data.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showActiveOnly]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  return (
    <AgencyLayout currentRoute="#/agency/clients">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>👥 Clients</h1>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#888", fontSize: "13px" }}>
            <input
              type="checkbox"
              checked={showActiveOnly}
              onChange={(e) => setShowActiveOnly(e.target.checked)}
            />
            Active only
          </label>
          <button
            onClick={() => setModalState({ open: true, client: null, isNew: true })}
            style={{
              padding: "8px 16px",
              background: "#2563eb",
              border: "none",
              borderRadius: "6px",
              color: "#fff",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            + New Client
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "12px 16px", background: "#2a1515", borderRadius: "6px", color: "#f88", marginBottom: "16px" }}>
          ⚠️ {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>Loading...</div>
      ) : clients.length === 0 ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>
          No clients yet. Create one to get started.
        </div>
      ) : (
        /* Client grid */
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
          {clients.map((client) => (
            <div
              key={client.id}
              onClick={() => setModalState({ open: true, client, isNew: false })}
              style={{
                background: "#111",
                border: "1px solid #222",
                borderRadius: "8px",
                padding: "16px",
                cursor: "pointer",
                transition: "border-color 0.15s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#444")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#222")}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <h3 style={{ color: "#fff", margin: 0, fontSize: "15px" }}>{client.name}</h3>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    background: client.active ? "#0d3320" : "#2a1515",
                    color: client.active ? "#4ade80" : "#f88",
                  }}
                >
                  {client.active ? "Active" : "Inactive"}
                </span>
              </div>

              {/* Strategy preview */}
              <div style={{ marginTop: "12px" }}>
                {typeof client.strategy.goal === "string" && client.strategy.goal && (
                  <div style={{ color: "#888", fontSize: "12px", marginBottom: "4px" }}>
                    <strong>Goal:</strong> {client.strategy.goal.slice(0, 60)}
                    {client.strategy.goal.length > 60 ? "..." : ""}
                  </div>
                )}
                {typeof client.strategy.budget_level === "string" && client.strategy.budget_level && (
                  <div style={{ color: "#888", fontSize: "12px" }}>
                    <strong>Budget:</strong> {client.strategy.budget_level}
                  </div>
                )}
                {typeof client.strategy.website === "string" && client.strategy.website && (
                  <div style={{ color: "#888", fontSize: "12px", marginTop: "4px" }}>
                    <strong>Website:</strong> {client.strategy.website}
                  </div>
                )}
                {typeof client.strategy.instagram === "string" && client.strategy.instagram && (
                  <div style={{ color: "#888", fontSize: "12px", marginTop: "4px" }}>
                    <strong>Instagram:</strong> {client.strategy.instagram}
                  </div>
                )}
                {typeof client.strategy.facebook === "string" && client.strategy.facebook && (
                  <div style={{ color: "#888", fontSize: "12px", marginTop: "4px" }}>
                    <strong>Facebook:</strong> {client.strategy.facebook}
                  </div>
                )}
              </div>

              <div style={{ marginTop: "12px", color: "#555", fontSize: "11px" }}>
                Created {new Date(client.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {modalState.open && (
        <ClientModal
          client={modalState.client}
          isNew={modalState.isNew}
          onClose={() => setModalState({ open: false, client: null, isNew: false })}
          onSave={fetchClients}
        />
      )}
    </AgencyLayout>
  );
}
