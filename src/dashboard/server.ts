/**
 * RetryGuard demo dashboard - Express on port 3000.
 *
 *   npm run dashboard
 *
 * Serves plain HTML/JS and thin JSON APIs over jobs, logs, mock envelopes,
 * reset, enqueue, and demo scenario spawns.
 */
import "dotenv/config";
import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { pool } from "../db.js";
import { enqueueJobs } from "../scripts/enqueue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const TSX_BIN = join(process.cwd(), "node_modules/.bin/tsx");
const CRASH_FLAG = join(process.cwd(), "data", "crashed.flag");
const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);

const SCENARIOS = new Set(["normal", "crash", "timeout", "concurrent"]);

function mockBaseUrl(): string {
  return (process.env.DOCUSIGN_BASE_URL ?? "http://localhost:4000").replace(
    /\/$/,
    ""
  );
}

/** Currently running demo child (at most one). */
let demoProc: ChildProcess | null = null;
let demoScenario: string | null = null;

/**
 * When true (default), demos run with lookup-before-create.
 * When false, DISABLE_LOOKUP=1 so the timeout demo produces duplicates.
 */
let lookupProtection = true;

function stopDemo(): Promise<void> {
  return new Promise((resolve) => {
    if (!demoProc || demoProc.exitCode != null) {
      demoProc = null;
      demoScenario = null;
      resolve();
      return;
    }
    const child = demoProc;
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      demoProc = null;
      demoScenario = null;
      resolve();
    }, 4_000);
    child.once("exit", () => {
      clearTimeout(t);
      demoProc = null;
      demoScenario = null;
      resolve();
    });
    child.kill("SIGINT");
  });
}

