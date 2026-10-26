import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getPool,
  resetAll,
  runWorkerUntilIdle,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("J. Data integrity", () => {
  it("23. job_logs all reference existing jobs", async () => {
    await enqueue(2);
    await runWorkerUntilIdle("A");
    const { rows } = await getPool().query(
      `SELECT jl.id
       FROM job_logs jl
       LEFT JOIN jobs j ON j.id = jl.job_id
       WHERE j.id IS NULL`
    );
    expect(rows).toHaveLength(0);
  });

  it("24. reset clears jobs, logs, and mock envelopes", async () => {
    await enqueue(2);
    await runWorkerUntilIdle("A");
    await resetAll();
    const jobs = await getPool().query(`SELECT count(*)::int AS n FROM jobs`);
    const logs = await getPool().query(
      `SELECT count(*)::int AS n FROM job_logs`
    );
    expect(jobs.rows[0].n).toBe(0);
    expect(logs.rows[0].n).toBe(0);
    const { total } = await getEnvelopeCounts();
    expect(total).toBe(0);
  });

  it("25. no hardcoded credentials in src/", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js|html)$/.test(name)) files.push(p);
      }
    };
    walk(root);

    const suspicious =
      /(api[_-]?key\s*[:=]\s*['"][^'"]+['"]|password\s*[:=]\s*['"][^'"]+['"]|secret\s*[:=]\s*['"][^'"]+['"]|Bearer\s+[A-Za-z0-9\-_]{20,}|-----BEGIN (RSA )?PRIVATE KEY-----)/i;

    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (suspicious.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
