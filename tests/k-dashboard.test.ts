import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  MOCK_BASE,
  resetAll,
  sleep,
  TEST_DB,
  TSX,
  workerTestEnv,
} from "./helpers.js";

const DASH_PORT = 3001;
const DASH_URL = `http://localhost:${DASH_PORT}`;

let dash: ChildProcess | null = null;

async function waitForDash(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`${DASH_URL}/api/config`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error("dashboard did not start");
}

beforeAll(async () => {
  dash = spawn(TSX, ["src/dashboard/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...workerTestEnv,
      DATABASE_URL: TEST_DB,
      DOCUSIGN_BASE_URL: MOCK_BASE,
      DASHBOARD_PORT: String(DASH_PORT),
    },
    stdio: "inherit",
  });
  await waitForDash();
});

afterAll(async () => {
  if (dash && dash.exitCode == null) {
    dash.kill("SIGTERM");
    await sleep(500);
  }
  await closeTestPool();
});

beforeEach(async () => {
  await resetAll();
});

describe("K. Dashboard API", () => {
  it("26. GET jobs/logs/envelope-counts return 200 and shapes", async () => {
    const jobs = await fetch(`${DASH_URL}/api/jobs`);
    const logs = await fetch(`${DASH_URL}/api/logs`);
    const counts = await fetch(`${DASH_URL}/api/envelope-counts`);
    expect(jobs.status).toBe(200);
    expect(logs.status).toBe(200);
    expect(counts.status).toBe(200);
    const j = (await jobs.json()) as { jobs: unknown[] };
    const l = (await logs.json()) as { logs: unknown[] };
    const c = (await counts.json()) as {
      counts: unknown[];
      duplicates: number;
    };
    expect(Array.isArray(j.jobs)).toBe(true);
    expect(Array.isArray(l.logs)).toBe(true);
    expect(Array.isArray(c.counts)).toBe(true);
    expect(typeof c.duplicates).toBe("number");
  });

  it("27. POST /api/demo/* completes with 0 duplicates", async () => {
    const scenarios = ["normal", "crash", "timeout", "concurrent"] as const;
    for (const scenario of scenarios) {
      await resetAll();
      const res = await fetch(`${DASH_URL}/api/demo/${scenario}`, {
        method: "POST",
      });
      expect(res.status, scenario).toBe(200);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
      const counts = await fetch(`${DASH_URL}/api/envelope-counts`);
      const c = (await counts.json()) as { duplicates: number };
      expect(c.duplicates, scenario).toBe(0);
    }
  }, 300_000);

  it("28. POST /api/reset empties everything", async () => {
    await fetch(`${DASH_URL}/api/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    const res = await fetch(`${DASH_URL}/api/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const jobs = (await (await fetch(`${DASH_URL}/api/jobs`)).json()) as {
      jobs: unknown[];
    };
    const counts = (await (
      await fetch(`${DASH_URL}/api/envelope-counts`)
    ).json()) as { totalEnvelopes: number };
    expect(jobs.jobs).toHaveLength(0);
    expect(counts.totalEnvelopes).toBe(0);
  });
});
