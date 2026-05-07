/**
 * db/migrate.ts
 * Applies schema.sql + all migrations/*.sql to the database.
 * Can be run standalone (npm run db:migrate) or called from bootstrap.
 *
 * Each migration is wrapped in its own transaction.
 * If any statement fails, that migration is rolled back (others keep changes).
 */

import fs from "fs";
import path from "path";
import { getDb } from "./client";

async function applyFile(client: any, filePath: string): Promise<void> {
  const sql = fs.readFileSync(filePath, "utf-8").trim();
  if (!sql) return;
  console.log(`  [migrate] Applying ${path.basename(filePath)}...`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`  [migrate] ${path.basename(filePath)} ✓`);
  } catch (err: any) {
    await client.query("ROLLBACK");
    // Ignore "already exists" errors — they happen on re-runs
    if (err.code === "42P07" || err.code === "42710" || err.code === "23505" || err.message.includes("already exists")) {
      console.log(`  [migrate] ${path.basename(filePath)} — already exists, skipped`);
    } else {
      console.error(`  [migrate] ${path.basename(filePath)} FAILED: ${err.message}`);
      throw err;
    }
  }
}

/**
 * Run all pending migrations. Called from bootstrap at server startup.
 * Searches for schema.sql and migrations/ in multiple locations
 * (dist/src/db/, dist/, and project root) to work in all deployment scenarios.
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();
  const client = await db.connect();

  // Search paths: __dirname (dist/src/db/), two levels up (dist/), and project root
  const searchDirs = [
    path.join(__dirname),                     // dist/src/db/
    path.join(__dirname, "..", ".."),         // dist/
    path.join(__dirname, "..", "..", ".."),   // project root (Docker)
  ];

  try {
    for (const baseDir of searchDirs) {
      // 1. Apply schema.sql
      const schemaPath = path.join(baseDir, "schema.sql");
      if (fs.existsSync(schemaPath)) {
        console.log(`[migrate] Applying schema.sql from ${baseDir}...`);
        const sql = fs.readFileSync(schemaPath, "utf-8").trim();
        if (sql) {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("COMMIT");
          console.log("[migrate] schema.sql ✓");
        }
        break; // found schema, stop searching
      }
    }

    for (const baseDir of searchDirs) {
      // 2. Apply migration files
      const migrationsDir = path.join(baseDir, "migrations");
      if (fs.existsSync(migrationsDir)) {
        const files = fs.readdirSync(migrationsDir)
          .filter(f => f.endsWith(".sql"))
          .sort();
        if (files.length > 0) {
          console.log(`[migrate] Applying ${files.length} migration files from ${migrationsDir}...`);
          for (const file of files) {
            await applyFile(client, path.join(migrationsDir, file));
          }
        }
        break; // found migrations, stop searching
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
