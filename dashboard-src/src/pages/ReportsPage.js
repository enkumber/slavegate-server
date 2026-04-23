import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * ReportsPage.tsx
 * Reports dashboard — stats cards, charts, date filtering.
 */
import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi } from "../api/agency";
function StatsCard({ icon, label, value, subtext, color }) {
    return (_jsxs("div", { style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "12px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
        }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }, children: [_jsx("span", { style: { fontSize: "20px" }, children: icon }), _jsx("span", { style: { color: "#888", fontSize: "13px" }, children: label })] }), _jsx("div", { style: { color, fontSize: "32px", fontWeight: 600, lineHeight: 1 }, children: value }), subtext && (_jsx("div", { style: { color: "#666", fontSize: "12px", marginTop: "8px" }, children: subtext }))] }));
}
function SimpleBarChart({ data, title, height = 200 }) {
    const maxValue = Math.max(...data.map((d) => d.value), 1);
    return (_jsxs("div", { style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "12px",
            padding: "20px",
        }, children: [_jsx("h3", { style: { color: "#fff", fontSize: "14px", margin: "0 0 20px 0" }, children: title }), _jsx("div", { style: {
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "space-between",
                    height,
                    gap: "8px",
                }, children: data.map((item, i) => (_jsxs("div", { style: {
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        height: "100%",
                    }, children: [_jsx("div", { style: {
                                flex: 1,
                                width: "100%",
                                display: "flex",
                                flexDirection: "column",
                                justifyContent: "flex-end",
                            }, children: _jsx("div", { style: {
                                    height: `${(item.value / maxValue) * 100}%`,
                                    minHeight: item.value > 0 ? "4px" : "0",
                                    background: item.color || "#60a5fa",
                                    borderRadius: "4px 4px 0 0",
                                    transition: "height 0.3s ease",
                                } }) }), _jsx("div", { style: {
                                color: "#fff",
                                fontSize: "11px",
                                marginTop: "8px",
                                fontWeight: 500,
                            }, children: item.value }), _jsx("div", { style: {
                                color: "#666",
                                fontSize: "10px",
                                marginTop: "4px",
                                textAlign: "center",
                            }, children: item.label })] }, i))) })] }));
}
function SimplePieChart({ data, title }) {
    const total = data.reduce((acc, d) => acc + d.value, 0);
    let cumulativePercent = 0;
    // Generate conic gradient
    const segments = data
        .filter((d) => d.value > 0)
        .map((d) => {
        const percent = (d.value / total) * 100;
        const start = cumulativePercent;
        cumulativePercent += percent;
        return `${d.color} ${start}% ${cumulativePercent}%`;
    })
        .join(", ");
    return (_jsxs("div", { style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "12px",
            padding: "20px",
        }, children: [_jsx("h3", { style: { color: "#fff", fontSize: "14px", margin: "0 0 20px 0" }, children: title }), _jsxs("div", { style: { display: "flex", alignItems: "center", gap: "24px" }, children: [_jsx("div", { style: {
                            width: "120px",
                            height: "120px",
                            borderRadius: "50%",
                            background: total > 0 ? `conic-gradient(${segments})` : "#222",
                            position: "relative",
                        }, children: _jsx("div", { style: {
                                position: "absolute",
                                top: "50%",
                                left: "50%",
                                transform: "translate(-50%, -50%)",
                                width: "60px",
                                height: "60px",
                                borderRadius: "50%",
                                background: "#111",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                color: "#fff",
                                fontSize: "16px",
                                fontWeight: 600,
                            }, children: total }) }), _jsx("div", { style: { display: "flex", flexDirection: "column", gap: "8px" }, children: data.map((d, i) => (_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [_jsx("div", { style: {
                                        width: "12px",
                                        height: "12px",
                                        borderRadius: "2px",
                                        background: d.color,
                                    } }), _jsx("span", { style: { color: "#888", fontSize: "12px" }, children: d.label }), _jsx("span", { style: { color: "#fff", fontSize: "12px", fontWeight: 500 }, children: d.value })] }, i))) })] })] }));
}
function ReportCard({ report }) {
    const typeIcons = {
        daily_analytics: "📊",
        weekly: "📈",
        anomaly: "⚠️",
    };
    const typeColors = {
        daily_analytics: "#60a5fa",
        weekly: "#a78bfa",
        anomaly: "#fbbf24",
    };
    return (_jsxs("div", { style: {
            background: "#111",
            border: "1px solid #222",
            borderRadius: "8px",
            padding: "16px",
        }, children: [_jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" }, children: [_jsxs("div", { children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [_jsx("span", { style: { fontSize: "16px" }, children: typeIcons[report.type] || "📋" }), _jsx("span", { style: {
                                            color: typeColors[report.type] || "#ccc",
                                            fontSize: "13px",
                                            fontWeight: 500,
                                            textTransform: "capitalize",
                                        }, children: report.type.replace("_", " ") })] }), _jsxs("div", { style: { color: "#666", fontSize: "12px", marginTop: "4px" }, children: ["Period: ", report.period] })] }), _jsx("div", { style: { color: "#555", fontSize: "11px" }, children: new Date(report.created_at).toLocaleDateString() })] }), _jsx("div", { style: {
                    marginTop: "12px",
                    padding: "10px",
                    background: "#0a0a0a",
                    borderRadius: "4px",
                    maxHeight: "100px",
                    overflow: "auto",
                }, children: _jsxs("pre", { style: { margin: 0, color: "#888", fontSize: "10px" }, children: [JSON.stringify(report.data, null, 2).slice(0, 200), JSON.stringify(report.data).length > 200 ? "..." : ""] }) })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function ReportsPage() {
    const [stats, setStats] = useState(null);
    const [reports, setReports] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Date range
    const [dateFrom, setDateFrom] = useState(() => {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        return d.toISOString().split("T")[0];
    });
    const [dateTo, setDateTo] = useState(() => {
        return new Date().toISOString().split("T")[0];
    });
    // Report type filter
    const [typeFilter, setTypeFilter] = useState("");
    const fetchData = useCallback(async () => {
        try {
            const [statsData, reportsData] = await Promise.all([
                agencyApi.reports.stats(),
                agencyApi.reports.list({
                    type: typeFilter || undefined,
                    from: dateFrom,
                    to: dateTo,
                    pageSize: 20,
                }),
            ]);
            setStats(statsData);
            setReports(reportsData.items);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [dateFrom, dateTo, typeFilter]);
    useEffect(() => {
        fetchData();
    }, [fetchData]);
    // Generate mock chart data from stats
    const postsChartData = stats
        ? [
            { label: "Pending", value: Number(stats.posts.pending) || 0, color: "#fbbf24" },
            { label: "Approved", value: Number(stats.posts.approved) || 0, color: "#4ade80" },
            { label: "Rejected", value: Number(stats.posts.rejected) || 0, color: "#f87171" },
            { label: "Published", value: Number(stats.posts.published) || 0, color: "#60a5fa" },
        ]
        : [];
    const tasksChartData = stats
        ? [
            { label: "Completed", value: Number(stats.tasks.completed) || 0, color: "#4ade80" },
            { label: "Failed", value: Number(stats.tasks.failed) || 0, color: "#f87171" },
            { label: "Running", value: Number(stats.tasks.running) || 0, color: "#60a5fa" },
            { label: "Queued", value: Number(stats.tasks.queued) || 0, color: "#9ca3af" },
        ]
        : [];
    const materialsChartData = stats
        ? [
            { label: "Used", value: Number(stats.materials.used) || 0, color: "#4ade80" },
            { label: "Unused", value: Number(stats.materials.unused) || 0, color: "#fbbf24" },
        ]
        : [];
    return (_jsxs(AgencyLayout, { currentRoute: "#/agency/reports", children: [_jsxs("div", { style: { marginBottom: "24px" }, children: [_jsx("h1", { style: { color: "#fff", margin: 0, fontSize: "24px" }, children: "\uD83D\uDCCA Reports" }), _jsx("p", { style: { color: "#666", margin: "8px 0 0", fontSize: "13px" }, children: "Analytics dashboard and generated reports" })] }), _jsxs("div", { style: {
                    display: "flex",
                    gap: "12px",
                    marginBottom: "24px",
                    alignItems: "center",
                    flexWrap: "wrap",
                }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [_jsx("label", { style: { color: "#888", fontSize: "13px" }, children: "From:" }), _jsx("input", { type: "date", value: dateFrom, onChange: (e) => setDateFrom(e.target.value), style: {
                                    padding: "8px 12px",
                                    background: "#1a1a1a",
                                    border: "1px solid #333",
                                    borderRadius: "6px",
                                    color: "#ccc",
                                    fontSize: "13px",
                                } })] }), _jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [_jsx("label", { style: { color: "#888", fontSize: "13px" }, children: "To:" }), _jsx("input", { type: "date", value: dateTo, onChange: (e) => setDateTo(e.target.value), style: {
                                    padding: "8px 12px",
                                    background: "#1a1a1a",
                                    border: "1px solid #333",
                                    borderRadius: "6px",
                                    color: "#ccc",
                                    fontSize: "13px",
                                } })] }), _jsx("button", { onClick: fetchData, style: {
                            padding: "8px 16px",
                            background: "#2563eb",
                            border: "none",
                            borderRadius: "6px",
                            color: "#fff",
                            cursor: "pointer",
                            fontSize: "13px",
                        }, children: "Apply" })] }), error && (_jsxs("div", { style: {
                    padding: "12px 16px",
                    background: "#2a1515",
                    borderRadius: "6px",
                    color: "#f88",
                    marginBottom: "16px",
                }, children: ["\u26A0\uFE0F ", error] })), loading ? (_jsx("div", { style: { color: "#666", textAlign: "center", padding: "40px" }, children: "Loading..." })) : (_jsxs(_Fragment, { children: [_jsxs("div", { style: {
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                            gap: "16px",
                            marginBottom: "32px",
                        }, children: [_jsx(StatsCard, { icon: "\uD83D\uDC65", label: "Total Clients", value: stats?.clients.total || 0, subtext: `${stats?.clients.active || 0} active`, color: "#a78bfa" }), _jsx(StatsCard, { icon: "\uD83D\uDCDD", label: "Total Posts", value: stats?.posts.total || 0, subtext: `${stats?.posts.pending || 0} pending approval`, color: "#60a5fa" }), _jsx(StatsCard, { icon: "\u26A1", label: "Total Tasks", value: stats?.tasks.total || 0, subtext: `${stats?.tasks.completed || 0} completed`, color: "#4ade80" }), _jsx(StatsCard, { icon: "\uD83D\uDCC1", label: "Materials", value: stats?.materials.total || 0, subtext: `${stats?.materials.unused || 0} unused`, color: "#fbbf24" })] }), _jsxs("div", { style: {
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                            gap: "16px",
                            marginBottom: "32px",
                        }, children: [_jsx(SimpleBarChart, { data: postsChartData, title: "Posts by Status", height: 180 }), _jsx(SimplePieChart, { data: tasksChartData, title: "Tasks Distribution" }), _jsx(SimplePieChart, { data: materialsChartData, title: "Materials Usage" })] }), _jsxs("div", { children: [_jsxs("div", { style: {
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginBottom: "16px",
                                }, children: [_jsx("h2", { style: { color: "#fff", fontSize: "18px", margin: 0 }, children: "Generated Reports" }), _jsxs("select", { value: typeFilter, onChange: (e) => setTypeFilter(e.target.value), style: {
                                            padding: "8px 12px",
                                            background: "#1a1a1a",
                                            border: "1px solid #333",
                                            borderRadius: "6px",
                                            color: "#ccc",
                                            fontSize: "13px",
                                        }, children: [_jsx("option", { value: "", children: "All Types" }), _jsx("option", { value: "daily_analytics", children: "Daily Analytics" }), _jsx("option", { value: "weekly", children: "Weekly" }), _jsx("option", { value: "anomaly", children: "Anomaly" })] })] }), reports.length === 0 ? (_jsx("div", { style: {
                                    color: "#666",
                                    textAlign: "center",
                                    padding: "40px",
                                    background: "#111",
                                    borderRadius: "8px",
                                    border: "1px solid #222",
                                }, children: "No reports found for the selected period." })) : (_jsx("div", { style: {
                                    display: "grid",
                                    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                                    gap: "16px",
                                }, children: reports.map((report) => (_jsx(ReportCard, { report: report }, report.id))) }))] })] }))] }));
}
