/**
 * Start mock DocuSign on :4001 and ensure the test Postgres DB is migrated.
 * Dev stack on :4000 / retryguard DB is left alone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const ROOT = process.cwd();
const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  "postgresql://retryguard:change-me@localhost:5432/retryguard_test";
const MOCK_PORT = Number(process.env.TEST_MOCK_PORT ?? 4001);
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const STORE_PATH = join(ROOT, "data", "test-mock-envelopes.json");
const CRASH_FLAG = join(ROOT, "data", "test-crashed.flag");
const TSX = join(ROOT, "node_modules/.bin/tsx");

let mockProc: ChildProcess | null = null;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForMock(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${MOCK_URL}/mock/envelopes`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Mock DocuSign did not start on ${MOCK_URL}`);
}

async function ensureTestDb(): Promise<void> {
  const admin = new pg.Pool({
    connectionString:
      "postgresql://retryguard:change-me@localhost:5432/postgres",
  });
  try {
    const { rows } = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = 'retryguard_test'`
    );
    if (rows.length === 0) {
      await admin.query("CREATE DATABASE retryguard_test");
    }
  } finally {
    await admin.end();
  }

  // Apply migrations via a short-lived process with TEST DATABASE_URL.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(TSX, ["scripts/db-migrate.ts"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: TEST_DB },
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))
    );
    child.on("error", reject);
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(STORE_PATH, "[]", "utf8");
  try {
    await unlink(CRASH_FLAG);
  } catch {
    // ok
  }

  await ensureTestDb();

  mockProc = spawn(TSX, ["src/mock-docusign/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_DOCUSIGN_PORT: String(MOCK_PORT),
      MOCK_STORE_PATH: STORE_PATH,
      MOCK_TIMEOUT_MS: "2000",
      MOCK_FAIL_RATE: "0",
      MOCK_TIMEOUT_RATE: "0",
    },
    stdio: "inherit",
  });

  await waitForMock();

  // Expose for tests via process.env (vitest copies these into workers).
  process.env.TEST_DATABASE_URL = TEST_DB;
  process.env.TEST_DOCUSIGN_BASE_URL = MOCK_URL;
  process.env.TEST_MOCK_PORT = String(MOCK_PORT);
  process.env.MOCK_STORE_PATH = STORE_PATH;
  process.env.CRASH_FLAG_PATH = CRASH_FLAG;

  return async () => {
    if (mockProc && mockProc.exitCode == null) {
      mockProc.kill("SIGTERM");
      await sleep(500);
      if (mockProc.exitCode == null) mockProc.kill("SIGKILL");
    }
    mockProc = null;
  };
}
