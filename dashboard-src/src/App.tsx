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
import { RunHistoryPage } from "./pages/RunHistoryPage";
import { StepLibraryPage } from "./pages/StepLibraryPage";
import { ToolCatalogPage } from "./pages/ToolCatalogPage";
import { CompilerKnowledgePage } from "./pages/CompilerKnowledgePage";
import { CompilerControlPlanePage } from "./pages/CompilerControlPlanePage";
import { WorkflowDefinitionsPage } from "./pages/WorkflowDefinitionsPage";
import { WorkflowValidationPipelinePage } from "./pages/WorkflowValidationPipelinePage";
import { ReportsPage } from "./pages/ReportsPage";
import { AccountsPage } from "./pages/AccountsPage";
import { TokenManagement } from "./pages/TokenManagement";
// ModelConfigPage merged into TokenManagement
// import { ModelConfigPage } from "./pages/ModelConfigPage";
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
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  // Route to pages
  if (route === "#/provision") {
    return <ProvisionPage />;
  }

  // Determine which page to render
  let page: React.ReactNode;

  // Agency routes
  if (route === "#/agency" || route === "#/agency/") {
    window.location.hash = "#/agency/clients";
    return null;
  } else if (route.startsWith("#/agency/clients")) {
    page = <ClientsPage />;
  } else if (route.startsWith("#/agency/farming")) {
    page = <FarmingProfilesPage />;
  } else if (route.startsWith("#/agency/accounts")) {
    page = <AccountsPage />;
  } else if (route.startsWith("#/agency/posts")) {
    page = <PostsPage />;
  } else if (route.startsWith("#/agency/materials")) {
    page = <MaterialsPage />;
  } else if (route.startsWith("#/agency/tasks")) {
    page = <TasksPage />;
  } else if (route.startsWith("#/agency/runs")) {
    page = <RunHistoryPage />;
  } else if (route.startsWith("#/agency/step-library")) {
    page = <StepLibraryPage />;
  } else if (route.startsWith("#/agency/tool-catalog")) {
    page = <ToolCatalogPage />;
  } else if (route.startsWith("#/agency/compiler-knowledge")) {
    page = <CompilerKnowledgePage />;
  } else if (route.startsWith("#/agency/compiler-control-plane")) {
    page = <CompilerControlPlanePage />;
  } else if (route.startsWith("#/agency/workflow-definitions")) {
    page = <WorkflowDefinitionsPage />;
  } else if (route.startsWith("#/agency/workflow-validation-pipeline")) {
    page = <WorkflowValidationPipelinePage />;
  } else if (route.startsWith("#/agency/reports")) {
    page = <ReportsPage />;
  } else if (route === "#/tokens") {
    page = <TokenManagement />;
  } else if (route === "#/models") {
    // models tab removed — now inside #/tokens
    window.location.hash = "#/tokens";
    return null;
  } else {
    // Default: Fleet
    page = <FleetPage />;
  }

  // Wrap all main pages with TopNav
  return (
    <div style={{ minHeight: "100vh", background: "#0f0f23" }}>
      <TopNav />
      {page}
    </div>
  );
}
