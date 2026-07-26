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
  const bindingMigrationName = "107_lifecycle_resource_bindings.sql";
  const bindingMigration = fs.readFileSync(
    path.join(__dirname, "migrations", bindingMigrationName),
    "utf8",
  );
  const adoptionMigrationName = "108_adopt_configured_lifecycle_resources.sql";
  const adoptionMigration = fs.readFileSync(
    path.join(__dirname, "migrations", adoptionMigrationName),
    "utf8",
  );
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const runtime = [
    path.join(__dirname, "..", "modules", "dispatcher", "dispatcher.service.ts"),
    path.join(__dirname, "..", "modules", "dispatcher", "job-lifecycle.service.ts"),
    path.join(__dirname, "..", "modules", "task-runner", "task-runner.service.ts"),
    path.join(__dirname, "..", "ws", "direct-ws.server.ts"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");

  it("creates one policy-free lifecycle mechanism shared by resources", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS lifecycle_state_definitions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS lifecycle_transitions");
    expect(migration).toContain("PRIMARY KEY (lifecycle_key, status)");
    expect(migration).toContain("FOREIGN KEY (lifecycle_key, from_status)");
    expect(migration).toContain("ALTER TABLE tasks");
    expect(migration).toContain("ALTER TABLE jobs");
  });

  it("contains no lifecycle semantic seed or packaged policy", () => {
    expect(migration).not.toMatch(/INSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions)/i);
    expect(migration).not.toMatch(/\bVALUES\s*\(\s*['"]/i);
    expect(bindingMigration).not.toMatch(/INSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions)/i);
    expect(bindingMigration).not.toMatch(/transition\.action_key\s*=\s*['"]/i);
    expect(adoptionMigration).not.toMatch(/INSERT\s+INTO\s+lifecycle_(?:state_definitions|transitions)/i);
    expect(adoptionMigration).not.toMatch(/\b(?:queued|running|completed|failed|pending|promoted|candidate)\b/i);
    expect(adoptionMigration).not.toMatch(/transition\.action_key\s*=\s*['"]/i);
  });

  it("removes the superseded task registry and uses generic dynamic bindings", () => {
    expect(migration).toContain("DROP TABLE IF EXISTS task_status_transitions");
    expect(migration).toContain("DROP TABLE IF EXISTS task_status_definitions");
    expect(`${schema}\n${migration}`).not.toMatch(
      /(?:jobs|tasks)_status_check[\s\S]{0,200}CHECK\s*\(\s*status\s+IN/i,
    );
    expect(runtime).not.toContain("task_status_definitions");
    expect(runtime).not.toContain("task_status_transitions");
    expect(bindingMigration).toContain("CREATE TABLE IF NOT EXISTS lifecycle_resource_bindings");
    expect(bindingMigration).toContain("TG_RELID");
    expect(bindingMigration).toContain("configure_lifecycle_resource_binding");
    expect(bindingMigration).toContain("FOREIGN KEY (lifecycle_key, %I)");
    expect(adoptionMigration).toContain("metadata->>'resourceTable'");
    expect(adoptionMigration).toContain("to_regclass");
    expect(adoptionMigration).toContain("configure_lifecycle_resource_binding");
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
    expect(isFailClosedMigration(bindingMigrationName)).toBe(true);
    expect(isFailClosedMigration(adoptionMigrationName)).toBe(true);
  });
});
