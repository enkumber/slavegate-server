import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * MaterialsPage.tsx
 * Materials upload + gallery management — drag & drop, filters, edit/delete.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
// ─── Type Badge ───────────────────────────────────────────────────────────────
const typeColors = {
    image: { bg: "#1e3a5f", color: "#60a5fa", icon: "🖼️" },
    video: { bg: "#5b21b6", color: "#c4b5fd", icon: "🎬" },
    text: { bg: "#374151", color: "#9ca3af", icon: "📄" },
};
function TypeBadge({ type }) {
    const { bg, color, icon } = typeColors[type];
    return (_jsxs("span", { style: {
            padding: "2px 8px",
            borderRadius: "4px",
            fontSize: "11px",
            background: bg,
            color,
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
        }, children: [icon, " ", type] }));
}
function UploadZone({ onUpload, uploading, progress }) {
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef(null);
    const handleDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        }
        else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };
    const handleDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            await onUpload(e.dataTransfer.files[0]);
        }
    };
    const handleChange = async (e) => {
        if (e.target.files && e.target.files[0]) {
            await onUpload(e.target.files[0]);
            e.target.value = ""; // Reset input
        }
    };
    return (_jsxs("div", { onDragEnter: handleDrag, onDragLeave: handleDrag, onDragOver: handleDrag, onDrop: handleDrop, onClick: () => !uploading && inputRef.current?.click(), style: {
            border: `2px dashed ${dragActive ? "#60a5fa" : "#333"}`,
            borderRadius: "12px",
            padding: "32px",
            textAlign: "center",
            background: dragActive ? "#1e3a5f20" : "#0a0a0a",
            cursor: uploading ? "not-allowed" : "pointer",
            transition: "all 0.2s ease",
            marginBottom: "24px",
        }, children: [_jsx("input", { ref: inputRef, type: "file", accept: "image/*,video/*,.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov,.webm", onChange: handleChange, style: { display: "none" }, disabled: uploading }), uploading ? (_jsxs("div", { children: [_jsxs("div", { style: { color: "#60a5fa", fontSize: "16px", marginBottom: "12px" }, children: ["Uploading... ", Math.round(progress), "%"] }), _jsx("div", { style: {
                            width: "200px",
                            height: "6px",
                            background: "#222",
                            borderRadius: "3px",
                            margin: "0 auto",
                            overflow: "hidden",
                        }, children: _jsx("div", { style: {
                                width: `${progress}%`,
                                height: "100%",
                                background: "#60a5fa",
                                transition: "width 0.2s ease",
                            } }) })] })) : (_jsxs("div", { children: [_jsx("div", { style: { fontSize: "32px", marginBottom: "12px" }, children: "\uD83D\uDCC1" }), _jsx("div", { style: { color: "#ccc", fontSize: "14px", marginBottom: "8px" }, children: "Drag & drop files here" }), _jsx("div", { style: { color: "#666", fontSize: "12px" }, children: "or click to browse \u00B7 JPG, PNG, GIF, WebP, MP4, MOV, WebM" })] }))] }));
}
function MaterialCard({ material, clients, onUpdate, onDelete }) {
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
        }
        catch (e) {
            alert(`Failed to save: ${e.message}`);
        }
        finally {
            setSaving(false);
        }
    };
    const handleToggleUsed = async () => {
        try {
            await agencyApi.materials.update(material.id, { used: !material.used });
            onUpdate();
        }
        catch (e) {
            alert(`Failed to update: ${e.message}`);
        }
    };
    const handleDelete = async () => {
        if (!confirm("Delete this material? This cannot be undone."))
            return;
        onDelete(material.id);
    };
    return (_jsxs("div", { style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "8px",
            overflow: "hidden",
            opacity: material.used ? 0.6 : 1,
            transition: "opacity 0.2s ease",
        }, children: [_jsxs("div", { style: {
                    width: "100%",
                    height: "160px",
                    background: "#0a0a0a",
                    position: "relative",
                }, children: [isVideo ? (_jsx("video", { src: mediaUrl, style: { width: "100%", height: "100%", objectFit: "cover" }, muted: true, onMouseEnter: (e) => e.currentTarget.play(), onMouseLeave: (e) => {
                            e.currentTarget.pause();
                            e.currentTarget.currentTime = 0;
                        } })) : (_jsx("img", { src: mediaUrl, alt: material.description || "Material", style: { width: "100%", height: "100%", objectFit: "cover" } })), _jsx("div", { style: { position: "absolute", top: "8px", left: "8px" }, children: _jsx(TypeBadge, { type: material.type }) }), material.used && (_jsx("div", { style: {
                            position: "absolute",
                            top: "8px",
                            right: "8px",
                            padding: "2px 8px",
                            background: "#333",
                            borderRadius: "4px",
                            fontSize: "10px",
                            color: "#888",
                        }, children: "USED" }))] }), _jsxs("div", { style: { padding: "12px" }, children: [editing ? (_jsxs("div", { children: [_jsx("textarea", { value: description, onChange: (e) => setDescription(e.target.value), placeholder: "Description...", style: {
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
                                } }), _jsxs("div", { style: { display: "flex", gap: "8px" }, children: [_jsx("button", { onClick: () => setEditing(false), style: {
                                            flex: 1,
                                            padding: "6px",
                                            background: "#333",
                                            border: "none",
                                            borderRadius: "4px",
                                            color: "#ccc",
                                            cursor: "pointer",
                                            fontSize: "12px",
                                        }, children: "Cancel" }), _jsx("button", { onClick: handleSave, disabled: saving, style: {
                                            flex: 1,
                                            padding: "6px",
                                            background: "#2563eb",
                                            border: "none",
                                            borderRadius: "4px",
                                            color: "#fff",
                                            cursor: saving ? "not-allowed" : "pointer",
                                            fontSize: "12px",
                                        }, children: saving ? "..." : "Save" })] })] })) : (_jsxs("div", { children: [_jsx("div", { onClick: () => setEditing(true), style: {
                                    color: material.description ? "#ccc" : "#555",
                                    fontSize: "12px",
                                    marginBottom: "8px",
                                    cursor: "pointer",
                                    minHeight: "36px",
                                }, children: material.description || "Click to add description..." }), material.client_name && (_jsxs("div", { style: { color: "#666", fontSize: "11px", marginBottom: "8px" }, children: ["\uD83D\uDC65 ", material.client_name] })), _jsxs("div", { style: { display: "flex", gap: "8px", marginTop: "8px" }, children: [_jsx("button", { onClick: handleToggleUsed, style: {
                                            flex: 1,
                                            padding: "6px",
                                            background: material.used ? "#0d3320" : "#1a1a1a",
                                            border: "1px solid #333",
                                            borderRadius: "4px",
                                            color: material.used ? "#4ade80" : "#888",
                                            cursor: "pointer",
                                            fontSize: "11px",
                                        }, children: material.used ? "✓ Used" : "Mark Used" }), _jsx("button", { onClick: handleDelete, style: {
                                            padding: "6px 10px",
                                            background: "#1a1a1a",
                                            border: "1px solid #333",
                                            borderRadius: "4px",
                                            color: "#f87171",
                                            cursor: "pointer",
                                            fontSize: "11px",
                                        }, children: "\uD83D\uDDD1\uFE0F" })] })] })), _jsx("div", { style: { color: "#444", fontSize: "10px", marginTop: "8px" }, children: new Date(material.uploaded_at).toLocaleDateString() })] })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function MaterialsPage() {
    const [materials, setMaterials] = useState([]);
    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Upload state
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    // Filters
    const [clientFilter, setClientFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [usedFilter, setUsedFilter] = useState("");
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
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [clientFilter, usedFilter]);
    useEffect(() => {
        fetchMaterials();
    }, [fetchMaterials]);
    // Filter by type (client-side since API doesn't support it)
    const filteredMaterials = materials.filter((m) => {
        if (typeFilter && m.type !== typeFilter)
            return false;
        return true;
    });
    const handleUpload = async (file) => {
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
        }
        catch (e) {
            alert(`Upload failed: ${e.message}`);
        }
        finally {
            clearInterval(progressInterval);
            setUploading(false);
            setUploadProgress(0);
        }
    };
    const handleDelete = async (id) => {
        try {
            await agencyApi.materials.delete(id);
            await fetchMaterials();
        }
        catch (e) {
            alert(`Delete failed: ${e.message}`);
        }
    };
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/materials", children: [_jsxs("div", { style: { marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\uD83D\uDCC1 Materials" }), _jsx("p", { style: { color: "#666", margin: "8px 0 0", fontSize: "13px" }, children: "Upload and manage media assets for content creation" })] }), _jsx(UploadZone, { onUpload: handleUpload, uploading: uploading, progress: uploadProgress }), _jsxs("div", { style: {
                    display: "flex",
                    gap: "12px",
                    marginBottom: "20px",
                    flexWrap: "wrap",
                }, children: [_jsxs("div", { style: { padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }, children: [_jsx("span", { style: { color: "#888", fontSize: "12px" }, children: "Total: " }), _jsx("span", { style: { color: "#fff", fontSize: "14px", fontWeight: 500 }, children: stats.total })] }), _jsxs("div", { style: { padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }, children: [_jsx("span", { style: { color: "#60a5fa", fontSize: "12px" }, children: "\uD83D\uDDBC\uFE0F Images: " }), _jsx("span", { style: { color: "#fff", fontSize: "14px", fontWeight: 500 }, children: stats.images })] }), _jsxs("div", { style: { padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }, children: [_jsx("span", { style: { color: "#c4b5fd", fontSize: "12px" }, children: "\uD83C\uDFAC Videos: " }), _jsx("span", { style: { color: "#fff", fontSize: "14px", fontWeight: 500 }, children: stats.videos })] }), _jsxs("div", { style: { padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }, children: [_jsx("span", { style: { color: "#4ade80", fontSize: "12px" }, children: "\u2713 Used: " }), _jsx("span", { style: { color: "#fff", fontSize: "14px", fontWeight: 500 }, children: stats.used })] }), _jsxs("div", { style: { padding: "8px 16px", background: "#111", borderRadius: "6px", border: "1px solid #222" }, children: [_jsx("span", { style: { color: "#fbbf24", fontSize: "12px" }, children: "\u25CB Unused: " }), _jsx("span", { style: { color: "#fff", fontSize: "14px", fontWeight: 500 }, children: stats.unused })] })] }), _jsxs("div", { style: { display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }, children: [_jsxs("select", { value: clientFilter, onChange: (e) => setClientFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                            minWidth: "150px",
                        }, children: [_jsx("option", { value: "", children: "All Clients" }), clients.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id)))] }), _jsxs("select", { value: typeFilter, onChange: (e) => setTypeFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                        }, children: [_jsx("option", { value: "", children: "All Types" }), _jsx("option", { value: "image", children: "\uD83D\uDDBC\uFE0F Images" }), _jsx("option", { value: "video", children: "\uD83C\uDFAC Videos" }), _jsx("option", { value: "text", children: "\uD83D\uDCC4 Text" })] }), _jsxs("select", { value: usedFilter, onChange: (e) => setUsedFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                        }, children: [_jsx("option", { value: "", children: "All Status" }), _jsx("option", { value: "false", children: "\u25CB Unused" }), _jsx("option", { value: "true", children: "\u2713 Used" })] }), _jsx("button", { onClick: fetchMaterials, style: {
                            padding: "8px 16px",
                            background: "#1a1a2e",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            cursor: "pointer",
                            fontSize: "13px",
                        }, children: "\uD83D\uDD04 Refresh" })] }), error && (_jsxs("div", { style: {
                    padding: "12px 16px",
                    background: "#2a1515",
                    borderRadius: "6px",
                    color: "#f88",
                    marginBottom: "16px",
                }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : filteredMaterials.length === 0 ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "No materials found. Upload some files to get started." })) : (
            /* Gallery grid */
            _jsx("div", { style: {
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: "16px",
                }, children: filteredMaterials.map((material) => (_jsx(MaterialCard, { material: material, clients: clients, onUpdate: fetchMaterials, onDelete: handleDelete }, material.id))) }))] }));
}