async function resetAll(): Promise<void> {
  await stopDemo();
  await pool.query(
    "TRUNCATE TABLE pending_envelopes, job_logs, jobs RESTART IDENTITY CASCADE"
  );

  try {
    await fetch(`${mockBaseUrl()}/mock/reset`, { method: "POST" });
    await fetch(`${mockBaseUrl()}/mock/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failRate: 0, timeoutRate: 0, timeoutOnce: false }),
    });
  } catch (err) {
    throw new Error(
      `Mock DocuSign unreachable at ${mockBaseUrl()}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  try {
    await unlink(CRASH_FLAG);
  } catch {
    // ok if missing
  }
}

interface MockEnvelope {
  envelopeId: string;
  customFields?: {
    textCustomFields?: { name: string; value: string }[];
  };
}

async function fetchMockEnvelopes(): Promise<MockEnvelope[]> {
  try {
    const res = await fetch(`${mockBaseUrl()}/mock/envelopes`);
    if (!res.ok) return [];
    const json = (await res.json()) as { envelopes?: MockEnvelope[] };
    return json.envelopes ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/api/config", (_req, res) => {
  res.json({
    mode: process.env.DOCUSIGN_MODE ?? "mock",
    mockBaseUrl: mockBaseUrl(),
    demoRunning: demoScenario,
    lookupProtection,
  });
});

/** Toggle lookup-before-create for the next demo run. Body: { enabled: boolean } */
app.post("/api/lookup-protection", (req, res) => {
  if (typeof req.body?.enabled === "boolean") {
    lookupProtection = req.body.enabled;
  } else if (typeof req.body?.lookupProtection === "boolean") {
    lookupProtection = req.body.lookupProtection;
  }
  console.log(
    `[dashboard] lookup protection → ${lookupProtection ? "ON" : "OFF"}`
  );
  res.json({ lookupProtection });
});

app.get("/api/jobs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, payload, status, attempts, max_attempts,
              locked_by, locked_at, next_run_at, last_step, result, error,
              completed_by, created_at, updated_at
       FROM jobs
       ORDER BY created_at`
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/logs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, job_id, worker, step, message, attempt, created_at
       FROM job_logs
       ORDER BY id DESC
       LIMIT 150`
    );
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/envelope-counts", async (_req, res) => {
  try {
    const envelopes = await fetchMockEnvelopes();
    const byJob = new Map<string, { count: number; envelopeIds: string[] }>();

    for (const env of envelopes) {
      const jobId = env.customFields?.textCustomFields?.find(
        (f) => f.name === "job_id"
      )?.value;
      if (!jobId) continue;
      const cur = byJob.get(jobId) ?? { count: 0, envelopeIds: [] };
      cur.count += 1;
      cur.envelopeIds.push(env.envelopeId);
      byJob.set(jobId, cur);
    }

    const counts = [...byJob.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([jobId, v]) => ({
        jobId,
        count: v.count,
        envelopeIds: v.envelopeIds,
      }));

    let duplicates = 0;
    for (const c of counts) {
      if (c.count > 1) duplicates += c.count - 1;
    }

    res.json({ counts, duplicates, totalEnvelopes: envelopes.length });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/enqueue", async (req, res) => {
  try {
    const count = Math.min(
      50,
      Math.max(1, Number(req.body?.count ?? 3) || 3)
    );
    const ids = await enqueueJobs(count);
    res.json({ ok: true, count: ids.length, ids });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/reset", async (_req, res) => {
  try {
    await resetAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Spawn src/scripts/demo.ts <scenario> and wait until it exits.
 * Blocks the HTTP request for the duration of the demo (crash ~15-20s, etc.).
 */
app.post("/api/demo/:scenario", async (req, res) => {
  const scenario = String(req.params.scenario ?? "").toLowerCase();
  if (!SCENARIOS.has(scenario)) {
    res.status(400).json({
      error: `Unknown scenario. Use: ${[...SCENARIOS].join(", ")}`,
    });
    return;
  }
  if (demoProc && demoProc.exitCode == null) {
    res.status(409).json({
      error: `Demo already running: ${demoScenario}`,
    });
    return;
  }

  try {
    const disableLookup = !lookupProtection;
    await new Promise<void>((resolve, reject) => {
      console.log(
        `[dashboard] starting demo: ${scenario}` +
          ` (lookupProtection=${lookupProtection ? "ON" : "OFF"})`
      );
      const child = spawn(TSX_BIN, ["src/scripts/demo.ts", scenario], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Explicit on/off so a leftover shell env cannot leak into demos.
          DISABLE_LOOKUP: disableLookup ? "1" : "0",
        },
        stdio: "inherit",
      });
      demoProc = child;
      demoScenario = scenario;

      child.on("error", (err) => {
        demoProc = null;
        demoScenario = null;
        reject(err);
      });
      child.on("exit", (code, signal) => {
        demoProc = null;
        demoScenario = null;
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Demo ${scenario} exited with code=${code} signal=${signal}`
            )
          );
      });
    });

    const envelopes = await fetchMockEnvelopes();
    const byJob = new Map<string, number>();
    for (const env of envelopes) {
      const jobId = env.customFields?.textCustomFields?.find(
        (f) => f.name === "job_id"
      )?.value;
      if (!jobId) continue;
      byJob.set(jobId, (byJob.get(jobId) ?? 0) + 1);
    }
    let duplicates = 0;
    for (const n of byJob.values()) {
      if (n > 1) duplicates += n - 1;
    }

    let message = `Demo "${scenario}" finished`;
    if (!lookupProtection && scenario === "timeout") {
      message +=
        duplicates > 0
          ? ` - lookup OFF as expected: Duplicates: ${duplicates}`
          : " - lookup OFF but no duplicates (unexpected)";
    }

    res.json({
      ok: true,
      scenario,
      lookupProtection,
      duplicates,
      message,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
  console.log(
    `[dashboard] DOCUSIGN_MODE=${process.env.DOCUSIGN_MODE ?? "mock"}` +
      `  mock=${mockBaseUrl()}`
  );
});
