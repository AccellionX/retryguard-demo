import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  enqueue,
  getAllJobs,
  getEnvelopeCounts,
  getJob,
  getLogs,
  resetAll,
  runWorkerUntilIdle,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("A. Happy path", () => {
  it("1. single job ends done with one matching envelope", async () => {
    const [id] = await enqueue(1);
    await runWorkerUntilIdle("A");
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    expect(job?.result?.envelopeId).toBeTruthy();
    const { total, counts } = await getEnvelopeCounts();
    expect(total).toBe(1);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.jobId).toBe(id);
    expect(counts[0]!.envelopeIds[0]).toBe(job!.result.envelopeId);
  });

  it("2. three jobs: all done, 3 distinct envelopes matching job_ids", async () => {
    const ids = await enqueue(3);
    await runWorkerUntilIdle("A");
    const jobs = await getAllJobs();
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    const { total, counts, envelopes } = await getEnvelopeCounts();
    expect(total).toBe(3);
    expect(counts).toHaveLength(3);
    const envIds = new Set(envelopes.map((e) => e.envelopeId));
    expect(envIds.size).toBe(3);
    for (const id of ids) {
      const job = jobs.find((j) => j.id === id)!;
      const tagged = envelopes.find((e) => e.jobId === id);
      expect(tagged?.envelopeId).toBe(job.result.envelopeId);
    }
  });

  it("3. logs validate → ensure_envelope → save_result with worker name", async () => {
    const [id] = await enqueue(1);
    await runWorkerUntilIdle("W1");
    const logs = await getLogs(id!);
    const steps = logs
      .filter((l) =>
        ["validate", "ensure_envelope", "save_result"].includes(l.step)
      )
      .map((l) => l.step);
    expect(steps).toEqual(["validate", "ensure_envelope", "save_result"]);
    for (const l of logs.filter((x) =>
      ["validate", "ensure_envelope", "save_result"].includes(x.step)
    )) {
      expect(l.worker).toBe("W1");
    }
  });
});
