import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFailClosedMigration } from "./migrate";

describe("workflow and research generic lifecycle migration", () => {
  const migrationName = "106_workflow_execution_generic_lifecycle.sql";
  const migration = fs.readFileSync(path.join(__dirname, "migrations", migrationName), "utf8");
  const runtime = [
    path.join(__dirname, "..", "modules", "workflows", "workflow.service.ts"),
    path.join(__dirname, "..", "modules", "workflows", "workflow-lifecycle.service.ts"),
    path.join(__dirname, "..", "modules", "workflows", "agency-workflow-run-lifecycle.service.ts"),
    path.join(__dirname, "..", "modules", "research", "research.service.ts"),
    path.join(__dirname, "..", "modules", "research", "research-lifecycle.service.ts"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");

  it("binds all migrated resources to the shared registry", () => {
    for (const table of ["workflows", "agency_workflow_runs", "research_jobs"]) {
      expect(migration).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS lifecycle_key`);
      expect(migration).toContain(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_lifecycle_status_fkey`);
      expect(migration).toContain(`trg_${table}_initial_status`);
    }
  });

  it("bootstraps without overwriting operator policy", () => {
    expect(migration.match(/ON CONFLICT \(lifecycle_key, status\) DO NOTHING/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration.match(/ON CONFLICT \(lifecycle_key, action_key, from_status\) DO NOTHING/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).not.toMatch(/ON CONFLICT[^(]*\([^)]*\) DO UPDATE/i);
  });

  it("removes status-list constraints for migrated resources", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS workflows_status_check");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS agency_workflow_runs_status_check");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS research_jobs_status_check");
  });

  it("keeps migrated runtime transitions on the DB registry", () => {
    expect(runtime).not.toMatch(/UPDATE\s+workflows\s+SET\s+status\s*=\s*['"]/i);
    expect(runtime).not.toMatch(/UPDATE\s+agency_workflow_runs\s+SET\s+status\s*=\s*['"]/i);
    expect(runtime).not.toMatch(/UPDATE\s+research_jobs\s+SET\s+status\s*=\s*['"]/i);
    expect(runtime).not.toMatch(/research_jobs[\s\S]{0,160}\bstatus\s+IN\s*\(/i);
  });

  it("installs fail-closed", () => {
    expect(isFailClosedMigration(migrationName)).toBe(true);
  });
});
