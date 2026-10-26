import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getAllJobs,
  getEnvelopeCounts,
  getLogs,
  getPool,
  resetAll,
  sleep,
  spawnWorker,
  stopWorker,
  waitForJobsSettled,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("E. Concurrency", () => {
  it("13. workers A+B on 5 jobs: all done, one worker each, 5 envelopes", async () => {
    await enqueue(5);
    const a = spawnWorker("A");
    const b = spawnWorker("B");
    try {
      await waitForJobsSettled(60_000);
    } finally {
      await stopWorker(a);
      await stopWorker(b);
    }
    const jobs = await getAllJobs();
    expect(jobs).toHaveLength(5);
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    for (const j of jobs) {
      const logs = await getLogs(j.id);
      const validators = [
        ...new Set(
          logs.filter((l) => l.step === "validate").map((l) => l.worker)
        ),
      ];
      expect(validators).toHaveLength(1);
    }
    const { total, duplicates } = await getEnvelopeCounts();
    expect(total).toBe(5);
    expect(duplicates).toBe(0);
  });

  it("14. stress: 4 workers, 50 jobs → 50 done, 50 envelopes, 0 dupes", async () => {
    await enqueue(50);
    const workers = ["A", "B", "C", "D"].map((n) => spawnWorker(n));
    try {
      await waitForJobsSettled(120_000);
    } finally {
      await Promise.all(workers.map(stopWorker));
    }
    const jobs = await getAllJobs();
    expect(jobs).toHaveLength(50);
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    for (const j of jobs) {
      const logs = await getLogs(j.id);
      const validators = [
        ...new Set(
          logs.filter((l) => l.step === "validate").map((l) => l.worker)
        ),
      ];
      expect(validators.length).toBe(1);
    }
    const { total, duplicates } = await getEnvelopeCounts();
    expect(total).toBe(50);
    expect(duplicates).toBe(0);
  });

  it("15. two workers race one job → only one claims it (SKIP LOCKED)", async () => {
    const [id] = await enqueue(1);
    // Pause next_run briefly then release both at once.
    await getPool().query(
      `UPDATE jobs SET next_run_at = now() + interval '1 second' WHERE id = $1`,
      [id]
    );
    const a = spawnWorker("A", { WORKER_POLL_MS: "50" });
    const b = spawnWorker("B", { WORKER_POLL_MS: "50" });
    await sleep(1_200);
    try {
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(a);
      await stopWorker(b);
    }
    const logs = await getLogs(id!);
    const validators = [
      ...new Set(logs.filter((l) => l.step === "validate").map((l) => l.worker)),
    ];
    expect(validators).toHaveLength(1);
    const { total } = await getEnvelopeCounts();
    expect(total).toBe(1);
  });
});
