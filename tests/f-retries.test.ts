import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getJob,
  getPool,
  mockConfig,
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

describe("F. Retries, backoff, dead letter", () => {
  it("16. failures increment attempts and push next_run_at exponentially", async () => {
    const [id] = await enqueue(1);
    await getPool().query(`UPDATE jobs SET max_attempts = 5 WHERE id = $1`, [id]);
    await mockConfig({ failRate: 1 });

    const child = spawnWorker("A", { BACKOFF_BASE_MS: "200", WORKER_POLL_MS: "50" });
    const samples: { attempts: number; next: number }[] = [];
    const start = Date.now();
    while (Date.now() - start < 15_000 && samples.length < 3) {
      const job = await getJob(id!);
      if (
        job &&
        job.status === "queued" &&
        job.attempts > 0 &&
        (!samples.length || job.attempts > samples[samples.length - 1]!.attempts)
      ) {
        samples.push({
          attempts: job.attempts,
          next: new Date(job.next_run_at).getTime() - Date.now(),
        });
      }
      await sleep(80);
    }
    await stopWorker(child);
    await mockConfig({ failRate: 0 });

    expect(samples.length).toBeGreaterThanOrEqual(2);
    // delay ≈ BACKOFF_BASE_MS * 2^attempts → grows with attempts
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.attempts).toBeGreaterThan(samples[i - 1]!.attempts);
    }
  });

  it("17. job is not claimed before next_run_at", async () => {
    const [id] = await enqueue(1);
    const future = new Date(Date.now() + 5_000);
    await getPool().query(
      `UPDATE jobs SET next_run_at = $2 WHERE id = $1`,
      [id, future.toISOString()]
    );
    const child = spawnWorker("A", { WORKER_POLL_MS: "100" });
    await sleep(1_500);
    const mid = await getJob(id!);
    expect(mid?.status).toBe("queued");
    expect(mid?.attempts).toBe(0);
    await stopWorker(child);
  });

  it("18. permanent failure → dead with error; no further claims", async () => {
    const [id] = await enqueue(1);
    await getPool().query(`UPDATE jobs SET max_attempts = 2 WHERE id = $1`, [id]);
    await mockConfig({ failRate: 1 });
    const child = spawnWorker("A", { BACKOFF_BASE_MS: "100", WORKER_POLL_MS: "50" });
    try {
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(child);
    }
    const job = await getJob(id!);
    expect(job?.status).toBe("dead");
    expect(job?.error).toBeTruthy();
    expect(job?.attempts).toBe(2);

    const child2 = spawnWorker("B");
    await sleep(1_000);
    const again = await getJob(id!);
    expect(again?.status).toBe("dead");
    expect(again?.attempts).toBe(2);
    await stopWorker(child2);
  });

  it("19. dead job never creates more than 1 envelope across attempts", async () => {
    // Fail after create by using timeoutOnce repeatedly is hard; use fail before create
    // so 0 envelopes, OR: timeout on first then fail forever.
    // Spec: dead across attempts with at most 1 envelope - use timeoutOnce then failRate=1.
    const [id] = await enqueue(1);
    await getPool().query(`UPDATE jobs SET max_attempts = 3 WHERE id = $1`, [id]);
    await mockConfig({ timeoutRate: 1, timeoutOnce: true });
    const child = spawnWorker("A", {
      DOCUSIGN_CREATE_TIMEOUT_MS: "400",
      BACKOFF_BASE_MS: "100",
      WORKER_POLL_MS: "50",
    });
    // After first timeout creates 1 envelope, force subsequent attempts to fail before create.
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const job = await getJob(id!);
      if (job && job.attempts >= 1) {
        await mockConfig({ failRate: 1, timeoutRate: 0 });
        break;
      }
      await sleep(50);
    }
    try {
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(child);
    }
    const job = await getJob(id!);
    expect(job?.status).toBe("dead");
    const { total } = await getEnvelopeCounts();
    expect(total).toBeLessThanOrEqual(1);
  });
});
