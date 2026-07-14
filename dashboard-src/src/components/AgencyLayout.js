import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const navItems = [
    { path: "#/agency/clients", label: "Clients", icon: "👥" },
    { path: "#/agency/farming", label: "Farming", icon: "🌱" },
    { path: "#/agency/accounts", label: "Accounts", icon: "📱" },
    { path: "#/agency/materials", label: "Materials", icon: "📁" },
    { path: "#/agency/posts", label: "Posts", icon: "📝" },
    { path: "#/agency/tasks", label: "Tasks", icon: "⚡" },
    { path: "#/agency/runs", label: "Run History", icon: "⏱" },
    { path: "#/agency/step-library", label: "Step Library", icon: "✓" },
    { path: "#/agency/tool-catalog", label: "Tool Catalog", icon: "⚙" },
    { path: "#/agency/compiler-knowledge", label: "Compiler Knowledge", icon: "◇" },
    { path: "#/agency/compiler-control-plane", label: "Compiler Control", icon: "▣" },
    { path: "#/agency/workflow-definitions", label: "Workflow Definitions", icon: "▤" },
    { path: "#/agency/workflow-validation-pipeline", label: "Validation Pipeline", icon: "▥" },
    { path: "#/agency/reports", label: "Reports", icon: "📊" },
];
export function AgencyLayout({ children, currentRoute }) {
    return (_jsxs("div", { style: { display: "flex", minHeight: "100vh", background: "#0a0a0a" }, children: [_jsxs("aside", { style: {
                    width: "220px",
                    background: "#111",
                    borderRight: "1px solid #222",
                    padding: "20px 0",
                    display: "flex",
                    flexDirection: "column",
                }, children: [_jsx("div", { style: { padding: "16px 20px 20px", borderBottom: "1px solid #222" }, children: _jsx("h2", { style: { color: "#e2e8f0", margin: 0, fontSize: "16px", fontFamily: "monospace" }, children: "Agency" }) }), _jsx("nav", { style: { flex: 1, padding: "16px 12px" }, children: navItems.map((item) => {
                            const isActive = currentRoute === item.path || currentRoute.startsWith(item.path.replace("#", ""));
                            return (_jsxs("a", { href: item.path, style: {
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
                                    padding: "10px 12px",
                                    marginBottom: "4px",
                                    borderRadius: "6px",
                                    textDecoration: "none",
                                    color: isActive ? "#fff" : "#888",
                                    background: isActive ? "#1a1a2e" : "transparent",
                                    fontSize: "13px",
                                    fontFamily: "monospace",
                                    transition: "all 0.15s ease",
                                }, children: [_jsx("span", { style: { fontSize: "16px" }, children: item.icon }), item.label] }, item.path));
                        }) }), _jsx("div", { style: { padding: "16px 20px", borderTop: "1px solid #222" }, children: _jsx("div", { style: { color: "#555", fontSize: "11px", fontFamily: "monospace" }, children: "Marketing Dashboard" }) })] }), _jsx("main", { style: { flex: 1, padding: "24px 32px", overflowY: "auto" }, children: children })] }));
}
