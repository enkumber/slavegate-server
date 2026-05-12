import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * App.tsx
 * Root component — auth gate, routing.
 */
import { useState, useEffect } from "react";
import { LoginPage } from "./pages/LoginPage";
import { FleetPage } from "./pages/FleetPage";
import { ProvisionPage } from "./pages/ProvisionPage";
import { ClientsPage } from "./pages/ClientsPage";
import { FarmingProfilesPage } from "./pages/FarmingProfilesPage";
import { PostsPage } from "./pages/PostsPage";
import { MaterialsPage } from "./pages/MaterialsPage";
import { TasksPage } from "./pages/TasksPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AccountsPage } from "./pages/AccountsPage";
import { TokenManagement } from "./pages/TokenManagement";
import { TopNav } from "./components/TopNav";
import { api } from "./api/client";
export function App() {
    const [authed, setAuthed] = useState(api.isAuthenticated());
    const [route, setRoute] = useState(window.location.hash || "#/");
    // Simple hash-based routing
    useEffect(() => {
        const handleHashChange = () => setRoute(window.location.hash || "#/");
        window.addEventListener("hashchange", handleHashChange);
        return () => window.removeEventListener("hashchange", handleHashChange);
    }, []);
    if (!authed) {
        return _jsx(LoginPage, { onLogin: () => setAuthed(true) });
    }
    // Route to pages
    if (route === "#/provision") {
        return _jsx(ProvisionPage, {});
    }
    // Determine which page to render
    let page;
    // Agency routes
    if (route === "#/agency" || route === "#/agency/") {
        window.location.hash = "#/agency/clients";
        return null;
    }
    else if (route.startsWith("#/agency/clients")) {
        page = _jsx(ClientsPage, {});
    }
    else if (route.startsWith("#/agency/farming")) {
        page = _jsx(FarmingProfilesPage, {});
    }
    else if (route.startsWith("#/agency/accounts")) {
        page = _jsx(AccountsPage, {});
    }
    else if (route.startsWith("#/agency/posts")) {
        page = _jsx(PostsPage, {});
    }
    else if (route.startsWith("#/agency/materials")) {
        page = _jsx(MaterialsPage, {});
    }
    else if (route.startsWith("#/agency/tasks")) {
        page = _jsx(TasksPage, {});
    }
    else if (route.startsWith("#/agency/reports")) {
        page = _jsx(ReportsPage, {});
    }
    else if (route === "#/tokens") {
        page = _jsx(TokenManagement, {});
    }
    else {
        // Default: Fleet
        page = _jsx(FleetPage, {});
    }
    // Wrap all main pages with TopNav
    return (_jsxs("div", { style: { minHeight: "100vh", background: "#0f0f23" }, children: [_jsx(TopNav, {}), page] }));
}
