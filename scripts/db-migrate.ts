/**
 * Runs SQL migrations in order (currently: migrations/001_init.sql).
 * Usage: npm run db:migrate
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closePool, pool } from "../src/db.js";

const MIGRATIONS = [
  "001_init.sql",
  "002_pending_envelopes.sql",
  "003_demo_clarity.sql",
] as const;

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const file of MIGRATIONS) {
      const path = join(process.cwd(), "migrations", file);
      const sql = await readFile(path, "utf8");
      console.log(`Applying ${file}…`);
      await client.query(sql);
      console.log(`  OK: ${file}`);
    }
    console.log("Migrations complete.");
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
