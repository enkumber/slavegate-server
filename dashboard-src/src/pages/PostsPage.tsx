/**
 * PostsPage.tsx
 * Posts list with approval workflow — approve/reject buttons, filters, preview modal.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, Post } from "../api/agency";

// ─── Status Badge ─────────────────────────────────────────────────────────────

const statusColors: Record<Post["status"], { bg: string; color: string; label: string }> = {
  pending_approval: { bg: "#3d3d00", color: "#fbbf24", label: "Pending" },
  approved: { bg: "#0d3320", color: "#4ade80", label: "Approved" },
  rejected: { bg: "#3d1515", color: "#f87171", label: "Rejected" },
  published: { bg: "#1e3a5f", color: "#60a5fa", label: "Published" },
};

function StatusBadge({ status }: { status: Post["status"] }) {
  const { bg, color, label } = statusColors[status];
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 500,
        background: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

// ─── Post Preview Modal ───────────────────────────────────────────────────────

interface PostModalProps {
  post: Post;
  onClose: () => void;
  onAction: (action: "approve" | "reject") => Promise<void>;
}

function PostModal({ post, onClose, onAction }: PostModalProps) {
  const [acting, setActing] = useState(false);

  const handleAction = async (action: "approve" | "reject") => {
    setActing(true);
    try {
      await onAction(action);
      onClose();
    } finally {
      setActing(false);
    }
  };

  const content = post.content || {};
  const canApprove = post.status === "pending_approval";

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
          width: "600px",
          maxHeight: "85vh",
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
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ color: "#fff", fontSize: "15px", fontWeight: 500 }}>
                Post Preview
              </span>
              <StatusBadge status={post.status} />
            </div>
            <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>
              @{post.account_username} · {post.account_platform}
            </div>
          </div>
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

        {/* Body */}
        <div style={{ padding: "20px", overflowY: "auto", flex: 1 }}>
          {/* Media preview */}
          {content.media_url && (
            <div style={{ marginBottom: "16px" }}>
              {content.media_url.match(/\.(mp4|mov|webm)$/i) ? (
                <video
                  src={content.media_url}
                  controls
                  style={{
                    width: "100%",
                    maxHeight: "300px",
                    borderRadius: "8px",
                    background: "#000",
                  }}
                />
              ) : (
                <img
                  src={content.media_url}
                  alt="Post media"
                  style={{
                    width: "100%",
                    maxHeight: "300px",
                    objectFit: "contain",
                    borderRadius: "8px",
                    background: "#000",
                  }}
                />
              )}
            </div>
          )}

          {/* Caption */}
          {content.caption && (
            <div style={{ marginBottom: "16px" }}>
              <label style={{ color: "#888", fontSize: "11px", display: "block", marginBottom: "6px" }}>
                Caption
              </label>
              <div
                style={{
                  background: "#1a1a1a",
                  padding: "12px",
                  borderRadius: "6px",
                  color: "#e0e0e0",
                  fontSize: "13px",
                  lineHeight: "1.5",
                  whiteSpace: "pre-wrap",
                }}
              >
                {content.caption}
              </div>
            </div>
          )}

          {/* Hashtags */}
          {content.hashtags && content.hashtags.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <label style={{ color: "#888", fontSize: "11px", display: "block", marginBottom: "6px" }}>
                Hashtags
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {content.hashtags.map((tag: string, i: number) => (
                  <span
                    key={i}
                    style={{
                      padding: "4px 10px",
                      background: "#1e3a5f",
                      color: "#60a5fa",
                      borderRadius: "4px",
                      fontSize: "12px",
                    }}
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Meta info */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
              marginTop: "16px",
              padding: "12px",
              background: "#0a0a0a",
              borderRadius: "6px",
            }}
          >
            <div>
              <div style={{ color: "#666", fontSize: "11px" }}>Created by</div>
              <div style={{ color: "#ccc", fontSize: "13px" }}>{post.created_by}</div>
            </div>
            <div>
              <div style={{ color: "#666", fontSize: "11px" }}>Created at</div>
              <div style={{ color: "#ccc", fontSize: "13px" }}>
                {new Date(post.created_at).toLocaleString()}
              </div>
            </div>
            {post.approved_at && (
              <div>
                <div style={{ color: "#666", fontSize: "11px" }}>Approved at</div>
                <div style={{ color: "#ccc", fontSize: "13px" }}>
                  {new Date(post.approved_at).toLocaleString()}
                </div>
              </div>
            )}
            {post.published_at && (
              <div>
                <div style={{ color: "#666", fontSize: "11px" }}>Published at</div>
                <div style={{ color: "#ccc", fontSize: "13px" }}>
                  {new Date(post.published_at).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer with actions */}
        {canApprove && (
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
              onClick={() => handleAction("reject")}
              disabled={acting}
              style={{
                padding: "10px 20px",
                background: acting ? "#333" : "#7f1d1d",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                cursor: acting ? "not-allowed" : "pointer",
                fontSize: "13px",
                fontWeight: 500,
              }}
            >
              ❌ Reject
            </button>
            <button
              onClick={() => handleAction("approve")}
              disabled={acting}
              style={{
                padding: "10px 20px",
                background: acting ? "#333" : "#166534",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                cursor: acting ? "not-allowed" : "pointer",
                fontSize: "13px",
                fontWeight: 500,
              }}
            >
              ✅ Approve
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Post Card ────────────────────────────────────────────────────────────────

interface PostCardProps {
  post: Post;
  onClick: () => void;
}

function PostCard({ post, onClick }: PostCardProps) {
  const content = post.content || {};
  const caption = content.caption || "";
  const previewText = caption.slice(0, 100) + (caption.length > 100 ? "..." : "");

  return (
    <div
      onClick={onClick}
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "8px",
        padding: "16px",
        cursor: "pointer",
        transition: "border-color 0.15s ease, transform 0.1s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "#444";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#222";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
        <div>
          <div style={{ color: "#fff", fontSize: "13px", fontWeight: 500 }}>
            @{post.account_username || "unknown"}
          </div>
          <div style={{ color: "#666", fontSize: "11px" }}>
            {post.account_platform || post.platform}
          </div>
        </div>
        <StatusBadge status={post.status} />
      </div>

      {/* Thumbnail */}
      {content.thumbnail_url || content.media_url ? (
        <div
          style={{
            width: "100%",
            height: "120px",
            marginBottom: "10px",
            borderRadius: "6px",
            overflow: "hidden",
            background: "#0a0a0a",
          }}
        >
          <img
            src={content.thumbnail_url || content.media_url}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>
      ) : null}

      {/* Caption preview */}
      {previewText && (
        <div style={{ color: "#999", fontSize: "12px", lineHeight: "1.4", marginBottom: "10px" }}>
          {previewText}
        </div>
      )}

      {/* Footer */}
      <div style={{ color: "#555", fontSize: "11px" }}>
        {new Date(post.created_at).toLocaleDateString()} · {post.created_by}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PostsPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<string>("");

  // Stats
  const [stats, setStats] = useState<{ pending: number; approved: number; rejected: number; published: number }>({
    pending: 0,
    approved: 0,
    rejected: 0,
    published: 0,
  });

  const fetchPosts = useCallback(async () => {
    try {
      const data = await agencyApi.posts.list({
        status: statusFilter || undefined,
        pageSize: 100,
      });
      setPosts(data.items);

      // Calculate stats from data
      const pending = data.items.filter((p) => p.status === "pending_approval").length;
      const approved = data.items.filter((p) => p.status === "approved").length;
      const rejected = data.items.filter((p) => p.status === "rejected").length;
      const published = data.items.filter((p) => p.status === "published").length;
      setStats({ pending, approved, rejected, published });

      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
  const groupedByDate = filteredPosts.reduce(
    (acc, post) => {
      const date = new Date(post.created_at).toLocaleDateString();
      if (!acc[date]) acc[date] = [];
      acc[date].push(post);
      return acc;
    },
    {} as Record<string, Post[]>
  );

  // Sort dates descending
  const sortedDates = Object.keys(groupedByDate).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime()
  );

  // Get unique platforms for filter
  const platforms = [...new Set(posts.map((p) => p.account_platform || p.platform))];

  const handleAction = async (postId: string, action: "approve" | "reject") => {
    try {
      if (action === "approve") {
        await agencyApi.posts.approve(postId);
      } else {
        await agencyApi.posts.reject(postId);
      }
      await fetchPosts();
    } catch (e) {
      alert(`Failed to ${action}: ${(e as Error).message}`);
    }
  };

  return (
    <AgencyLayout currentRoute="#/agency/posts">
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>📝 Posts</h1>
        <p style={{ color: "#666", margin: "8px 0 0", fontSize: "13px" }}>
          Review and approve content before publishing
        </p>
      </div>

      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          gap: "16px",
          marginBottom: "24px",
          padding: "16px",
          background: "#111",
          borderRadius: "8px",
          border: "1px solid #222",
        }}
      >
        <div
          onClick={() => setStatusFilter("pending_approval")}
          style={{
            flex: 1,
            padding: "12px",
            background: statusFilter === "pending_approval" ? "#3d3d00" : "#0a0a0a",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#fbbf24", fontSize: "24px", fontWeight: 600 }}>{stats.pending}</div>
          <div style={{ color: "#888", fontSize: "11px" }}>Pending</div>
        </div>
        <div
          onClick={() => setStatusFilter("approved")}
          style={{
            flex: 1,
            padding: "12px",
            background: statusFilter === "approved" ? "#0d3320" : "#0a0a0a",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#4ade80", fontSize: "24px", fontWeight: 600 }}>{stats.approved}</div>
          <div style={{ color: "#888", fontSize: "11px" }}>Approved</div>
        </div>
        <div
          onClick={() => setStatusFilter("rejected")}
          style={{
            flex: 1,
            padding: "12px",
            background: statusFilter === "rejected" ? "#3d1515" : "#0a0a0a",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#f87171", fontSize: "24px", fontWeight: 600 }}>{stats.rejected}</div>
          <div style={{ color: "#888", fontSize: "11px" }}>Rejected</div>
        </div>
        <div
          onClick={() => setStatusFilter("published")}
          style={{
            flex: 1,
            padding: "12px",
            background: statusFilter === "published" ? "#1e3a5f" : "#0a0a0a",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#60a5fa", fontSize: "24px", fontWeight: 600 }}>{stats.published}</div>
          <div style={{ color: "#888", fontSize: "11px" }}>Published</div>
        </div>
        <div
          onClick={() => setStatusFilter("")}
          style={{
            flex: 1,
            padding: "12px",
            background: statusFilter === "" ? "#1a1a2e" : "#0a0a0a",
            borderRadius: "6px",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#a78bfa", fontSize: "24px", fontWeight: 600 }}>{posts.length}</div>
          <div style={{ color: "#888", fontSize: "11px" }}>All</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
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
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <button
          onClick={fetchPosts}
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
      ) : filteredPosts.length === 0 ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>
          No posts found. {statusFilter && "Try clearing the filter."}
        </div>
      ) : (
        /* Timeline view grouped by date */
        <div>
          {sortedDates.map((date) => (
            <div key={date} style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  color: "#888",
                  fontSize: "13px",
                  fontWeight: 500,
                  marginBottom: "12px",
                  paddingBottom: "8px",
                  borderBottom: "1px solid #222",
                }}
              >
                📅 {date}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: "16px",
                }}
              >
                {groupedByDate[date].map((post) => (
                  <PostCard key={post.id} post={post} onClick={() => setSelectedPost(post)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {selectedPost && (
        <PostModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
          onAction={(action) => handleAction(selectedPost.id, action)}
        />
      )}
    </AgencyLayout>
  );
}
