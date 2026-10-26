import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocuSignClient } from "../src/docusign/client.js";
import { ensureEnvelope } from "../src/steps/ensureEnvelope.js";
import {
  closeTestPool,
  createMockEnvelope,
  enqueue,
  getEnvelopeCounts,
  getJob,
  resetAll,
  runWorkerUntilIdle,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe("B. Idempotency", () => {
  it('4. ensureEnvelope twice → 1 envelope; second logs "reused existing envelope"', async () => {
    const [id] = await enqueue(1);
    const job = await getJob(id!);
    const client = getDocuSignClient();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const first = await ensureEnvelope(
      {
        id: job!.id,
        created_at: job!.created_at,
        payload: {
          templateId: job!.payload.templateId,
          subject: job!.payload.subject,
        },
      },
      client
    );
    expect(first.reused).toBe(false);

    const second = await ensureEnvelope(
      {
        id: job!.id,
        created_at: job!.created_at,
        payload: {
          templateId: job!.payload.templateId,
          subject: job!.payload.subject,
        },
      },
      client
    );
    expect(second.reused).toBe(true);
    expect(second.envelopeId).toBe(first.envelopeId);

    const reusedLog = spy.mock.calls.some((c) =>
      String(c[0]).includes("reused existing envelope")
    );
    expect(reusedLog).toBe(true);
    spy.mockRestore();

    const { total } = await getEnvelopeCounts();
    expect(total).toBe(1);
  });

  it("5. pre-existing envelope for job_id is reused; still 1 total", async () => {
    const [id] = await enqueue(1);
    const seeded = await createMockEnvelope({ jobId: id! });
    await runWorkerUntilIdle("A");
    const job = await getJob(id!);
    expect(job?.status).toBe("done");
    expect(job?.result?.envelopeId).toBe(seeded.envelopeId);
    const { total } = await getEnvelopeCounts();
    expect(total).toBe(1);
  });

  it("6. envelope tagged with a different job_id is never reused", async () => {
    const ids = await enqueue(1);
    const id = ids[0]!;
    await createMockEnvelope({ jobId: "00000000-0000-0000-0000-000000000099" });
    await runWorkerUntilIdle("A");
    const job = await getJob(id);
    expect(job?.status).toBe("done");
    const { total, envelopes } = await getEnvelopeCounts();
    expect(total).toBe(2);
    const mine = envelopes.find((e) => e.jobId === id);
    expect(mine?.envelopeId).toBe(job!.result.envelopeId);
    expect(mine?.envelopeId).not.toBeUndefined();
  });
});
