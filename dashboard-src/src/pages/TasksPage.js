import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * TasksPage.tsx
 * Tasks timeline view — status badges, filters, details modal.
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
function TaskModal({ task, definition, transitions, onClose, onAction }) {
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
                width: "550px",
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
                    }, children: [_jsxs("div", { children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px" }, children: [_jsx("span", { style: { color: "#fff", fontSize: "15px", fontWeight: 500 }, children: "Task Details" }), _jsx(StatusBadge, { status: task.status, definition: definition })] }), _jsx("div", { style: { color: "#666", fontSize: "12px", marginTop: "4px" }, children: task.routine })] }), _jsx("button", { onClick: onClose, style: {
                                background: "none",
                                border: "none",
                                color: "#666",
                                fontSize: "20px",
                                cursor: "pointer",
                            }, children: "\u00D7" })] }), _jsxs("div", { style: { padding: "20px", overflowY: "auto", flex: 1 }, children: [_jsxs("div", { style: {
                                display: "grid",
                                gridTemplateColumns: "1fr 1fr",
                                gap: "16px",
                                marginBottom: "20px",
                            }, children: [_jsxs("div", { style: { background: "#0a0a0a", padding: "12px", borderRadius: "6px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "11px", marginBottom: "4px" }, children: "Device" }), _jsx("div", { style: { color: "#fff", fontSize: "13px" }, children: task.device_name || task.device_id })] }), _jsxs("div", { style: { background: "#0a0a0a", padding: "12px", borderRadius: "6px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "11px", marginBottom: "4px" }, children: "Account" }), _jsxs("div", { style: { color: "#fff", fontSize: "13px" }, children: ["@", task.account_username || "N/A", task.account_platform && _jsxs("span", { style: { color: "#888" }, children: [" \u00B7 ", task.account_platform] })] })] }), _jsxs("div", { style: { background: "#0a0a0a", padding: "12px", borderRadius: "6px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "11px", marginBottom: "4px" }, children: "Scheduled" }), _jsx("div", { style: { color: "#fff", fontSize: "13px" }, children: new Date(task.scheduled_time).toLocaleString() })] }), _jsxs("div", { style: { background: "#0a0a0a", padding: "12px", borderRadius: "6px" }, children: [_jsx("div", { style: { color: "#666", fontSize: "11px", marginBottom: "4px" }, children: "Batch ID" }), _jsx("div", { style: { color: "#fff", fontSize: "13px" }, children: task.batch_id || "—" })] })] }), _jsxs("div", { style: { marginBottom: "20px" }, children: [_jsx("h4", { style: { color: "#888", fontSize: "12px", marginBottom: "8px" }, children: "Timeline" }), _jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "8px" }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }, children: [_jsx("span", { children: "Created:" }), _jsx("span", { children: new Date(task.created_at).toLocaleString() })] }), task.started_at && (_jsxs("div", { style: { display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }, children: [_jsx("span", { children: "Started:" }), _jsx("span", { children: new Date(task.started_at).toLocaleString() })] })), task.completed_at && (_jsxs("div", { style: { display: "flex", justifyContent: "space-between", color: "#ccc", fontSize: "12px" }, children: [_jsx("span", { children: "Completed:" }), _jsx("span", { children: new Date(task.completed_at).toLocaleString() })] }))] })] }), _jsxs("div", { children: [_jsx("h4", { style: { color: "#888", fontSize: "12px", marginBottom: "8px" }, children: "Parameters" }), _jsx("pre", { style: {
                                        background: "#0a0a0a",
                                        padding: "12px",
                                        borderRadius: "6px",
                                        color: "#ccc",
                                        fontSize: "11px",
                                        overflow: "auto",
                                        maxHeight: "200px",
                                        margin: 0,
                                    }, children: JSON.stringify(task.params, null, 2) })] })] }), transitions.length > 0 && (_jsx("div", { style: {
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
                        }, children: target.description ?? target.status }, target.status))) }))] }) }));
}
function TaskRow({ task, definition, onClick }) {
    return (_jsxs("div", { onClick: onClick, style: {
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
        }, onMouseEnter: (e) => (e.currentTarget.style.borderColor = "#444"), onMouseLeave: (e) => (e.currentTarget.style.borderColor = "#222"), children: [_jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "13px" }, children: new Date(task.scheduled_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }), _jsx("div", { style: { color: "#666", fontSize: "11px" }, children: new Date(task.scheduled_time).toLocaleDateString() })] }), _jsxs("div", { children: [_jsx("div", { style: { color: "#fff", fontSize: "13px" }, children: task.routine }), _jsxs("div", { style: { color: "#666", fontSize: "11px" }, children: [task.device_name || task.device_id.slice(0, 8), task.account_username && ` · @${task.account_username}`] })] }), _jsx("div", { style: { color: "#888", fontSize: "12px" }, children: task.account_platform || "—" }), _jsx("div", { style: { color: "#666", fontSize: "11px", fontFamily: "monospace" }, children: task.batch_id ? task.batch_id.slice(0, 8) : "—" }), _jsx("div", { children: _jsx(StatusBadge, { status: task.status, definition: definition }) })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function TasksPage() {
    const [tasks, setTasks] = useState([]);
    const [definitions, setDefinitions] = useState([]);
    const [selectedTransitions, setSelectedTransitions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedTask, setSelectedTask] = useState(null);
    // Filters
    const [statusFilter, setStatusFilter] = useState("");
    // Stats
    const definitionByStatus = new Map(definitions.map((definition) => [definition.status, definition]));
    const statusStats = definitions.map((definition) => ({
        key: definition.status,
        label: definition.description ?? definition.status,
        count: tasks.filter((task) => task.status === definition.status).length,
    }));
    const fetchTasks = useCallback(async () => {
        try {
            const [data, lifecycleDefinitions] = await Promise.all([
                agencyApi.tasks.list({ status: statusFilter || undefined, pageSize: 100 }),
                agencyApi.tasks.definitions(),
            ]);
            setTasks(data.items);
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
        fetchTasks();
        // Poll for updates
        const interval = setInterval(fetchTasks, 10000);
        return () => clearInterval(interval);
    }, [fetchTasks]);
    // Group by date
    const groupedByDate = tasks.reduce((acc, task) => {
        const date = new Date(task.scheduled_time).toLocaleDateString();
        if (!acc[date])
            acc[date] = [];
        acc[date].push(task);
        return acc;
    }, {});
    // Sort dates descending
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    const selectTask = async (task) => {
        setSelectedTask(task);
        setSelectedTransitions(await agencyApi.tasks.transitions(task.id));
    };
    const handleAction = async (taskId, targetStatus) => {
        try {
            await agencyApi.tasks.transition(taskId, targetStatus);
            await fetchTasks();
        }
        catch (e) {
            alert(`Failed to transition task: ${e.message}`);
        }
    };
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/tasks", children: [_jsx("style", { children: `
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
        ` }), _jsxs("div", { style: { marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\u26A1 Tasks" }), _jsx("p", { style: { color: "#666", margin: "8px 0 0", fontSize: "13px" }, children: "Scheduled automation tasks and their execution status" })] }), _jsx("div", { style: {
                    display: "flex",
                    gap: "12px",
                    marginBottom: "24px",
                    flexWrap: "wrap",
                }, children: [
                    { key: "", label: "All", count: tasks.length },
                    ...statusStats,
                ].map((stat) => (_jsxs("div", { onClick: () => setStatusFilter(stat.key), style: {
                        padding: "12px 20px",
                        background: statusFilter === stat.key ? "#1a1a2e" : "#111",
                        border: `1px solid ${statusFilter === stat.key ? "#333" : "#222"}`,
                        borderRadius: "8px",
                        cursor: "pointer",
                        textAlign: "center",
                        minWidth: "80px",
                    }, children: [_jsx("div", { style: { color: "#d4d4d8", fontSize: "20px", fontWeight: 600 }, children: stat.count }), _jsx("div", { style: { color: "#888", fontSize: "11px" }, children: stat.label })] }, stat.key))) }), _jsx("div", { style: { display: "flex", gap: "12px", marginBottom: "20px" }, children: _jsx("button", { onClick: fetchTasks, style: {
                        padding: "8px 16px",
                        background: "#1a1a2e",
                        border: "1px solid #333",
                        borderRadius: "6px",
                        color: "#ccc",
                        cursor: "pointer",
                        fontSize: "13px",
                    }, children: "\uD83D\uDD04 Refresh" }) }), error && (_jsxs("div", { style: {
                    padding: "12px 16px",
                    background: "#2a1515",
                    borderRadius: "6px",
                    color: "#f88",
                    marginBottom: "16px",
                }, children: ["\u26A0\uFE0F ", error] })), _jsxs("div", { style: {
                    display: "grid",
                    gridTemplateColumns: "140px 1fr 120px 120px 100px",
                    gap: "16px",
                    padding: "8px 16px",
                    color: "#666",
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    marginBottom: "8px",
                }, children: [_jsx("div", { children: "Scheduled" }), _jsx("div", { children: "Routine / Device" }), _jsx("div", { children: "Platform" }), _jsx("div", { children: "Batch" }), _jsx("div", { children: "Status" })] }), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : tasks.length === 0 ? (_jsxs("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: ["No tasks found. ", statusFilter && "Try clearing the filter."] })) : (
            /* Timeline grouped by date */
            _jsx("div", { children: sortedDates.map((date) => (_jsxs("div", { style: { marginBottom: "24px" }, children: [_jsxs("h3", { style: {
                                color: "#888",
                                fontSize: "12px",
                                fontWeight: 500,
                                marginBottom: "8px",
                                paddingLeft: "4px",
                            }, children: ["\uD83D\uDCC5 ", date] }), _jsx("div", { style: { display: "flex", flexDirection: "column", gap: "8px" }, children: groupedByDate[date]
                                .sort((a, b) => new Date(b.scheduled_time).getTime() - new Date(a.scheduled_time).getTime())
                                .map((task) => (_jsx(TaskRow, { task: task, definition: definitionByStatus.get(task.status), onClick: () => void selectTask(task) }, task.id))) })] }, date))) })), selectedTask && (_jsx(TaskModal, { task: selectedTask, definition: definitionByStatus.get(selectedTask.status), transitions: selectedTransitions, onClose: () => setSelectedTask(null), onAction: (targetStatus) => handleAction(selectedTask.id, targetStatus) }))] }));
}
