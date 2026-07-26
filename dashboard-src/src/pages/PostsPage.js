import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * PostsPage.tsx
 * Posts list with approval workflow — approve/reject buttons, filters, preview modal.
 */
import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status, definition }) {
    const color = definition?.terminal
        ? definition.retryable ? "#f87171" : "#4ade80"
        : definition?.dispatchable ? "#60a5fa" : "#d4d4d8";
    return (_jsx("span", { style: {
            padding: "3px 10px",
            borderRadius: "12px",
            fontSize: "11px",
            fontWeight: 500,
            background: "#1f1f1f",
            color,
        }, children: definition?.description ?? status }));
}
function PostModal({ post, definition, transitions, onClose, onAction }) {
    const [acting, setActing] = useState(false);
    const handleAction = async (targetStatus) => {
        setActing(true);
        try {
            await onAction(targetStatus);
            onClose();
        }
        finally {
            setActing(false);
        }
    };
    const content = post.content || {};
    return (_jsx("div", { style: {
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
        }, onClick: onClose, children: _jsxs("div", { style: {
                background: "#111",
                borderRadius: "12px",
                border: "1px solid #333",
                width: "600px",
                maxHeight: "85vh",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
            }, onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { style: {
                        padding: "16px 20px",
                        borderBottom: "1px solid #222",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                    }, children: [_jsxs("div", { children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [_jsx("span", { style: { color: "#fff", fontSize: "15px", fontWeight: 500 }, children: "Post Preview" }), _jsx(StatusBadge, { status: post.status, definition: definition })] }), _jsxs("div", { style: { color: "#666", fontSize: "12px", marginTop: "4px" }, children: ["@", post.account_username, " \u00B7 ", post.account_platform] })] }), _jsx("button", { onClick: onClose, style: {
                                background: "none",
                                border: "none",
                                color: "#666",
                                fontSize: "20px",
                                cursor: "pointer",
                            }, children: "\u00D7" })] }), _jsxs("div", { style: { padding: "20px", overflowY: "auto", flex: 1 }, children: [content.media_url && (_jsx("div", { style: { marginBottom: "16px" }, children: content.media_url.match(/\.(mp4|mov|webm)$/i) ? (_jsx("video", { src: content.media_url, controls: true, style: {
                                    width: "100%",
                                    maxHeight: "300px",
                                    borderRadius: "8px",
                                    background: "#000",
                                } })) : (_jsx("img", { src: content.media_url, alt: "Post media", style: {
                                    width: "100%",
                                    maxHeight: "300px",
                                    objectFit: "contain",
                                    borderRadius: "8px",
                                    background: "#000",
                                } })) })), content.caption && (_jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { color: "#888", fontSize: "11px", display: "block", marginBottom: "6px" }, children: "Caption" }), _jsx("div", { style: {
                                        background: "#1a1a1a",
                                        padding: "12px",
                                        borderRadius: "6px",
                                        color: "#e0e0e0",
                                        fontSize: "13px",
                                        lineHeight: "1.5",
                                        whiteSpace: "pre-wrap",
                                    }, children: content.caption })] })), content.hashtags && content.hashtags.length > 0 && (_jsxs("div", { style: { marginBottom: "16px" }, children: [_jsx("label", { style: { color: "#888", fontSize: "11px", display: "block", marginBottom: "6px" }, children: "Hashtags" }), _jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" }, children: content.hashtags.map((tag, i) => (_jsxs("span", { style: {
                                            padding: "4px 10px",
                                            background: "#1e3a5f",
                                            color: "#60a5fa",
                                            borderRadius: "4px",
                                            fontSize: "12px",
                                        }, children: ["#", tag] }, i))) })] })), _jsxs("div", { style: {
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: "12px",
                                marginTop: "16px",
                                padding: "12px",
                                background: "#0a0a0a",
                                borderRadius: "6px",
                            }, children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#666", fontSize: "11px" }, children: "Created by" }), _jsx("div", { style: { color: "#ccc", fontSize: "13px" }, children: post.created_by })] }), _jsxs("div", { children: [_jsx("div", { style: { color: "#666", fontSize: "11px" }, children: "Created at" }), _jsx("div", { style: { color: "#ccc", fontSize: "13px" }, children: new Date(post.created_at).toLocaleString() })] }), post.approved_at && (_jsxs("div", { children: [_jsx("div", { style: { color: "#666", fontSize: "11px" }, children: "Approved at" }), _jsx("div", { style: { color: "#ccc", fontSize: "13px" }, children: new Date(post.approved_at).toLocaleString() })] })), post.published_at && (_jsxs("div", { children: [_jsx("div", { style: { color: "#666", fontSize: "11px" }, children: "Published at" }), _jsx("div", { style: { color: "#ccc", fontSize: "13px" }, children: new Date(post.published_at).toLocaleString() })] }))] })] }), transitions.length > 0 && (_jsx("div", { style: {
                        padding: "16px 20px",
                        borderTop: "1px solid #222",
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "12px",
                    }, children: transitions.map((target) => (_jsx("button", { onClick: () => handleAction(target.status), disabled: acting, style: {
                            padding: "10px 20px",
                            background: acting ? "#333" : "#1f2937",
                            border: "none",
                            borderRadius: "6px",
                            color: "#fff",
                            cursor: acting ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                        }, children: target.description ?? target.status }, target.status))) }))] }) }));
}
function PostCard({ post, definition, onClick }) {
    const content = post.content || {};
    const caption = content.caption || "";
    const previewText = caption.slice(0, 100) + (caption.length > 100 ? "..." : "");
    return (_jsxs("div", { onClick: onClick, style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "8px",
            padding: "16px",
            cursor: "pointer",
            transition: "border-color 0.15s ease, transform 0.1s ease",
        }, onMouseEnter: (e) => {
            e.currentTarget.style.borderColor = "#444";
            e.currentTarget.style.transform = "translateY(-1px)";
        }, onMouseLeave: (e) => {
            e.currentTarget.style.borderColor = "#222";
            e.currentTarget.style.transform = "translateY(0)";
        }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }, children: [_jsxs("div", { children: [_jsxs("div", { style: { color: "#fff", fontSize: "13px", fontWeight: 500 }, children: ["@", post.account_username || "unknown"] }), _jsx("div", { style: { color: "#666", fontSize: "11px" }, children: post.account_platform || post.platform })] }), _jsx(StatusBadge, { status: post.status, definition: definition })] }), content.thumbnail_url || content.media_url ? (_jsx("div", { style: {
                    width: "100%",
                    height: "120px",
                    marginBottom: "10px",
                    borderRadius: "6px",
                    overflow: "hidden",
                    background: "#0a0a0a",
                }, children: _jsx("img", { src: content.thumbnail_url || content.media_url, alt: "", style: {
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                    } }) })) : null, previewText && (_jsx("div", { style: { color: "#999", fontSize: "12px", lineHeight: "1.4", marginBottom: "10px" }, children: previewText })), _jsxs("div", { style: { color: "#555", fontSize: "11px" }, children: [new Date(post.created_at).toLocaleDateString(), " \u00B7 ", post.created_by] })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function PostsPage() {
    const [posts, setPosts] = useState([]);
    const [definitions, setDefinitions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedPost, setSelectedPost] = useState(null);
    const [selectedTransitions, setSelectedTransitions] = useState([]);
    // Filters
    const [statusFilter, setStatusFilter] = useState("");
    const [platformFilter, setPlatformFilter] = useState("");
    const fetchPosts = useCallback(async () => {
        try {
            const [data, lifecycleDefinitions] = await Promise.all([
                agencyApi.posts.list({
                    status: statusFilter || undefined,
                    pageSize: 100,
                }),
                agencyApi.posts.definitions(),
            ]);
            setPosts(data.items);
            setDefinitions(lifecycleDefinitions);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [statusFilter]);
    useEffect(() => {
        fetchPosts();
    }, [fetchPosts]);
    // Filter posts by platform (client-side)
    const filteredPosts = posts.filter((p) => {
        if (platformFilter && p.platform !== platformFilter && p.account_platform !== platformFilter) {
            return false;
        }
        return true;
    });
    // Group by date
    const groupedByDate = filteredPosts.reduce((acc, post) => {
        const date = new Date(post.created_at).toLocaleDateString();
        if (!acc[date])
            acc[date] = [];
        acc[date].push(post);
        return acc;
    }, {});
    // Sort dates descending
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    // Get unique platforms for filter
    const platforms = [...new Set(posts.map((p) => p.account_platform || p.platform))];
    const definitionByStatus = new Map(definitions.map((definition) => [definition.status, definition]));
    const statusStats = definitions.map((definition) => ({
        definition,
        count: posts.filter((post) => post.status === definition.status).length,
    }));
    const selectPost = async (post) => {
        setSelectedPost(post);
        try {
            setSelectedTransitions(await agencyApi.posts.transitions(post.id));
        }
        catch (e) {
            setSelectedTransitions([]);
            setError(e.message);
        }
    };
    const handleAction = async (postId, targetStatus) => {
        try {
            await agencyApi.posts.transition(postId, targetStatus);
            await fetchPosts();
        }
        catch (e) {
            alert(`Transition failed: ${e.message}`);
        }
    };
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/posts", children: [_jsxs("div", { style: { marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\uD83D\uDCDD Posts" }), _jsx("p", { style: { color: "#666", margin: "8px 0 0", fontSize: "13px" }, children: "Review and approve content before publishing" })] }), _jsxs("div", { style: {
                    display: "flex",
                    gap: "16px",
                    marginBottom: "24px",
                    padding: "16px",
                    background: "#111",
                    borderRadius: "8px",
                    border: "1px solid #222",
                }, children: [statusStats.map(({ definition, count }) => (_jsxs("div", { onClick: () => setStatusFilter(definition.status), style: {
                            flex: 1,
                            padding: "12px",
                            background: statusFilter === definition.status ? "#1f2937" : "#0a0a0a",
                            borderRadius: "6px",
                            cursor: "pointer",
                            textAlign: "center",
                        }, children: [_jsx("div", { style: { color: "#d4d4d8", fontSize: "24px", fontWeight: 600 }, children: count }), _jsx("div", { style: { color: "#888", fontSize: "11px" }, children: definition.description ?? definition.status })] }, definition.status))), _jsxs("div", { onClick: () => setStatusFilter(""), style: {
                            flex: 1,
                            padding: "12px",
                            background: statusFilter === "" ? "#1a1a2e" : "#0a0a0a",
                            borderRadius: "6px",
                            cursor: "pointer",
                            textAlign: "center",
                        }, children: [_jsx("div", { style: { color: "#a78bfa", fontSize: "24px", fontWeight: 600 }, children: posts.length }), _jsx("div", { style: { color: "#888", fontSize: "11px" }, children: "All" })] })] }), _jsxs("div", { style: { display: "flex", gap: "12px", marginBottom: "20px" }, children: [_jsxs("select", { value: platformFilter, onChange: (e) => setPlatformFilter(e.target.value), style: {
                            padding: "8px 12px",
                            background: "#1a1a1a",
                            border: "1px solid #333",
                            borderRadius: "6px",
                            color: "#ccc",
                            fontSize: "13px",
                        }, children: [_jsx("option", { value: "", children: "All Platforms" }), platforms.map((p) => (_jsx("option", { value: p, children: p }, p)))] }), _jsx("button", { onClick: fetchPosts, style: {
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
                }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : filteredPosts.length === 0 ? (_jsxs("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: ["No posts found. ", statusFilter && "Try clearing the filter."] })) : (
            /* Timeline view grouped by date */
            _jsx("div", { children: sortedDates.map((date) => (_jsxs("div", { style: { marginBottom: "32px" }, children: [_jsxs("h3", { style: {
                                color: "#888",
                                fontSize: "13px",
                                fontWeight: 500,
                                marginBottom: "12px",
                                paddingBottom: "8px",
                                borderBottom: "1px solid #222",
                            }, children: ["\uD83D\uDCC5 ", date] }), _jsx("div", { style: {
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                                gap: "16px",
                            }, children: groupedByDate[date].map((post) => (_jsx(PostCard, { post: post, definition: definitionByStatus.get(post.status), onClick: () => void selectPost(post) }, post.id))) })] }, date))) })), selectedPost && (_jsx(PostModal, { post: selectedPost, definition: definitionByStatus.get(selectedPost.status), transitions: selectedTransitions, onClose: () => setSelectedPost(null), onAction: (targetStatus) => handleAction(selectedPost.id, targetStatus) }))] }));
}
