/**
 * Entry point placeholder - wire workers / HTTP later.
 */
import "dotenv/config";
import { closePool, pool } from "./db.js";

async function main(): Promise<void> {
  const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  console.log("retryguard-demo ready; Postgres ping:", rows[0]?.ok);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
