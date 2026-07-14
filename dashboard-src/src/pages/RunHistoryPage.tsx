/**
 * RunHistoryPage.tsx
 * Read-only generated workflow run history with derived step timeline.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, WorkflowRun, WorkflowRunFeedbackRating } from "../api/agency";

const statusColors: Record<string, { bg: string; color: string; label: string }> = {
  queued: { bg: "#313244", color: "#cdd6f4", label: "Queued" },
  running: { bg: "#12314f", color: "#60a5fa", label: "Running" },
  completed: { bg: "#0f3323", color: "#4ade80", label: "Succeeded" },
  failed: { bg: "#3a1618", color: "#f87171", label: "Failed" },
  partial: { bg: "#332b12", color: "#fbbf24", label: "Partial" },
  cancelled: { bg: "#2b2b2b", color: "#a1a1aa", label: "Cancelled" },
};

const artifactColors: Record<string, { bg: string; color: string; label: string }> = {
  candidate: { bg: "#2f2a12", color: "#facc15", label: "Candidate" },
  promoted: { bg: "#0f3323", color: "#4ade80", label: "Promoted" },
  quarantined: { bg: "#3a1618", color: "#f87171", label: "Quarantined" },
  failed: { bg: "#3a1618", color: "#f87171", label: "Failed" },
};

const feedbackColors: Record<string, { bg: string; color: string; label: string }> = {
  ok: { bg: "#0f3323", color: "#4ade80", label: "OK" },
  not_ok: { bg: "#3a1618", color: "#f87171", label: "Not OK" },
  partial: { bg: "#332b12", color: "#fbbf24", label: "Partial" },
};

function Badge({ value, palette }: { value: string | null | undefined; palette: Record<string, { bg: string; color: string; label: string }> }) {
  if (!value) return null;
  const config = palette[value] ?? { bg: "#27272a", color: "#d4d4d8", label: value };
  return (
    <span style={{ padding: "3px 8px", borderRadius: "6px", background: config.bg, color: config.color, fontSize: "11px" }}>
      {config.label}
    </span>
  );
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

function duration(run: WorkflowRun) {
  const start = run.startedAt ?? run.createdAt;
  const end = run.completedAt ?? run.updatedAt;
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

export function RunHistoryPage() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<WorkflowRunFeedbackRating>("ok");
  const [lastGoodStepIndex, setLastGoodStepIndex] = useState("");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await agencyApi.workflowRuns.list({ pageSize: 50, status: statusFilter || undefined });
      setRuns(data.items);
      if (!selectedId && data.items[0]) setSelectedId(data.items[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run history");
    } finally {
      setLoading(false);
    }
  }, [selectedId, statusFilter]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedRun(null);
      return;
    }
    setDetailLoading(true);
    agencyApi.workflowRuns.get(selectedId)
      .then(setSelectedRun)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load workflow run"))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedRun?.feedback) {
      setFeedbackRating("ok");
      setLastGoodStepIndex("");
      setFeedbackNote("");
      setFeedbackMessage(null);
      return;
    }
    setFeedbackRating(selectedRun.feedback.rating);
    setLastGoodStepIndex(
      selectedRun.feedback.lastGoodStepIndex === null ? "" : String(selectedRun.feedback.lastGoodStepIndex)
    );
    setFeedbackNote(selectedRun.feedback.note ?? "");
    setFeedbackMessage(null);
  }, [selectedRun?.id, selectedRun?.feedback]);

  const submitFeedback = useCallback(async () => {
    if (!selectedRun) return;
    if (feedbackRating === "partial" && lastGoodStepIndex === "") {
      setFeedbackMessage("Select the last good step for Partial.");
      return;
    }
    setFeedbackSaving(true);
    setFeedbackMessage(null);
    try {
      const updated = await agencyApi.workflowRuns.submitFeedback(selectedRun.id, {
        rating: feedbackRating,
        lastGoodStepIndex: feedbackRating === "partial" ? Number(lastGoodStepIndex) : null,
        note: feedbackNote.trim() || null,
      });
      setSelectedRun(updated);
      setRuns((current) => current.map((run) => run.id === updated.id ? { ...run, feedback: updated.feedback } : run));
      setFeedbackMessage("Feedback saved.");
    } catch (err) {
      setFeedbackMessage(err instanceof Error ? err.message : "Failed to save feedback");
    } finally {
      setFeedbackSaving(false);
    }
  }, [feedbackNote, feedbackRating, lastGoodStepIndex, selectedRun]);

  const counts = useMemo(() => ({
    total: runs.length,
    running: runs.filter((run) => run.status === "running").length,
    succeeded: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
  }), [runs]);

  return (
    <AgencyLayout currentRoute="#/agency/runs">
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>Run History</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(110px, 1fr))", gap: "12px", marginBottom: "18px" }}>
        {([
          ["Total", counts.total, "#d4d4d8"],
          ["Running", counts.running, "#60a5fa"],
          ["Succeeded", counts.succeeded, "#4ade80"],
          ["Failed", counts.failed, "#f87171"],
        ] as Array<[string, number, string]>).map(([label, value, color]) => (
          <div key={label} style={{ background: "#111", border: "1px solid #222", borderRadius: "6px", padding: "14px" }}>
            <div style={{ color: "#777", fontSize: "11px", marginBottom: "6px" }}>{label}</div>
            <div style={{ color, fontSize: "22px", fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "14px" }}>
        <select
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value);
            setSelectedId(null);
          }}
          style={{ background: "#111", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px 10px" }}
        >
          <option value="">All statuses</option>
          <option value="completed">Succeeded</option>
          <option value="running">Running</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
        </select>
        <button
          onClick={() => void loadRuns()}
          style={{ background: "#1f2937", border: "1px solid #374151", color: "#e5e7eb", borderRadius: "6px", padding: "8px 12px", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {error && <div style={{ color: "#f87171", background: "#1a0d0d", border: "1px solid #3a1618", borderRadius: "6px", padding: "10px", marginBottom: "14px" }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(380px, 1.1fr) minmax(360px, 0.9fr)", gap: "16px", alignItems: "start" }}>
        <div style={{ border: "1px solid #222", borderRadius: "6px", overflow: "hidden", background: "#0d0d0d" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 0.8fr 0.8fr 0.7fr", gap: "10px", padding: "10px 12px", color: "#777", fontSize: "11px", borderBottom: "1px solid #222" }}>
            <div>Request</div>
            <div>Status</div>
            <div>Time</div>
            <div>Duration</div>
          </div>
          {loading ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>Loading...</div>
          ) : runs.length === 0 ? (
            <div style={{ padding: "32px", color: "#777", textAlign: "center" }}>No runs found.</div>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedId(run.id)}
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: "1.5fr 0.8fr 0.8fr 0.7fr",
                  gap: "10px",
                  alignItems: "center",
                  padding: "12px",
                  background: selectedId === run.id ? "#151515" : "transparent",
                  border: 0,
                  borderBottom: "1px solid #1f1f1f",
                  color: "#ddd",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" }}>{run.intent}</div>
                  <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>
                    {run.platform} · {run.deviceName ?? run.shortDeviceId ?? "device"} · {run.requestKey ? "AI" : "manual"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <Badge value={run.status} palette={statusColors} />
                  <Badge value={run.artifactState} palette={artifactColors} />
                </div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>{formatDate(run.createdAt)}</div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>{duration(run)}</div>
              </button>
            ))
          )}
        </div>

        <div style={{ border: "1px solid #222", borderRadius: "6px", background: "#0d0d0d", padding: "16px" }}>
          {detailLoading ? (
            <div style={{ color: "#777", textAlign: "center", padding: "28px" }}>Loading timeline...</div>
          ) : selectedRun ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "start", marginBottom: "14px" }}>
                <div>
                  <h2 style={{ color: "#fff", fontSize: "16px", margin: "0 0 6px" }}>Timeline</h2>
                  <div style={{ color: "#777", fontSize: "12px" }}>{selectedRun.canonicalWorkflowId}</div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Badge value={selectedRun.workflowStatus ?? selectedRun.status} palette={statusColors} />
                  <Badge value={selectedRun.feedback?.rating} palette={feedbackColors} />
                </div>
              </div>
              <div style={{ border: "1px solid #222", borderRadius: "6px", padding: "12px", marginBottom: "14px", background: "#101010" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
                  <div>
                    <div style={{ color: "#e5e7eb", fontSize: "13px", fontWeight: 600 }}>Feedback</div>
                    {selectedRun.feedback?.at && (
                      <div style={{ color: "#777", fontSize: "11px", marginTop: "3px" }}>
                        Saved {formatDate(selectedRun.feedback.at)}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {(["ok", "not_ok", "partial"] as WorkflowRunFeedbackRating[]).map((rating) => (
                      <button
                        key={rating}
                        onClick={() => setFeedbackRating(rating)}
                        style={{
                          background: feedbackRating === rating ? feedbackColors[rating].bg : "#151515",
                          border: `1px solid ${feedbackRating === rating ? feedbackColors[rating].color : "#333"}`,
                          color: feedbackRating === rating ? feedbackColors[rating].color : "#d4d4d8",
                          borderRadius: "6px",
                          padding: "7px 9px",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        {feedbackColors[rating].label}
                      </button>
                    ))}
                  </div>
                </div>
                {feedbackRating === "partial" && (
                  <label style={{ display: "block", color: "#aaa", fontSize: "12px", marginBottom: "10px" }}>
                    Last good step
                    <select
                      value={lastGoodStepIndex}
                      onChange={(event) => setLastGoodStepIndex(event.target.value)}
                      style={{ marginTop: "5px", width: "100%", background: "#0d0d0d", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px" }}
                    >
                      <option value="">Select step</option>
                      {(selectedRun.timeline ?? []).map((step) => (
                        <option key={step.index} value={step.index}>
                          {step.index + 1}. {step.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <textarea
                  value={feedbackNote}
                  onChange={(event) => setFeedbackNote(event.target.value.slice(0, 1000))}
                  placeholder="Optional note"
                  rows={3}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: "#0d0d0d", border: "1px solid #333", color: "#ddd", borderRadius: "6px", padding: "8px", fontSize: "12px", marginBottom: "10px" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                  <button
                    onClick={() => void submitFeedback()}
                    disabled={feedbackSaving || (feedbackRating === "partial" && lastGoodStepIndex === "")}
                    style={{
                      background: feedbackSaving ? "#27272a" : "#1f2937",
                      border: "1px solid #374151",
                      color: "#e5e7eb",
                      borderRadius: "6px",
                      padding: "8px 12px",
                      cursor: feedbackSaving ? "wait" : "pointer",
                      opacity: feedbackRating === "partial" && lastGoodStepIndex === "" ? 0.55 : 1,
                    }}
                  >
                    {feedbackSaving ? "Saving..." : "Save feedback"}
                  </button>
                  {feedbackMessage && (
                    <div style={{ color: feedbackMessage.includes("saved") ? "#4ade80" : "#fbbf24", fontSize: "12px", textAlign: "right" }}>
                      {feedbackMessage}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {(selectedRun.timeline ?? []).length === 0 ? (
                  <div style={{ color: "#777", padding: "18px", textAlign: "center" }}>No timeline available.</div>
                ) : (
                  selectedRun.timeline!.map((step) => (
                    <div key={`${step.index}-${step.id}`} style={{ display: "grid", gridTemplateColumns: "26px 1fr", gap: "10px" }}>
                      <div style={{ width: "24px", height: "24px", borderRadius: "50%", background: statusColors[step.status]?.bg ?? "#27272a", color: statusColors[step.status]?.color ?? "#d4d4d8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px" }}>
                        {step.index + 1}
                      </div>
                      <div style={{ borderBottom: "1px solid #1f1f1f", paddingBottom: "10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
                          <div style={{ color: "#e5e7eb", fontSize: "13px" }}>{step.label}</div>
                          <Badge value={step.status} palette={statusColors} />
                        </div>
                        <div style={{ color: "#666", fontSize: "11px", marginTop: "4px" }}>{step.id}</div>
                        {step.error && <div style={{ color: "#f87171", fontSize: "12px", marginTop: "6px" }}>{step.error}</div>}
                        {step.state && <div style={{ color: "#fbbf24", fontSize: "11px", marginTop: "4px" }}>{step.state}</div>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div style={{ color: "#777", textAlign: "center", padding: "28px" }}>Select a run.</div>
          )}
        </div>
      </div>
    </AgencyLayout>
  );
}
