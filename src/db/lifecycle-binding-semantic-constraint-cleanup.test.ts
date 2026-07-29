import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFailClosedMigration } from "./migrate";

describe("lifecycle binding semantic constraint cleanup", () => {
  const migrationName =
    "119_lifecycle_resource_bindings_semantic_constraint_cleanup.sql";
  const migration = fs.readFileSync(
    path.join(__dirname, "migrations", migrationName),
    "utf8",
  );

  it("removes state-column CHECK constraints through PostgreSQL catalogs", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION configure_lifecycle_resource_binding");
    expect(migration).toContain("pg_constraint");
    expect(migration).toContain("pg_get_constraintdef");
    expect(migration).toContain("constraint_definition.contype = 'c'");
    expect(migration).toContain("ALTER TABLE %s DROP CONSTRAINT %I");
  });

  it("reconciles every existing lifecycle binding without packaged semantics", () => {
    expect(migration).toContain("FROM lifecycle_resource_bindings");
    expect(migration).toContain("configured.resource_table");
    expect(migration).toContain("configured.lifecycle_key");
    expect(migration).toContain("configured.state_column");
    expect(migration).not.toMatch(
      /\b(?:queued|running|completed|failed|pending|promoted|candidate|active|degraded)\b/i,
    );
    expect(migration).not.toMatch(/\bstatus\s+IN\s*\(/i);
  });

  it("installs fail-closed", () => {
    expect(isFailClosedMigration(migrationName)).toBe(true);
  });
});
