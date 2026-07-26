/**
 * PostsPage.tsx
 * Posts list with approval workflow — approve/reject buttons, filters, preview modal.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, LifecycleStateDefinition, Post } from "../api/agency";

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, definition }: { status: string; definition?: LifecycleStateDefinition }) {
  const color = definition?.terminal
    ? definition.retryable ? "#f87171" : "#4ade80"
    : definition?.dispatchable ? "#60a5fa" : "#d4d4d8";
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 500,
        background: "#1f1f1f",
        color,
      }}
    >
      {definition?.description ?? status}
    </span>
  );
}

// ─── Post Preview Modal ───────────────────────────────────────────────────────

interface PostModalProps {
  post: Post;
  definition?: LifecycleStateDefinition;
  transitions: LifecycleStateDefinition[];
  onClose: () => void;
  onAction: (targetStatus: string) => Promise<void>;
}

function PostModal({ post, definition, transitions, onClose, onAction }: PostModalProps) {
  const [acting, setActing] = useState(false);

  const handleAction = async (targetStatus: string) => {
    setActing(true);
    try {
      await onAction(targetStatus);
      onClose();
    } finally {
      setActing(false);
    }
  };

  const content = post.content || {};
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
              <StatusBadge status={post.status} definition={definition} />
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
        {transitions.length > 0 && (
          <div
            style={{
              padding: "16px 20px",
              borderTop: "1px solid #222",
              display: "flex",
              justifyContent: "flex-end",
              gap: "12px",
            }}
          >
            {transitions.map((target) => (
              <button
                key={target.status}
                onClick={() => handleAction(target.status)}
                disabled={acting}
                style={{
                  padding: "10px 20px",
                  background: acting ? "#333" : "#1f2937",
                  border: "none",
                  borderRadius: "6px",
                  color: "#fff",
                  cursor: acting ? "not-allowed" : "pointer",
                  fontSize: "13px",
                  fontWeight: 500,
                }}
              >
                {target.description ?? target.status}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Post Card ────────────────────────────────────────────────────────────────

interface PostCardProps {
  post: Post;
  definition?: LifecycleStateDefinition;
  onClick: () => void;
}

function PostCard({ post, definition, onClick }: PostCardProps) {
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
        <StatusBadge status={post.status} definition={definition} />
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
  const [definitions, setDefinitions] = useState<LifecycleStateDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [selectedTransitions, setSelectedTransitions] = useState<LifecycleStateDefinition[]>([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<string>("");

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

  const definitionByStatus = new Map(definitions.map((definition) => [definition.status, definition]));
  const statusStats = definitions.map((definition) => ({
    definition,
    count: posts.filter((post) => post.status === definition.status).length,
  }));

  const selectPost = async (post: Post) => {
    setSelectedPost(post);
    try {
      setSelectedTransitions(await agencyApi.posts.transitions(post.id));
    } catch (e) {
      setSelectedTransitions([]);
      setError((e as Error).message);
    }
  };

  const handleAction = async (postId: string, targetStatus: string) => {
    try {
      await agencyApi.posts.transition(postId, targetStatus);
      await fetchPosts();
    } catch (e) {
      alert(`Transition failed: ${(e as Error).message}`);
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
        {statusStats.map(({ definition, count }) => (
          <div
            key={definition.status}
            onClick={() => setStatusFilter(definition.status)}
            style={{
              flex: 1,
              padding: "12px",
              background: statusFilter === definition.status ? "#1f2937" : "#0a0a0a",
              borderRadius: "6px",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div style={{ color: "#d4d4d8", fontSize: "24px", fontWeight: 600 }}>{count}</div>
            <div style={{ color: "#888", fontSize: "11px" }}>
              {definition.description ?? definition.status}
            </div>
          </div>
        ))}
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
                  <PostCard
                    key={post.id}
                    post={post}
                    definition={definitionByStatus.get(post.status)}
                    onClick={() => void selectPost(post)}
                  />
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
          definition={definitionByStatus.get(selectedPost.status)}
          transitions={selectedTransitions}
          onClose={() => setSelectedPost(null)}
          onAction={(targetStatus) => handleAction(selectedPost.id, targetStatus)}
        />
      )}
    </AgencyLayout>
  );
}
