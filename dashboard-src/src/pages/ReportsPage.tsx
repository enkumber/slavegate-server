/**
 * ReportsPage.tsx
 * Reports dashboard — stats cards, charts, date filtering.
 */

import { useState, useEffect, useCallback } from "react";
import { AgencyLayout } from "../components/AgencyLayout";
import { agencyApi, AgencyStats, Report } from "../api/agency";

// ─── Stats Card ───────────────────────────────────────────────────────────────

interface StatsCardProps {
  icon: string;
  label: string;
  value: number | string;
  subtext?: string;
  color: string;
}

function StatsCard({ icon, label, value, subtext, color }: StatsCardProps) {
  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "12px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        <span style={{ fontSize: "20px" }}>{icon}</span>
        <span style={{ color: "#888", fontSize: "13px" }}>{label}</span>
      </div>
      <div style={{ color, fontSize: "32px", fontWeight: 600, lineHeight: 1 }}>{value}</div>
      {subtext && (
        <div style={{ color: "#666", fontSize: "12px", marginTop: "8px" }}>{subtext}</div>
      )}
    </div>
  );
}

// ─── Simple Bar Chart ─────────────────────────────────────────────────────────

interface BarChartProps {
  data: { label: string; value: number; color?: string }[];
  title: string;
  height?: number;
}

