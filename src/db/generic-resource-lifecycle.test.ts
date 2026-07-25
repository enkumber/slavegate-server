import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFailClosedMigration } from "./migrate";

describe("generic DB-authoritative lifecycle", () => {
  const migrationName = "105_generic_resource_lifecycle.sql";
  const migration = fs.readFileSync(
    path.join(__dirname, "migrations", migrationName),
    "utf8",
  );
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const runtime = [
    path.join(__dirname, "..", "modules", "dispatcher", "dispatcher.service.ts"),
    path.join(__dirname, "..", "modules", "dispatcher", "job-lifecycle.service.ts"),
    path.join(__dirname, "..", "modules", "task-runner", "task-runner.service.ts"),
    path.join(__dirname, "..", "ws", "direct-ws.server.ts"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");

  it("creates one lifecycle registry shared by tasks and dispatcher jobs", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS lifecycle_state_definitions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS lifecycle_transitions");
    expect(migration).toContain("PRIMARY KEY (lifecycle_key, status)");
    expect(migration).toContain("FOREIGN KEY (lifecycle_key, status)");
    expect(migration).toContain("ALTER TABLE tasks");
    expect(migration).toContain("ALTER TABLE jobs");
  });

  it("preserves DB policy and never overwrites an existing definition or transition", () => {
    expect(migration).toContain("ON CONFLICT (lifecycle_key, status) DO NOTHING");
    expect(migration).toContain("ON CONFLICT (lifecycle_key, action_key, from_status) DO NOTHING");
    expect(migration).not.toMatch(/ON CONFLICT[^(]*\\([^)]*\\) DO UPDATE/i);
  });

  it("removes the superseded task registry and status-list checks", () => {
    expect(migration).toContain("DROP TABLE IF EXISTS task_status_transitions");
    expect(migration).toContain("DROP TABLE IF EXISTS task_status_definitions");
    expect(`${schema}\n${migration}`).not.toMatch(
      /(?:jobs|tasks)_status_check[\s\S]{0,200}CHECK\s*\(\s*status\s+IN/i,
    );
    expect(runtime).not.toContain("task_status_definitions");
    expect(runtime).not.toContain("task_status_transitions");
  });

  it("keeps dispatcher runtime policy off status literals and lists", () => {
    expect(runtime).not.toMatch(
      /UPDATE\s+jobs(?:\s+\w+)?[\s\S]{0,240}?\bstatus\s*=\s*['"]/i,
    );
    expect(runtime).not.toMatch(
      /INSERT\s+INTO\s+jobs\s*\([^)]*\bstatus\b/i,
    );
    expect(runtime).not.toMatch(
      /\bjobs?\.status\s*(?:=|IN)\s*(?:['"]|\()/i,
    );
  });

  it("installs fail-closed", () => {
    expect(isFailClosedMigration(migrationName)).toBe(true);
  });
});
