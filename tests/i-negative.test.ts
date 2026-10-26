import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getEnvelopeCounts,
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

describe("I. Negative control", () => {
  it("22. DISABLE_LOOKUP=1 + timeout scenario → duplicates MUST be > 0", async () => {
    await enqueue(1);
    await mockConfig({ timeoutRate: 1, timeoutOnce: true });
    await runWorkerUntilIdle(
      "A",
      {
        DISABLE_LOOKUP: "1",
        DOCUSIGN_CREATE_TIMEOUT_MS: "500",
        BACKOFF_BASE_MS: "200",
      },
      60_000
    );
    const { total, duplicates } = await getEnvelopeCounts();
    // Protection disabled: lost-response retry creates a second envelope.
    expect(total).toBeGreaterThan(1);
    expect(duplicates).toBeGreaterThan(0);
  });
});
