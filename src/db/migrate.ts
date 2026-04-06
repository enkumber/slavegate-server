/**
 * db/migrate.ts
 * Applies schema.sql + all migrations/*.sql to the database.
 * Run: npm run db:migrate
 *
 * Each migration is wrapped in its own transaction.
 * If any statement fails, that migration is rolled back (others keep changes).
 */

import fs from "fs";
import path from "path";
import { getDb, closeDb } from "./client";

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

async function migrate(): Promise<void> {
  const db = getDb();
  const client = await db.connect();
  const srcDir = path.join(__dirname);

  try {
    // 1. Apply schema.sql
    const schemaPath = path.join(srcDir, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      console.log("[migrate] Applying schema.sql...");
      const sql = fs.readFileSync(schemaPath, "utf-8").trim();
      if (sql) {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        console.log("[migrate] schema.sql ✓");
      }
    }

    // 2. Apply migration files
    const migrationsDir = path.join(srcDir, "migrations");
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .sort();
      console.log(`[migrate] Applying ${files.length} migration files...`);
      for (const file of files) {
        await applyFile(client, path.join(migrationsDir, file));
      }
    }

    console.log("[migrate] All done ✓");
  } finally {
    client.release();
  }

  await closeDb();
}

migrate().catch((err) => {
  console.error("[migrate] Fatal:", err.message);
  process.exit(1);
});
