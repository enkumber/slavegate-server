/**
 * db/migrate.ts
 * Applies schema.sql to the database in a single transaction.
 * Run: npm run db:migrate
 *
 * If any statement fails, the entire migration is rolled back.
 */

import fs from "fs";
import path from "path";
import { getDb, closeDb } from "./client";

async function migrate(): Promise<void> {
  const db = getDb();
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("[migrate] Applying schema (in transaction)...");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("[migrate] Done.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate] Failed — rolled back:", (err as Error).message);
    throw err;
  } finally {
    client.release();
  }

  await closeDb();
}

migrate().catch((err) => {
  console.error("[migrate] Fatal:", err.message);
  process.exit(1);
});