function SimpleBarChart({ data, title, height = 200 }: BarChartProps) {
  const maxValue = Math.max(...data.map((d) => d.value), 1);

  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "12px",
        padding: "20px",
      }}
    >
      <h3 style={{ color: "#fff", fontSize: "14px", margin: "0 0 20px 0" }}>{title}</h3>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          height,
          gap: "8px",
        }}
      >
        {data.map((item, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              height: "100%",
            }}
          >
            <div
              style={{
                flex: 1,
                width: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
              }}
            >
              <div
                style={{
                  height: `${(item.value / maxValue) * 100}%`,
                  minHeight: item.value > 0 ? "4px" : "0",
                  background: item.color || "#60a5fa",
                  borderRadius: "4px 4px 0 0",
                  transition: "height 0.3s ease",
                }}
              />
            </div>
            <div
              style={{
                color: "#fff",
                fontSize: "11px",
                marginTop: "8px",
                fontWeight: 500,
              }}
            >
              {item.value}
            </div>
            <div
              style={{
                color: "#666",
                fontSize: "10px",
                marginTop: "4px",
                textAlign: "center",
              }}
            >
              {item.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Simple Pie/Donut Chart ───────────────────────────────────────────────────

interface PieChartProps {
  data: { label: string; value: number; color: string }[];
  title: string;
}

function SimplePieChart({ data, title }: PieChartProps) {
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

  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "12px",
        padding: "20px",
      }}
    >
      <h3 style={{ color: "#fff", fontSize: "14px", margin: "0 0 20px 0" }}>{title}</h3>
      <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
        {/* Pie */}
        <div
          style={{
            width: "120px",
            height: "120px",
            borderRadius: "50%",
            background: total > 0 ? `conic-gradient(${segments})` : "#222",
            position: "relative",
          }}
        >
          {/* Center hole for donut effect */}
          <div
            style={{
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
            }}
          >
            {total}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {data.map((d, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  borderRadius: "2px",
                  background: d.color,
                }}
              />
              <span style={{ color: "#888", fontSize: "12px" }}>{d.label}</span>
              <span style={{ color: "#fff", fontSize: "12px", fontWeight: 500 }}>{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Report Card ──────────────────────────────────────────────────────────────

interface ReportCardProps {
  report: Report;
}

function ReportCard({ report }: ReportCardProps) {
  const typeIcons: Record<string, string> = {
    daily_analytics: "📊",
    weekly: "📈",
    anomaly: "⚠️",
  };

  const typeColors: Record<string, string> = {
    daily_analytics: "#60a5fa",
    weekly: "#a78bfa",
    anomaly: "#fbbf24",
  };

  return (
    <div
      style={{
        background: "#111",
        border: "1px solid #222",
        borderRadius: "8px",
        padding: "16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "16px" }}>{typeIcons[report.type] || "📋"}</span>
            <span
              style={{
                color: typeColors[report.type] || "#ccc",
                fontSize: "13px",
                fontWeight: 500,
                textTransform: "capitalize",
              }}
            >
              {report.type.replace("_", " ")}
            </span>
          </div>
          <div style={{ color: "#666", fontSize: "12px", marginTop: "4px" }}>
            Period: {report.period}
          </div>
        </div>
        <div style={{ color: "#555", fontSize: "11px" }}>
          {new Date(report.created_at).toLocaleDateString()}
        </div>
      </div>

      {/* Data preview */}
      <div
        style={{
          marginTop: "12px",
          padding: "10px",
          background: "#0a0a0a",
          borderRadius: "4px",
          maxHeight: "100px",
          overflow: "auto",
        }}
      >
        <pre style={{ margin: 0, color: "#888", fontSize: "10px" }}>
          {JSON.stringify(report.data, null, 2).slice(0, 200)}
          {JSON.stringify(report.data).length > 200 ? "..." : ""}
        </pre>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const [stats, setStats] = useState<AgencyStats | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Date range
  const [dateFrom, setDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });
  const [dateTo, setDateTo] = useState<string>(() => {
    return new Date().toISOString().split("T")[0];
  });

  // Report type filter
  const [typeFilter, setTypeFilter] = useState<string>("");

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
    } catch (e) {
      setError((e as Error).message);
    } finally {
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

  return (
    <AgencyLayout currentRoute="#/agency/reports">
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ color: "#fff", margin: 0, fontSize: "24px" }}>📊 Reports</h1>
        <p style={{ color: "#666", margin: "8px 0 0", fontSize: "13px" }}>
          Analytics dashboard and generated reports
        </p>
      </div>

      {/* Date range picker */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "24px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <label style={{ color: "#888", fontSize: "13px" }}>From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{
              padding: "8px 12px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "6px",
              color: "#ccc",
              fontSize: "13px",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <label style={{ color: "#888", fontSize: "13px" }}>To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{
              padding: "8px 12px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "6px",
              color: "#ccc",
              fontSize: "13px",
            }}
          />
        </div>
        <button
          onClick={fetchData}
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
          Apply
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
      ) : (
        <>
          {/* Stats cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "16px",
              marginBottom: "32px",
            }}
          >
            <StatsCard
              icon="👥"
              label="Total Clients"
              value={stats?.clients.total || 0}
              subtext={`${stats?.clients.active || 0} active`}
              color="#a78bfa"
            />
            <StatsCard
              icon="📝"
              label="Total Posts"
              value={stats?.posts.total || 0}
              subtext={`${stats?.posts.pending || 0} pending approval`}
              color="#60a5fa"
            />
            <StatsCard
              icon="⚡"
              label="Total Tasks"
              value={stats?.tasks.total || 0}
              subtext={`${stats?.tasks.completed || 0} completed`}
              color="#4ade80"
            />
            <StatsCard
              icon="📁"
              label="Materials"
              value={stats?.materials.total || 0}
              subtext={`${stats?.materials.unused || 0} unused`}
              color="#fbbf24"
            />
          </div>

          {/* Charts */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "16px",
              marginBottom: "32px",
            }}
          >
            <SimpleBarChart data={postsChartData} title="Posts by Status" height={180} />
            <SimplePieChart data={tasksChartData} title="Tasks Distribution" />
            <SimplePieChart data={materialsChartData} title="Materials Usage" />
          </div>

          {/* Reports list */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <h2 style={{ color: "#fff", fontSize: "18px", margin: 0 }}>Generated Reports</h2>
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
                <option value="daily_analytics">Daily Analytics</option>
                <option value="weekly">Weekly</option>
                <option value="anomaly">Anomaly</option>
              </select>
            </div>

            {reports.length === 0 ? (
              <div
                style={{
                  color: "#666",
                  textAlign: "center",
                  padding: "40px",
                  background: "#111",
                  borderRadius: "8px",
                  border: "1px solid #222",
                }}
              >
                No reports found for the selected period.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                  gap: "16px",
                }}
              >
                {reports.map((report) => (
                  <ReportCard key={report.id} report={report} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </AgencyLayout>
  );
}
