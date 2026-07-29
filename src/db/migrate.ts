/**
 * db/migrate.ts
 * Applies schema.sql + all migrations/*.sql to the database.
 * Can be run standalone (npm run db:migrate) or called from bootstrap.
 *
 * Each migration is wrapped in its own transaction with ROLLBACK on failure.
 * Most historical migration failures are LOGGED but DO NOT block server startup.
 * PNQ queue authority and UI graph runtime migrations fail closed because
 * neither executor may start against a partial contract.
 */

import fs from "fs";
import path from "path";
import { getDb } from "./client";

async function applyFile(client: any, filePath: string): Promise<{ ok: boolean; error?: string }> {
  const sql = fs.readFileSync(filePath, "utf-8").trim();
  if (!sql) return { ok: true };
  console.log(`  [migrate] Applying ${path.basename(filePath)}...`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`  [migrate] ${path.basename(filePath)} ✓`);
    return { ok: true };
  } catch (err: any) {
    await client.query("ROLLBACK");
    // Ignore "already exists" errors — they happen on re-runs
    if (err.code === "42P07" || err.code === "42710" || err.code === "23505" || err.message.includes("already exists")) {
      console.log(`  [migrate] ${path.basename(filePath)} — already exists, skipped`);
      return { ok: true };
    }
    console.warn(`  [migrate] ${path.basename(filePath)} FAILED: ${err.message} (non-fatal, continuing)`);
    return { ok: false, error: err.message };
  }
}

export function isFailClosedMigration(fileName: string): boolean {
  return fileName.includes("device_execution_queue") ||
    fileName.includes("queue_v2_contract") ||
    fileName.includes("queue_v2_runtime") ||
    fileName.includes("pnq_v2_runtime") ||
    fileName.includes("ui_graph_runtime") ||
    fileName.includes("app_runtime_profiles") ||
    fileName.includes("edge_workflow_runtime_contract") ||
    fileName.includes("edge_workflow_learning_receipts") ||
    fileName.includes("verified_ui_state_machine_runtime") ||
    fileName.includes("human_workflow_compiler_policy") ||
    fileName.includes("workflow_capability_catalog") ||
    fileName.includes("data_driven_goal_contracts") ||
    fileName.includes("db_authoritative_workflow_semantics") ||
    fileName.includes("postgres_compiler_control_plane") ||
    fileName.includes("generic_workflow_segments") ||
    fileName.includes("segment_builder_agent_jobs") ||
    fileName.includes("task_status_contract") ||
    fileName.includes("task_lifecycle_db_authoritative") ||
    fileName.includes("generic_resource_lifecycle") ||
    fileName.includes("workflow_execution_generic_lifecycle") ||
    fileName.includes("lifecycle_resource_bindings") ||
    fileName.includes("resource_runtime_policies") ||
    fileName.includes("adopt_configured_lifecycle_resources") ||
    fileName.includes("runtime_semantic_entry_lifecycle_compatibility") ||
    fileName.includes("phone_network_incidents_and_audits") ||
    fileName.includes("workflow_safety_admission");
}

/**
 * Run all migrations. Called from bootstrap at server startup.
 * Searches for schema.sql and migrations/ in multiple locations.
 * Throws only for fail-closed migrations that protect the device execution
 * arbiter or UI graph runtime; legacy migration behavior remains non-fatal.
 */
export async function runMigrations(): Promise<void> {
  let db;
  try {
    db = getDb();
  } catch (err: any) {
    console.warn(`[migrate] Cannot get DB pool: ${err.message} — skipping migrations`);
    return;
  }

  let client;
  try {
    client = await db.connect();
  } catch (err: any) {
    console.warn(`[migrate] Cannot connect to DB: ${err.message} — skipping migrations`);
    return;
  }

  // Search paths: __dirname (dist/src/db/), two levels up (dist/), and project root (Docker)
  const searchDirs = [
    path.join(__dirname),                     // dist/src/db/
    path.join(__dirname, "..", ".."),         // dist/
    path.join(__dirname, "..", "..", ".."),   // /app/ (Docker)
  ];

  try {
    // 1. Apply schema.sql (idempotent — CREATE TABLE IF NOT EXISTS)
    for (const baseDir of searchDirs) {
      const schemaPath = path.join(baseDir, "schema.sql");
      if (fs.existsSync(schemaPath)) {
        console.log(`[migrate] Applying schema.sql from ${baseDir}...`);
        const sql = fs.readFileSync(schemaPath, "utf-8").trim();
        if (sql) {
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query("COMMIT");
            console.log("[migrate] schema.sql ✓");
          } catch (err: any) {
            await client.query("ROLLBACK");
            console.warn(`[migrate] schema.sql FAILED: ${err.message} (non-fatal, continuing)`);
          }
        }
        break;
      }
    }

    // 2. Apply migration files (each in own transaction, failures are non-fatal)
    for (const baseDir of searchDirs) {
      const migrationsDir = path.join(baseDir, "migrations");
      if (fs.existsSync(migrationsDir)) {
        const files = fs.readdirSync(migrationsDir)
          .filter(f => f.endsWith(".sql"))
          .sort();
        if (files.length > 0) {
          console.log(`[migrate] Applying ${files.length} migration files from ${migrationsDir}...`);
          let failed = 0;
          for (const file of files) {
            const result = await applyFile(client, path.join(migrationsDir, file));
            if (!result.ok) {
              failed++;
              if (isFailClosedMigration(file)) {
                throw new Error(`[migrate] Fail-closed migration ${file} failed: ${result.error ?? "unknown error"}`);
              }
            }
          }
          if (failed > 0) {
            console.warn(`[migrate] ${failed}/${files.length} migrations had errors (server will still start)`);
          }
        }
        break;
      }
    }

    console.log("[migrate] All done ✓");
  } finally {
    client.release();
  }
}

// Standalone execution: npm run db:migrate
if (require.main === module) {
  const { closeDb } = require("./client");
  runMigrations()
    .then(() => (closeDb as any)())
    .catch((err) => {
      console.error("[migrate] Fatal:", err.message);
      process.exit(1);
    });
}
