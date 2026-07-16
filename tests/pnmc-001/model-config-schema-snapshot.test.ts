import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBetween(sql: string, start: string, end: string): string {
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return sql.slice(startIndex, endIndex + end.length);
}

describe("PNMC-001 model_configs schema snapshot", () => {
  it("keeps schema.sql consistent with migration 031 model_configs DDL and seed rows", () => {
    const migration = readRepoFile("src/db/migrations/031_model_configs.sql");
    const schema = readRepoFile("src/db/schema.sql");

    const migrationCreateTable = extractBetween(migration, "CREATE TABLE IF NOT EXISTS model_configs", ");");
    const schemaCreateTable = extractBetween(schema, "CREATE TABLE IF NOT EXISTS model_configs", ");");
    expect(normalizeSql(schemaCreateTable)).toBe(normalizeSql(migrationCreateTable));

    for (const requiredSql of [
      "CREATE OR REPLACE FUNCTION set_model_configs_updated_at()",
      "DROP TRIGGER IF EXISTS trg_model_configs_updated_at ON model_configs;",
      "CREATE TRIGGER trg_model_configs_updated_at",
      "INSERT INTO model_configs (role, provider, endpoint, model, enabled)",
      "('decision_llm', 'openai_compatible', NULL, 'configure-me', FALSE)",
      "('vision_vlm', 'openai_compatible', NULL, 'configure-me', FALSE)",
      "ON CONFLICT (role) DO NOTHING;",
    ]) {
      expect(schema).toContain(requiredSql);
      expect(migration).toContain(requiredSql);
    }
  });
});
