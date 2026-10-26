import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getJob,
  resetAll,
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

describe("G. Stale lock edge case", () => {
  /**
   * Slow worker holds the job longer than WORKER_STALE_SECONDS while a second
   * worker runs. Heartbeat renews locked_at; fencing prevents a stolen lease
   * from saving. Expect exactly one envelope.
   */
  it("20. slow ensure_envelope + second worker → no duplicate envelopes", async () => {
    const [id] = await enqueue(1);
    // Delay inside ensureEnvelope (5s) > stale TTL (3s). Without heartbeat this
    // would be stolen; with heartbeat + fencing we must still get 1 envelope.
    const slow = spawnWorker("SLOW", {
      ENSURE_DELAY_MS: "5000",
      WORKER_STALE_SECONDS: "3",
      WORKER_HEARTBEAT_MS: "500",
      WORKER_POLL_MS: "100",
    });
    const thief = spawnWorker("THIEF", {
      WORKER_STALE_SECONDS: "3",
      WORKER_POLL_MS: "100",
    });
    try {
      await waitForJobsSettled(40_000);
    } finally {
      await stopWorker(slow);
      await stopWorker(thief);
    }
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    const { total, duplicates } = await getEnvelopeCounts();
    expect(total).toBe(1);
    expect(duplicates).toBe(0);
  });
});
