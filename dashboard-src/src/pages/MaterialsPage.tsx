/**
 * MaterialsPage.tsx
 * Materials upload + gallery management — drag & drop, filters, edit/delete.
 */

import { useState, useEffect, useCallback, useRef, DragEvent } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, Material, Client } from "../api/agency";

// ─── Type Badge ───────────────────────────────────────────────────────────────

const typeColors: Record<Material["type"], { bg: string; color: string; icon: string }> = {
  image: { bg: "#1e3a5f", color: "#60a5fa", icon: "🖼️" },
  video: { bg: "#5b21b6", color: "#c4b5fd", icon: "🎬" },
  text: { bg: "#374151", color: "#9ca3af", icon: "📄" },
};

function TypeBadge({ type }: { type: Material["type"] }) {
  const { bg, color, icon } = typeColors[type];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        background: bg,
        color,
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      {icon} {type}
    </span>
  );
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────

interface UploadZoneProps {
  onUpload: (file: File) => Promise<void>;
  uploading: boolean;
  progress: number;
}

function UploadZone({ onUpload, uploading, progress }: UploadZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await onUpload(e.dataTransfer.files[0]);
    }
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      await onUpload(e.target.files[0]);
      e.target.value = ""; // Reset input
    }
  };

  return (
    <div
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragActive ? "#60a5fa" : "#333"}`,
        borderRadius: "12px",
        padding: "32px",
        textAlign: "center",
        background: dragActive ? "#1e3a5f20" : "#0a0a0a",
        cursor: uploading ? "not-allowed" : "pointer",
        transition: "all 0.2s ease",
        marginBottom: "24px",
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.webm"
        onChange={handleChange}
        style={{ display: "none" }}
        disabled={uploading}
      />

      {uploading ? (
        <div>
          <div style={{ color: "#60a5fa", fontSize: "16px", marginBottom: "12px" }}>
            Uploading... {Math.round(progress)}%
          </div>
          <div
            style={{
              width: "200px",
              height: "6px",
              background: "#222",
              borderRadius: "3px",
              margin: "0 auto",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "#60a5fa",
                transition: "width 0.2s ease",
              }}
            />
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>📁</div>
          <div style={{ color: "#ccc", fontSize: "14px", marginBottom: "8px" }}>
            Drag & drop files here
          </div>
          <div style={{ color: "#666", fontSize: "12px" }}>
            or click to browse · JPG, PNG, GIF, WebP, MP4, MOV, WebM
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Material Card ────────────────────────────────────────────────────────────

interface MaterialCardProps {
  material: Material;
  clients: Client[];
  onUpdate: () => void;
  onDelete: (id: string) => void;
}

function MaterialCard({ material, clients, onUpdate, onDelete }: MaterialCardProps) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(material.description || "");
  const [clientId, setClientId] = useState(material.client_id || "");
  const [saving, setSaving] = useState(false);

  const isVideo = material.type === "video";
  const BASE_URL = import.meta.env.VITE_API_URL?.replace("/api", "") ?? "http://localhost:3000";
  const mediaUrl = material.url.startsWith("http") ? material.url : `${BASE_URL}${material.url}`;

  const handleSave = async () => {
    setSaving(true);
    try {
      await agencyApi.materials.update(material.id, {
        description: description || undefined,
      });
      // Note: client_id update would need API change — skipping for now
      setEditing(false);
      onUpdate();
    } catch (e) {
      alert(`Failed to save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleUsed = async () => {
    try {
      await agencyApi.materials.update(material.id, { used: !material.used });
      onUpdate();
    } catch (e) {
      alert(`Failed to update: ${(e as Error).message}`);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this material? This cannot be undone.")) return;
    onDelete(material.id);
  };

  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "8px",
        overflow: "hidden",
        opacity: material.used ? 0.6 : 1,
        transition: "opacity 0.2s ease",
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          width: "100%",
          height: "160px",
          background: "#0a0a0a",
          position: "relative",
        }}
      >
        {isVideo ? (
          <video
            src={mediaUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            muted
            onMouseEnter={(e) => e.currentTarget.play()}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
        ) : (
          <img
            src={mediaUrl}
            alt={material.description || "Material"}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}

        {/* Type badge */}
        <div style={{ position: "absolute", top: "8px", left: "8px" }}>
          <TypeBadge type={material.type} />
        </div>

        {/* Used badge */}
        {material.used && (
          <div
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              padding: "2px 8px",
              background: "#333",
              borderRadius: "4px",
              fontSize: "10px",
              color: "#888",
            }}
          >
            USED
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: "12px" }}>
        {editing ? (
          <div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description..."
              style={{
                width: "100%",
                padding: "8px",
                background: "#1a1a1a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#ccc",
                fontSize: "12px",
                resize: "vertical",
                minHeight: "60px",
                marginBottom: "8px",
              }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setEditing(false)}
                style={{
                  flex: 1,
                  padding: "6px",
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
                onClick={handleSave}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: "6px",
                  background: "#2563eb",
                  border: "none",
                  borderRadius: "4px",
                  color: "#fff",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontSize: "12px",
                }}
              >
                {saving ? "..." : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {/* Description */}
            <div
              onClick={() => setEditing(true)}
              style={{
                color: material.description ? "#ccc" : "#555",
                fontSize: "12px",
                marginBottom: "8px",
                cursor: "pointer",
                minHeight: "36px",
              }}
            >
              {material.description || "Click to add description..."}
            </div>

            {/* Client */}
            {material.client_name && (
              <div style={{ color: "#666", fontSize: "11px", marginBottom: "8px" }}>
                👥 {material.client_name}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button
                onClick={handleToggleUsed}
                style={{
                  flex: 1,
                  padding: "6px",
                  background: material.used ? "#0d3320" : "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: "4px",
                  color: material.used ? "#4ade80" : "#888",
                  cursor: "pointer",
                  fontSize: "11px",
                }}
              >
                {material.used ? "✓ Used" : "Mark Used"}
              </button>
              <button
                onClick={handleDelete}
                style={{
                  padding: "6px 10px",
                  background: "#1a1a1a",
                  border: "1px solid #333",
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
        )}

        {/* Date */}
        <div style={{ color: "#444", fontSize: "10px", marginTop: "8px" }}>
          {new Date(material.uploaded_at).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function MaterialsPage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Filters
  const [clientFilter, setClientFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [usedFilter, setUsedFilter] = useState<string>("");

  // Stats
  const stats = {
    total: materials.length,
    images: materials.filter((m) => m.type === "image").length,
    videos: materials.filter((m) => m.type === "video").length,
    used: materials.filter((m) => m.used).length,
    unused: materials.filter((m) => !m.used).length,
  };

  const fetchMaterials = useCallback(async () => {
    try {
      const [materialsData, clientsData] = await Promise.all([
        agencyApi.materials.list({
          clientId: clientFilter || undefined,
          used: usedFilter === "true" ? true : usedFilter === "false" ? false : undefined,
          pageSize: 100,
        }),
        agencyApi.clients.list({ pageSize: 100 }),
      ]);
      setMaterials(materialsData.items);
      setClients(clientsData.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [clientFilter, usedFilter]);

  useEffect(() => {
    fetchMaterials();
  }, [fetchMaterials]);

  // Filter by type (client-side since API doesn't support it)
  const filteredMaterials = materials.filter((m) => {
    if (typeFilter && m.type !== typeFilter) return false;
    return true;
  });

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadProgress(0);

    // Simulate progress (real progress would need XMLHttpRequest)
    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => Math.min(prev + 10, 90));
    }, 100);

    try {
      await agencyApi.materials.upload(file, {
        clientId: clientFilter || undefined,
      });
      setUploadProgress(100);
      await fetchMaterials();
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
    } finally {
      clearInterval(progressInterval);
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await agencyApi.materials.delete(id);
      await fetchMaterials();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  };

  return (
    <AgencyLayout currentRoute="#/agency/materials">
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>📁 Materials</h1>
        <p style={{ color: "#666", margin: "8px 0 0", fontSize: "13px" }}>
          Upload and manage media assets for content creation
        </p>
      </div>

      {/* Upload zone */}
      <UploadZone onUpload={handleUpload} uploading={uploading} progress={uploadProgress} />

      {/* Stats */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "20px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }}>
          <span style={{ color: "#888", fontSize: "12px" }}>Total: </span>
          <span style={{ color: "#fff", fontSize: "14px", fontWeight: 500 }}>{stats.total}</span>
        </div>
        <div style={{ padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }}>
          <span style={{ color: "#60a5fa", fontSize: "12px" }}>🖼️ Images: </span>
          <span style={{ color: "#fff", fontSize: "14px", fontWeight: 500 }}>{stats.images}</span>
        </div>
        <div style={{ padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }}>
          <span style={{ color: "#c4b5fd", fontSize: "12px" }}>🎬 Videos: </span>
          <span style={{ color: "#fff", fontSize: "14px", fontWeight: 500 }}>{stats.videos}</span>
        </div>
        <div style={{ padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }}>
          <span style={{ color: "#4ade80", fontSize: "12px" }}>✓ Used: </span>
          <span style={{ color: "#fff", fontSize: "14px", fontWeight: 500 }}>{stats.used}</span>
        </div>
        <div style={{ padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }}>
          <span style={{ color: "#fbbf24", fontSize: "12px" }}>○ Unused: </span>
          <span style={{ color: "#fff", fontSize: "14px", fontWeight: 500 }}>{stats.unused}</span>
        </div>
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
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "13px",
          }}
        >
          <option value="">All Types</option>
          <option value="image">🖼️ Images</option>
          <option value="video">🎬 Videos</option>
          <option value="text">📄 Text</option>
        </select>

        <select
          value={usedFilter}
          onChange={(e) => setUsedFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "13px",
          }}
        >
          <option value="">All Status</option>
          <option value="false">○ Unused</option>
          <option value="true">✓ Used</option>
        </select>

        <button
          onClick={fetchMaterials}
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
      ) : filteredMaterials.length === 0 ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>
          No materials found. Upload some files to get started.
        </div>
      ) : (
        /* Gallery grid */
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "16px",
          }}
        >
          {filteredMaterials.map((material) => (
            <MaterialCard
              key={material.id}
              material={material}
              clients={clients}
              onUpdate={fetchMaterials}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </AgencyLayout>
  );
}
