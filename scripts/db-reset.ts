/**
 * Truncates jobs and job_logs (keeps schema). Cascade clears logs via FK.
 * Usage: npm run db:reset
 */
import "dotenv/config";
import { closePool, pool } from "../src/db.js";

async function reset(): Promise<void> {
  const client = await pool.connect();
  try {
    // RESTART IDENTITY resets job_logs bigserial; CASCADE clears dependent rows.
    await client.query(
      "TRUNCATE TABLE pending_envelopes, job_logs, jobs RESTART IDENTITY CASCADE"
    );
    console.log("Truncated jobs, job_logs, pending_envelopes.");
  } finally {
    client.release();
    await closePool();
  }
}

reset().catch((err) => {
  console.error("Reset failed:", err);
  process.exitCode = 1;
});
