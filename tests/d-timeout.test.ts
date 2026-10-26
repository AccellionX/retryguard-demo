import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getJob,
  mockConfig,
  resetAll,
  runWorkerUntilIdle,
  sleep,
  spawnWorker,
  stopWorker,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("D. Uncertain API success", () => {
  it("10. timeoutOnce: first attempt times out, envelope exists, job requeued", async () => {
    const [id] = await enqueue(1);
    await mockConfig({ timeoutRate: 1, timeoutOnce: true });

    const child = spawnWorker("A", {
      DOCUSIGN_CREATE_TIMEOUT_MS: "500",
      BACKOFF_BASE_MS: "2000", // keep next_run_at in the future briefly
    });

    // Wait until first attempt fails and requeues.
    const start = Date.now();
    let job = await getJob(id!);
    while (Date.now() - start < 15_000) {
      job = await getJob(id!);
      if (job?.status === "queued" && job.attempts >= 1 && job.error) break;
      await sleep(100);
    }
    await stopWorker(child);

    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBeGreaterThanOrEqual(1);
    expect(String(job?.error ?? "")).toMatch(/timed out|timeout/i);
    expect(new Date(job!.next_run_at).getTime()).toBeGreaterThan(Date.now() - 500);
    const { total } = await getEnvelopeCounts();
    expect(total).toBe(1);
  });

  it("11. retry after timeout reuses envelope → done, 1 total", async () => {
    const [id] = await enqueue(1);
    await mockConfig({ timeoutRate: 1, timeoutOnce: true });
    await runWorkerUntilIdle(
      "A",
      { DOCUSIGN_CREATE_TIMEOUT_MS: "500", BACKOFF_BASE_MS: "200" },
      60_000
    );
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    const { total, duplicates } = await getEnvelopeCounts();
    expect(total).toBe(1);
    expect(duplicates).toBe(0);
  });

  it("12. failRate=1 then 0: no envelope on fail; succeeds with 1 envelope", async () => {
    const [id] = await enqueue(1);
    await mockConfig({ failRate: 1 });

    const child = spawnWorker("A", { BACKOFF_BASE_MS: "300" });
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const job = await getJob(id!);
      if (job && job.attempts >= 1 && job.status === "queued") break;
      await sleep(100);
    }
    let { total } = await getEnvelopeCounts();
    expect(total).toBe(0);

    await mockConfig({ failRate: 0 });
    try {
      const { waitForJobsSettled } = await import("./helpers.js");
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(child);
    }

    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    total = (await getEnvelopeCounts()).total;
    expect(total).toBe(1);
  });
});
