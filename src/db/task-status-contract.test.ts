import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isFailClosedMigration } from "./migrate";

describe("task status contract migration", () => {
  const migrationName = "103_task_status_contract.sql";
  const sql = fs.readFileSync(
    path.join(__dirname, "migrations", migrationName),
    "utf8",
  );

  it("allows every status accepted by PATCH /api/tasks/:id", () => {
    for (const status of [
      "queued",
      "running",
      "completed",
      "failed",
      "paused",
      "cancelled",
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS tasks_status_check");
    expect(sql).toContain("ADD CONSTRAINT tasks_status_check");
  });

  it("fails server startup closed if the contract cannot be installed", () => {
    expect(isFailClosedMigration(migrationName)).toBe(true);
  });
});
