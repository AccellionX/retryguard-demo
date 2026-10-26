import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getJob,
  resetAll,
  sleep,
  spawnWorker,
  stopWorker,
  waitForJobsSettled,
  waitForWorkerExit,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("C. Crash recovery", () => {
  it("7. CRASH_AFTER_CREATE exits non-zero; job left running without envelopeId", async () => {
    const [id] = await enqueue(1);
    const child = spawnWorker("A", { CRASH_AFTER_CREATE: "1" });
    const code = await waitForWorkerExit(child, 20_000);
    expect(code).not.toBe(0);
    const job = await getJob(id!);
    expect(job?.status).toBe("running");
    expect(job?.result?.envelopeId).toBeFalsy();
    const { total } = await getEnvelopeCounts();
    expect(total).toBe(1);
  });

  it("8. after stale timeout, new worker requeues, reuses same envelope, attempts=2", async () => {
    const [id] = await enqueue(1);
    const crashing = spawnWorker("A", {
      CRASH_AFTER_CREATE: "1",
      WORKER_STALE_SECONDS: "3",
    });
    await waitForWorkerExit(crashing, 20_000);
    const before = await getEnvelopeCounts();
    expect(before.total).toBe(1);
    const envelopeId = before.envelopes[0]!.envelopeId;

    // Wait past stale TTL, then recover with a fresh worker (flag already set).
    await sleep(3_500);
    const recovered = spawnWorker("B", {
      WORKER_STALE_SECONDS: "3",
      CRASH_AFTER_CREATE: "1", // flag present → must not crash again
    });
    try {
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(recovered);
    }

    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(2);
    expect(job?.result?.envelopeId).toBe(envelopeId);
    const after = await getEnvelopeCounts();
    expect(after.total).toBe(1);
    expect(after.duplicates).toBe(0);
  });

  it("9. crash flag only fires once", async () => {
    const [id] = await enqueue(1);
    const first = spawnWorker("A", { CRASH_AFTER_CREATE: "1" });
    expect(await waitForWorkerExit(first, 20_000)).not.toBe(0);

    await sleep(3_500);
    const second = spawnWorker("A", {
      CRASH_AFTER_CREATE: "1",
      WORKER_STALE_SECONDS: "3",
    });
    try {
      await waitForJobsSettled(30_000);
    } finally {
      await stopWorker(second);
    }
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
  });
});
