/**
 * TasksPage.tsx
 * Tasks timeline view — status badges, filters, details modal.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, Task } from "../api/agency";

// ─── Status Badge ─────────────────────────────────────────────────────────────

const statusConfig: Record<Task["status"], { bg: string; color: string; label: string; pulse?: boolean }> = {
  queued: { bg: "#374151", color: "#9ca3af", label: "Queued" },
  running: { bg: "#1e3a5f", color: "#60a5fa", label: "Running", pulse: true },
  completed: { bg: "#0d3320", color: "#4ade80", label: "Completed" },
  failed: { bg: "#3d1515", color: "#f87171", label: "Failed" },
  paused: { bg: "#3d3d00", color: "#fbbf24", label: "Paused" },
};

function StatusBadge({ status }: { status: Task["status"] }) {
  const config = statusConfig[status];
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 500,
        background: config.bg,
        color: config.color,
        animation: config.pulse ? "pulse 2s infinite" : undefined,
      }}
    >
      {status === "running" && "⚡ "}
      {config.label}
    </span>
  );
}

// ─── Task Detail Modal ────────────────────────────────────────────────────────

interface TaskModalProps {
  task: Task;
  onClose: () => void;
  onAction: (action: "pause" | "resume" | "cancel") => Promise<void>;
}

function TaskModal({ task, onClose, onAction }: TaskModalProps) {
  const [acting, setActing] = useState(false);

  const handleAction = async (action: "pause" | "resume" | "cancel") => {
    setActing(true);
    try {
      await onAction(action);
      onClose();
    } finally {
      setActing(false);
    }
  };

  const canPause = task.status === "queued";
  const canResume = task.status === "paused";
  const canCancel = task.status === "queued" || task.status === "paused";

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
          width: "550px",
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
                Task Details
              </span>
              <StatusBadge status={task.status} />
            </div>
            <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>
              {task.routine}
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
          {/* Info grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginBottom: "20px",
            }}
          >
            <div style={{ background: "#0a0a0a", padding: "12px", borderRadius: "6px" }}>
              <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Device</div>
              <div style={{ color: "#fff", fontSize: "13px" }}>{task.device_name || task.device_id}</div>
            </div>
            <div style={{ background: "#0a0a0a", padding: "12px", borderRadius: "6px" }}>
              <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Account</div>
              <div style={{ color: "#fff", fontSize: "13px" }}>
                @{task.account_username || "N/A"}
                {task.account_platform && <span style={{ color: "#888" }}> · {task.account_platform}</span>}
              </div>
            </div>
            <div style={{ background: "#0a0a0a", padding: "12px", borderRadius: "6px" }}>
              <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Scheduled</div>
              <div style={{ color: "#fff", fontSize: "13px" }}>
                {new Date(task.scheduled_time).toLocaleString()}
              </div>
            </div>
            <div style={{ background: "#0a0a0a", padding: "12px", borderRadius: "6px" }}>
              <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Batch ID</div>
              <div style={{ color: "#fff", fontSize: "13px" }}>{task.batch_id || "—"}</div>
            </div>
          </div>

          {/* Timestamps */}
          <div style={{ marginBottom: "20px" }}>
            <h4 style={{ color: "#888", fontSize: "12px", marginBottom: "8px" }}>Timeline</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }}>
                <span>Created:</span>
                <span>{new Date(task.created_at).toLocaleString()}</span>
              </div>
              {task.started_at && (
                <div style={{ display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }}>
                  <span>Started:</span>
                  <span>{new Date(task.started_at).toLocaleString()}</span>
                </div>
              )}
              {task.completed_at && (
                <div style={{ display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }}>
                  <span>Completed:</span>
                  <span>{new Date(task.completed_at).toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Params */}
          <div>
            <h4 style={{ color: "#888", fontSize: "12px", marginBottom: "8px" }}>Parameters</h4>
            <pre
              style={{
                background: "#0a0a0a",
                padding: "12px",
                borderRadius: "6px",
                color: "#ccc",
                fontSize: "11px",
                overflow: "auto",
                maxHeight: "200px",
                margin: 0,
              }}
            >
              {JSON.stringify(task.params, null, 2)}
            </pre>
          </div>
        </div>

        {/* Footer with actions */}
        {(canPause || canResume || canCancel) && (
          <div
            style={{
              padding: "16px 20px",
              borderTop: "1px solid #222",
              display: "flex",
              justifyContent: "flex-end",
              gap: "12px",
            }}
          >
            {canPause && (
              <button
                onClick={() => handleAction("pause")}
                disabled={acting}
                style={{
                  padding: "10px 20px",
                  background: acting ? "#333" : "#854d0e",
                  border: "none",
                  borderRadius: "6px",
                  color: "#fff",
                  cursor: acting ? "not-allowed" : "pointer",
                  fontSize: "13px",
                }}
              >
                ⏸️ Pause
              </button>
            )}
            {canResume && (
              <button
                onClick={() => handleAction("resume")}
                disabled={acting}
                style={{
                  padding: "10px 20px",
                  background: acting ? "#333" : "#166534",
                  border: "none",
                  borderRadius: "6px",
                  color: "#fff",
                  cursor: acting ? "not-allowed" : "pointer",
                  fontSize: "13px",
                }}
              >
                ▶️ Resume
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Task Row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: Task;
  onClick: () => void;
}

function TaskRow({ task, onClick }: TaskRowProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr 120px 120px 100px",
        gap: "16px",
        padding: "12px 16px",
        background: "#111",
        border: "1px solid #222",
        borderRadius: "6px",
        cursor: "pointer",
        alignItems: "center",
        transition: "border-color 0.15s ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#444")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#222")}
    >
      {/* Time */}
      <div>
        <div style={{ color: "#fff", fontSize: "13px" }}>
          {new Date(task.scheduled_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div style={{ color: "#666", fontSize: "11px" }}>
          {new Date(task.scheduled_time).toLocaleDateString()}
        </div>
      </div>

      {/* Routine + Device */}
      <div>
        <div style={{ color: "#fff", fontSize: "13px" }}>{task.routine}</div>
        <div style={{ color: "#666", fontSize: "11px" }}>
          {task.device_name || task.device_id.slice(0, 8)}
          {task.account_username && ` · @${task.account_username}`}
        </div>
      </div>

      {/* Platform */}
      <div style={{ color: "#888", fontSize: "12px" }}>
        {task.account_platform || "—"}
      </div>

      {/* Batch */}
      <div style={{ color: "#666", fontSize: "11px", fontFamily: "monospace" }}>
        {task.batch_id ? task.batch_id.slice(0, 8) : "—"}
      </div>

      {/* Status */}
      <div>
        <StatusBadge status={task.status} />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("");

  // Stats
  const stats = {
    total: tasks.length,
    queued: tasks.filter((t) => t.status === "queued").length,
    running: tasks.filter((t) => t.status === "running").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    paused: tasks.filter((t) => t.status === "paused").length,
  };

  const fetchTasks = useCallback(async () => {
    try {
      const data = await agencyApi.tasks.list({
        status: statusFilter || undefined,
        pageSize: 100,
      });
      setTasks(data.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchTasks();
    // Poll for updates
    const interval = setInterval(fetchTasks, 10000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Group by date
  const groupedByDate = tasks.reduce(
    (acc, task) => {
      const date = new Date(task.scheduled_time).toLocaleDateString();
      if (!acc[date]) acc[date] = [];
      acc[date].push(task);
      return acc;
    },
    {} as Record<string, Task[]>
  );

  // Sort dates descending
  const sortedDates = Object.keys(groupedByDate).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime()
  );

  const handleAction = async (taskId: string, action: "pause" | "resume" | "cancel") => {
    try {
      if (action === "pause") {
        await agencyApi.tasks.pause(taskId);
      } else if (action === "resume") {
        await agencyApi.tasks.resume(taskId);
      }
      // Note: cancel not implemented in API yet
      await fetchTasks();
    } catch (e) {
      alert(`Failed to ${action}: ${(e as Error).message}`);
    }
  };

  return (
    <AgencyLayout currentRoute="#/agency/tasks">
      {/* Pulse animation style */}
      <style>
        {`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
        `}
      </style>

      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>⚡ Tasks</h1>
        <p style={{ color: "#666", margin: "8px 0 0", fontSize: "13px" }}>
          Scheduled automation tasks and their execution status
        </p>
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
          { key: "", label: "All", count: stats.total, color: "#a78bfa" },
          { key: "queued", label: "Queued", count: stats.queued, color: "#9ca3af" },
          { key: "running", label: "Running", count: stats.running, color: "#60a5fa" },
          { key: "completed", label: "Completed", count: stats.completed, color: "#4ade80" },
          { key: "failed", label: "Failed", count: stats.failed, color: "#f87171" },
          { key: "paused", label: "Paused", count: stats.paused, color: "#fbbf24" },
        ].map((stat) => (
          <div
            key={stat.key}
            onClick={() => setStatusFilter(stat.key)}
            style={{
              padding: "12px 20px",
              background: statusFilter === stat.key ? "#1a1a2e" : "#111",
              border: `1px solid ${statusFilter === stat.key ? "#333" : "#222"}`,
              borderRadius: "8px",
              cursor: "pointer",
              textAlign: "center",
              minWidth: "80px",
            }}
          >
            <div style={{ color: stat.color, fontSize: "20px", fontWeight: 600 }}>{stat.count}</div>
            <div style={{ color: "#888", fontSize: "11px" }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
        <button
          onClick={fetchTasks}
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

      {/* Table header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "140px 1fr 120px 120px 100px",
          gap: "16px",
          padding: "8px 16px",
          color: "#666",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          marginBottom: "8px",
        }}
      >
        <div>Scheduled</div>
        <div>Routine / Device</div>
        <div>Platform</div>
        <div>Batch</div>
        <div>Status</div>
      </div>

      {/* Loading */}
      {loading ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>Loading...</div>
      ) : tasks.length === 0 ? (
        <div style={{ color: "#666", textAlign: "center", padding: "40px" }}>
          No tasks found. {statusFilter && "Try clearing the filter."}
        </div>
      ) : (
        /* Timeline grouped by date */
        <div>
          {sortedDates.map((date) => (
            <div key={date} style={{ marginBottom: "24px" }}>
              <h3
                style={{
                  color: "#888",
                  fontSize: "12px",
                  fontWeight: 500,
                  marginBottom: "8px",
                  paddingLeft: "4px",
                }}
              >
                📅 {date}
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {groupedByDate[date]
                  .sort((a, b) => new Date(b.scheduled_time).getTime() - new Date(a.scheduled_time).getTime())
                  .map((task) => (
                    <TaskRow key={task.id} task={task} onClick={() => setSelectedTask(task)} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {selectedTask && (
        <TaskModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onAction={(action) => handleAction(selectedTask.id, action)}
        />
      )}
    </AgencyLayout>
  );
}
