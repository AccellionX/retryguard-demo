/**
 * End-to-end RetryGuard scenarios.
 *
 *   tsx src/scripts/demo.ts <normal|crash|timeout|concurrent>
 *
 * Requires: Postgres up + migrated, mock DocuSign on DOCUSIGN_BASE_URL.
 */
import "dotenv/config";
import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { closePool, pool } from "../db.js";
import { enqueueJobs } from "./enqueue.js";
import { printStatus } from "./status.js";

const CRASH_FLAG = join(process.cwd(), "data", "crashed.flag");
const TSX_BIN = join(process.cwd(), "node_modules/.bin/tsx");

function mockBaseUrl(): string {
  return (process.env.DOCUSIGN_BASE_URL ?? "http://localhost:4000").replace(
    /\/$/,
    ""
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function banner(title: string): void {
  console.log("\n" + "=".repeat(64));
  console.log(`  DEMO: ${title}`);
  console.log("=".repeat(64) + "\n");
}

async function ensureMockUp(): Promise<void> {
  const url = `${mockBaseUrl()}/mock/envelopes`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `Mock DocuSign not reachable at ${mockBaseUrl()}. Start it with: npm run mock:start\n` +
        `  (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

async function resetAll(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE pending_envelopes, job_logs, jobs RESTART IDENTITY CASCADE"
  );
  console.log("[demo] truncated jobs + job_logs");

  const resetRes = await fetch(`${mockBaseUrl()}/mock/reset`, { method: "POST" });
  if (!resetRes.ok) throw new Error(`mock reset failed: ${resetRes.status}`);
  console.log("[demo] cleared mock envelope store");

  await fetch(`${mockBaseUrl()}/mock/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ failRate: 0, timeoutRate: 0, timeoutOnce: false }),
  });

  try {
    await unlink(CRASH_FLAG);
    console.log("[demo] removed data/crashed.flag");
  } catch {
    // absent is fine
  }
}

function spawnWorker(
  name: string,
  env: Record<string, string | undefined> = {}
): ChildProcess {
  const child = spawn(TSX_BIN, ["src/worker.ts", `--name=${name}`], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("error", (err) => {
    console.error(`[demo] worker ${name} spawn error:`, err);
  });
  return child;
}

function stopWorker(child: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGINT");
  });
}

async function waitForJobsSettled(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs
       WHERE status IN ('queued', 'running')`
    );
    if (Number(rows[0]?.n ?? 0) === 0) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for jobs to settle (${timeoutMs}ms)`);
}

async function waitForWorkerExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<number | null> {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`worker did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioNormal(): Promise<void> {
  banner("normal - 1 worker, 3 jobs");
  await resetAll();
  await enqueueJobs(3);

  const worker = spawnWorker("A");
  try {
    await waitForJobsSettled(60_000);
  } finally {
    await stopWorker(worker);
  }
}

async function scenarioCrash(): Promise<void> {
  banner("crash - CRASH_AFTER_CREATE, stale lock 10s, auto-restart");
  await resetAll();
  await enqueueJobs(1);

  console.log("[demo] starting worker A with CRASH_AFTER_CREATE=1 …");
  const crashing = spawnWorker("A", {
    CRASH_AFTER_CREATE: "1",
    WORKER_STALE_SECONDS: "10",
  });

  const code = await waitForWorkerExit(crashing, 30_000);
  console.log(`[demo] worker A exited (code=${code}); restarting in 3s…`);
  await sleep(3_000);

  console.log(
    "[demo] starting A-restarted (stale TTL=10s; will recover + reuse envelope)…"
  );
  const recovered = spawnWorker("A-restarted", {
    WORKER_STALE_SECONDS: "10",
  });

  try {
    // ~create + 3s restart + up to 10s stale + processing headroom.
    await waitForJobsSettled(45_000);
  } finally {
    await stopWorker(recovered);
  }
}

async function scenarioTimeout(): Promise<void> {
  banner("timeout - mock loses first create response; worker reuses envelope");
  await resetAll();
  await enqueueJobs(1);

  const cfg = await fetch(`${mockBaseUrl()}/mock/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeoutRate: 1, timeoutOnce: true }),
  });
  if (!cfg.ok) throw new Error(`mock config failed: ${cfg.status}`);
  console.log("[demo] mock timeoutRate=1 timeoutOnce=true (first create only)");
  console.log("[demo] A-attempt1 will time out; A-retry will reuse the envelope");

  // First process: hits lost response, requeues with backoff, then we stop it
  // so the live log clearly shows a different worker on the retry.
  const first = spawnWorker("A-attempt1", {
    BACKOFF_BASE_MS: String(3_000),
  });
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const { rows } = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM jobs LIMIT 1`
    );
    const j = rows[0];
    if (j && j.status === "queued" && j.attempts >= 1) break;
    if (j && j.status === "done") break;
    await sleep(200);
  }
  await stopWorker(first);

  console.log("[demo] starting A-retry…");
  const retry = spawnWorker("A-retry");
  try {
    await waitForJobsSettled(60_000);
  } finally {
    await stopWorker(retry);
    await fetch(`${mockBaseUrl()}/mock/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutRate: 0, timeoutOnce: false }),
    });
  }
}

async function scenarioConcurrent(): Promise<void> {
  banner("concurrent - workers A + B on 5 jobs");
  await resetAll();
  await enqueueJobs(5);

  const a = spawnWorker("A");
  const b = spawnWorker("B");
  try {
    await waitForJobsSettled(60_000);
  } finally {
    await stopWorker(a);
    await stopWorker(b);
  }

  const { rows } = await pool.query<{ job_id: string; workers: string }>(
    `SELECT job_id::text,
            string_agg(DISTINCT worker, ',' ORDER BY worker) AS workers
     FROM job_logs
     WHERE step = 'validate'
     GROUP BY job_id
     ORDER BY job_id`
  );
  console.log("\n[demo] validate step claimed by:");
  for (const r of rows) {
    console.log(`  ${r.job_id.slice(0, 8)}… → ${r.workers}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SCENARIOS = ["normal", "crash", "timeout", "concurrent"] as const;
type Scenario = (typeof SCENARIOS)[number];

async function main(): Promise<void> {
  const name = (process.argv[2] ?? "").toLowerCase() as Scenario;
  if (!SCENARIOS.includes(name)) {
    console.error(
      `Usage: tsx src/scripts/demo.ts <${SCENARIOS.join("|")}>`
    );
    process.exitCode = 1;
    return;
  }

  await ensureMockUp();

  switch (name) {
    case "normal":
      await scenarioNormal();
      break;
    case "crash":
      await scenarioCrash();
      break;
    case "timeout":
      await scenarioTimeout();
      break;
    case "concurrent":
      await scenarioConcurrent();
      break;
  }

  console.log("\n[demo] final status:");
  await printStatus();
  await closePool();
}

main().catch(async (err) => {
  console.error("[demo] failed:", err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
