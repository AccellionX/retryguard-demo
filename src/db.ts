/**
 * Shared Postgres pool. Connection string comes only from DATABASE_URL.
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and start Postgres (docker compose up -d)."
  );
}

/** Application-wide connection pool (lazy TCP; safe to import from many modules). */
export const pool = new Pool({ connectionString: databaseUrl });

pool.on("error", (err) => {
  // Idle client errors - log and let the process decide whether to exit.
  console.error("Unexpected idle Postgres client error:", err);
});

/** Convenience helper for one-off queries. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Graceful shutdown helper for workers / CLI scripts. */
export async function closePool(): Promise<void> {
  await pool.end();
}
