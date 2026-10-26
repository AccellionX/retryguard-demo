import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
  getJob,
  mockConfig,
  resetAll,
  runWorkerUntilIdle,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("H. Search lag", () => {
  it("21. timeout + searchLagMs=2000 still ends with 1 envelope (pending + poll)", async () => {
    const [id] = await enqueue(1);
    await mockConfig({
      timeoutRate: 1,
      timeoutOnce: true,
      searchLagMs: 2000,
    });
    await runWorkerUntilIdle(
      "A",
      {
        DOCUSIGN_CREATE_TIMEOUT_MS: "500",
        BACKOFF_BASE_MS: "200",
        SEARCH_POLL_MS: "250",
        SEARCH_POLL_ATTEMPTS: "20",
      },
      90_000
    );
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    const { total, duplicates } = await getEnvelopeCounts();
    expect(total).toBe(1);
    expect(duplicates).toBe(0);
  });
});
