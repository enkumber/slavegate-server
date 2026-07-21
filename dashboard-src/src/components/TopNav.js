import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * TopNav.tsx
 * Top-level navigation bar — Phone Fleet / Agency tabs
 */
import { useEffect, useState } from "react";
export function TopNav() {
    const [active, setActive] = useState("fleet");
    useEffect(() => {
        const updateActive = () => {
            const hash = window.location.hash;
            if (hash.startsWith("#/agency")) {
                setActive("agency");
            }
            else if (hash === "#/ui-graph") {
                setActive("graph");
            }
            else if (hash === "#/tokens") {
                setActive("tokens");
            }
            else {
                setActive("fleet");
            }
        };
        updateActive();
        window.addEventListener("hashchange", updateActive);
        return () => window.removeEventListener("hashchange", updateActive);
    }, []);
    const navigate = (section) => {
        if (section === "fleet") {
            window.location.hash = "#/";
        }
        else if (section === "tokens") {
            window.location.hash = "#/tokens";
        }
        else if (section === "graph") {
            window.location.hash = "#/ui-graph";
        }
        else {
            window.location.hash = "#/agency/clients";
        }
    };
    return (_jsxs("nav", { style: {
            display: "flex",
            alignItems: "center",
            gap: "0",
            padding: "0 24px",
            background: "linear-gradient(180deg, #1a1a2e 0%, #16162a 100%)",
            borderBottom: "1px solid #2a2a4a",
            height: "56px",
            position: "sticky",
            top: 0,
            zIndex: 1000,
        }, children: [_jsxs("div", { style: {
                    fontSize: "16px",
                    fontWeight: "bold",
                    color: "#fff",
                    marginRight: "32px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontFamily: "monospace",
                }, children: [_jsx("span", { style: { fontSize: "20px" }, children: "\uD83D\uDCF1" }), "Phone Network"] }), _jsxs("div", { style: { display: "flex", gap: "0", height: "100%" }, children: [_jsx(TabButton, { label: "\uD83D\uDCE1 Phone Fleet", active: active === "fleet", onClick: () => navigate("fleet") }), _jsx(TabButton, { label: "\uD83C\uDFAF Agency", active: active === "agency", onClick: () => navigate("agency") }), _jsx(TabButton, { label: "\uD83E\uDDED UI Graph", active: active === "graph", onClick: () => navigate("graph") }), _jsx(TabButton, { label: "\uD83D\uDD11 Tokens", active: active === "tokens", onClick: () => navigate("tokens") })] }), _jsx("div", { style: { flex: 1 } }), _jsx("div", { style: {
                    color: "#888",
                    fontSize: "13px",
                }, children: "admin" })] }));
}
function TabButton({ label, active, onClick }) {
    return (_jsx("button", { onClick: onClick, style: {
            background: "transparent",
            border: "none",
            borderBottom: active ? "3px solid #4a9eff" : "3px solid transparent",
            color: active ? "#fff" : "#888",
            fontSize: "14px",
            fontWeight: active ? "600" : "400",
            padding: "0 20px",
            height: "100%",
            cursor: "pointer",
            transition: "all 0.2s",
            fontFamily: "monospace",
        }, onMouseEnter: (e) => {
            if (!active)
                e.currentTarget.style.color = "#aaa";
        }, onMouseLeave: (e) => {
            if (!active)
                e.currentTarget.style.color = "#888";
        }, children: label }));
}
