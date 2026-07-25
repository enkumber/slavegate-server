import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isFailClosedMigration } from "./migrate";

describe("task status contract migration", () => {
  const cleanupMigrationName = "103_task_status_contract.sql";
  const lifecycleMigrationName = "104_task_lifecycle_db_authoritative.sql";
  const cleanupSql = fs.readFileSync(
    path.join(__dirname, "migrations", cleanupMigrationName),
    "utf8",
  );
  const lifecycleSql = fs.readFileSync(
    path.join(__dirname, "migrations", lifecycleMigrationName),
    "utf8",
  );
  const runtimeSources = [
    path.join(__dirname, "..", "api", "routes.ts"),
    path.join(__dirname, "..", "api", "agency-routes.ts"),
    path.join(__dirname, "..", "modules", "task-runner", "task-runner.service.ts"),
    path.join(__dirname, "..", "modules", "task-lifecycle", "task-lifecycle.service.ts"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");

  it("removes the historical status-list CHECK instead of reinstalling it", () => {
    expect(cleanupSql).toContain("DROP CONSTRAINT IF EXISTS tasks_status_check");
    expect(`${cleanupSql}\n${lifecycleSql}`).not.toMatch(/tasks_status_check[\s\S]*CHECK\s*\(\s*status\s+IN/i);
  });

  it("creates DB-owned lifecycle definitions and transition rows idempotently", () => {
    expect(lifecycleSql).toContain("CREATE TABLE IF NOT EXISTS task_status_definitions");
    expect(lifecycleSql).toContain("CREATE TABLE IF NOT EXISTS task_status_transitions");
    expect(lifecycleSql).toContain("ON CONFLICT (status) DO NOTHING");
    expect(lifecycleSql).toContain("ON CONFLICT (action_key, from_status) DO NOTHING");
    expect(lifecycleSql).not.toMatch(/ON CONFLICT \(status\) DO UPDATE/i);
    expect(lifecycleSql).not.toMatch(/ON CONFLICT \(action_key, from_status\) DO UPDATE/i);
    expect(lifecycleSql).toContain("WHERE definition.initial");
    expect(lifecycleSql).toContain("FOREIGN KEY (status)");
    expect(lifecycleSql).toContain("REFERENCES task_status_definitions(status)");
  });

  it("fails server startup closed if the lifecycle contract cannot be installed", () => {
    expect(isFailClosedMigration(cleanupMigrationName)).toBe(true);
    expect(isFailClosedMigration(lifecycleMigrationName)).toBe(true);
  });

  it("keeps API and task-runner lifecycle logic off TypeScript status collections", () => {
    const sourceFiles = [
      path.join(__dirname, "..", "api", "routes.ts"),
      path.join(__dirname, "..", "api", "agency-routes.ts"),
      path.join(__dirname, "..", "modules", "task-runner", "task-runner.service.ts"),
    ];
    const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(source).not.toContain("status must be 'paused' or 'queued'");
    expect(source).not.toMatch(/\[\s*["']paused["']\s*,\s*["']queued["']\s*\]\.includes/);
  });

  it("keeps task status names out of runtime SQL policy", () => {
    expect(runtimeSources).not.toMatch(
      /UPDATE\s+tasks(?:\s+\w+)?[\s\S]{0,240}?\bstatus\s*=\s*['"]/i,
    );
    expect(runtimeSources).not.toMatch(
      /\b(?:t|tasks)\.status\s*(?:=|IN)\s*(?:['"]|\()/i,
    );
    expect(runtimeSources).not.toMatch(
      /INSERT\s+INTO\s+tasks\s*\([^)]*\bstatus\b/i,
    );
  });
});
