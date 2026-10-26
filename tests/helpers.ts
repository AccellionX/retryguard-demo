/**
 * Shared helpers for RetryGuard vitest suite.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { enqueueJobs } from "../src/scripts/enqueue.js";

export const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://retryguard:change-me@localhost:5432/retryguard_test";

export const MOCK_BASE =
  process.env.TEST_DOCUSIGN_BASE_URL ??
  process.env.DOCUSIGN_BASE_URL ??
  "http://localhost:4001";

export const TSX = join(process.cwd(), "node_modules/.bin/tsx");
export const CRASH_FLAG =
  process.env.CRASH_FLAG_PATH ?? join(process.cwd(), "data", "test-crashed.flag");

export const workerTestEnv: Record<string, string> = {
  DATABASE_URL: TEST_DB,
  DOCUSIGN_MODE: "mock",
  DOCUSIGN_BASE_URL: MOCK_BASE,
  DOCUSIGN_ACCOUNT_ID: "demo-account",
  WORKER_STALE_SECONDS: "3",
  WORKER_POLL_MS: "100",
  BACKOFF_BASE_MS: "200",
  DOCUSIGN_CREATE_TIMEOUT_MS: "800",
  CRASH_FLAG_PATH: CRASH_FLAG,
  MOCK_STORE_PATH:
    process.env.MOCK_STORE_PATH ??
    join(process.cwd(), "data", "test-mock-envelopes.json"),
};

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: TEST_DB });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function resetAll(): Promise<void> {
  const p = getPool();
  await p.query(
    "TRUNCATE TABLE pending_envelopes, job_logs, jobs RESTART IDENTITY CASCADE"
  );
  const res = await fetch(`${MOCK_BASE}/mock/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`mock reset failed: ${res.status}`);
  try {
    await unlink(CRASH_FLAG);
  } catch {
    // ok
  }
}

export async function enqueue(n: number): Promise<string[]> {
  // enqueueJobs uses src/db pool which reads DATABASE_URL from env (set in setup).
  return enqueueJobs(n);
}

export async function getJob(id: string): Promise<pg.QueryResultRow | null> {
  const { rows } = await getPool().query(`SELECT * FROM jobs WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export async function getAllJobs(): Promise<pg.QueryResultRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM jobs ORDER BY created_at`
  );
  return rows;
}

export async function getLogs(
  jobId: string
): Promise<{ step: string; worker: string | null; message: string | null }[]> {
  const { rows } = await getPool().query(
    `SELECT step, worker, message FROM job_logs WHERE job_id = $1 ORDER BY id`,
    [jobId]
  );
  return rows;
}

export interface EnvelopeCount {
  jobId: string;
  count: number;
  envelopeIds: string[];
}

export async function getEnvelopeCounts(): Promise<{
  counts: EnvelopeCount[];
  duplicates: number;
  total: number;
  envelopes: Array<{
    envelopeId: string;
    jobId: string | null;
  }>;
}> {
  const res = await fetch(`${MOCK_BASE}/mock/envelopes`);
  if (!res.ok) throw new Error(`mock envelopes ${res.status}`);
  const json = (await res.json()) as {
    envelopes: Array<{
      envelopeId: string;
      customFields?: {
        textCustomFields?: { name: string; value: string }[];
      };
    }>;
  };
  const envelopes = (json.envelopes ?? []).map((e) => ({
    envelopeId: e.envelopeId,
    jobId:
      e.customFields?.textCustomFields?.find((f) => f.name === "job_id")
        ?.value ?? null,
  }));

  const map = new Map<string, EnvelopeCount>();
  for (const e of envelopes) {
    if (!e.jobId) continue;
    const cur = map.get(e.jobId) ?? {
      jobId: e.jobId,
      count: 0,
      envelopeIds: [],
    };
    cur.count += 1;
    cur.envelopeIds.push(e.envelopeId);
    map.set(e.jobId, cur);
  }
  const counts = [...map.values()];
  let duplicates = 0;
  for (const c of counts) {
    if (c.count > 1) duplicates += c.count - 1;
  }
  return { counts, duplicates, total: envelopes.length, envelopes };
}

export async function mockConfig(
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${MOCK_BASE}/mock/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`mock config ${res.status}`);
}

export async function createMockEnvelope(opts: {
  jobId: string;
  accountId?: string;
}): Promise<{ envelopeId: string }> {
  const accountId = opts.accountId ?? "demo-account";
  const res = await fetch(
    `${MOCK_BASE}/restapi/v2.1/accounts/${accountId}/envelopes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emailSubject: "pre-seeded",
        templateId: "offer-template-demo",
        status: "created",
        customFields: {
          textCustomFields: [{ name: "job_id", value: opts.jobId }],
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`create mock envelope ${res.status}`);
  return (await res.json()) as { envelopeId: string };
}

export function spawnWorker(
  name: string,
  env: Record<string, string | undefined> = {}
): ChildProcess {
  return spawn(TSX, ["src/worker.ts", `--name=${name}`], {
    cwd: process.cwd(),
    env: { ...process.env, ...workerTestEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function stopWorker(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve(child.exitCode);
      return;
    }
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(child.exitCode);
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
    child.kill("SIGINT");
  });
}

export async function waitForJobsSettled(
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE status IN ('queued', 'running')`
    );
    if (Number(rows[0]?.n ?? 0) === 0) return;
    await sleep(150);
  }
  const jobs = await getAllJobs();
  throw new Error(
    `jobs did not settle within ${timeoutMs}ms: ` +
      JSON.stringify(
        jobs.map((j) => ({
          id: j.id,
          status: j.status,
          attempts: j.attempts,
          error: j.error,
        }))
      )
  );
}

/** Spawn a worker and wait until no queued/running jobs remain, then stop it. */
export async function runWorkerUntilIdle(
  name: string,
  env: Record<string, string | undefined> = {},
  timeoutMs = 60_000
): Promise<void> {
  const child = spawnWorker(name, env);
  try {
    await waitForJobsSettled(timeoutMs);
  } finally {
    await stopWorker(child);
  }
}

export async function waitForWorkerExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<number | null> {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("worker did not exit")),
      timeoutMs
    );
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
