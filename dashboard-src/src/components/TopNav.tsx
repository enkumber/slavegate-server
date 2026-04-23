/**
 * TopNav.tsx
 * Top-level navigation bar — Phone Fleet / Agency tabs
 */

import { useEffect, useState } from "react";

type Section = "fleet" | "agency" | "tokens";

export function TopNav() {
  const [active, setActive] = useState<Section>("fleet");

  useEffect(() => {
    const updateActive = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/agency")) {
        setActive("agency");
      } else if (hash === "#/tokens") {
        setActive("tokens");
      } else {
        setActive("fleet");
      }
    };
    updateActive();
    window.addEventListener("hashchange", updateActive);
    return () => window.removeEventListener("hashchange", updateActive);
  }, []);

  const navigate = (section: Section) => {
    if (section === "fleet") {
      window.location.hash = "#/";
    } else if (section === "tokens") {
      window.location.hash = "#/tokens";
    } else {
      window.location.hash = "#/agency/clients";
    }
  };

  return (
    <nav style={{
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
    }}>
      {/* Logo */}
      <div style={{
        fontSize: "16px",
        fontWeight: "bold",
        color: "#fff",
        marginRight: "32px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontFamily: "monospace",
      }}>
        <span style={{ fontSize: "20px" }}>📱</span>
        Phone Network
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "0", height: "100%" }}>
        <TabButton
          label="📡 Phone Fleet"
          active={active === "fleet"}
          onClick={() => navigate("fleet")}
        />
        <TabButton
          label="🎯 Agency"
          active={active === "agency"}
          onClick={() => navigate("agency")}
        />
        <TabButton
          label="🔑 Tokens"
          active={active === "tokens"}
          onClick={() => navigate("tokens")}
        />
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* User menu placeholder */}
      <div style={{
        color: "#888",
        fontSize: "13px",
      }}>
        admin
      </div>
    </nav>
  );
}

function TabButton({ label, active, onClick }: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
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
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "#aaa";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "#888";
      }}
    >
      {label}
    </button>
  );
}
