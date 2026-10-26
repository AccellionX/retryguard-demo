/**
 * Step: ensure a draft envelope exists for this job (idempotent).
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getDocuSignClient,
  type DocuSignClient,
  type DocuSignEnvelope,
} from "../docusign/client.js";
import { pool } from "../db.js";

/** Written once when CRASH_AFTER_CREATE fires so a restarted worker runs normally. */
const CRASH_FLAG_PATH =
  process.env.CRASH_FLAG_PATH ?? join(process.cwd(), "data", "crashed.flag");

export interface EnsureEnvelopeContext {
  worker: string;
  attempt: number;
}

/**
 * Demo crash: log create + crash lines to job_logs (COMMITTED), then exit
 * before the worker can save result / mark done.
 */
async function maybeCrashAfterCreate(
  job: EnsureEnvelopeJob,
  envelopeId: string,
  ctx?: EnsureEnvelopeContext
): Promise<void> {
  if (process.env.CRASH_AFTER_CREATE !== "1") return;

  try {
    await access(CRASH_FLAG_PATH);
    // Flag already exists - previous crash demo ran; continue normally.
    return;
  } catch {
    // ENOENT → first crash
  }

  await mkdir(dirname(CRASH_FLAG_PATH), { recursive: true });
  await writeFile(
    CRASH_FLAG_PATH,
    `crashed after create envelopeId=${envelopeId} at ${new Date().toISOString()}\n`,
    "utf8"
  );

  // Persist demo story to job_logs and COMMIT before process.exit.
  if (ctx) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO job_logs (job_id, worker, step, message, attempt)
         VALUES ($1, $2, 'ensure_envelope', $3, $4)`,
        [job.id, ctx.worker, `created envelope ${envelopeId}`, ctx.attempt]
      );
      await client.query(
        `INSERT INTO job_logs (job_id, worker, step, message, attempt)
         VALUES ($1, $2, 'ensure_envelope', $3, $4)`,
        [
          job.id,
          ctx.worker,
          "worker crashed (simulated) before saving result",
          ctx.attempt,
        ]
      );
      await client.query(
        `UPDATE jobs SET last_step = 'ensure_envelope', updated_at = now() WHERE id = $1`,
        [job.id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  console.error(
    `[crash] CRASH_AFTER_CREATE: exiting after envelope ${envelopeId} (flag: ${CRASH_FLAG_PATH})`
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal job fields this step needs. */
export interface EnsureEnvelopeJob {
  id: string;
  created_at: Date | string;
  payload: {
    templateId: string;
    subject: string;
  };
}

/*
 * ============================================================================
 * WHY THIS MAKES RETRIES SAFE
 * ============================================================================
 *
 * Creating a DocuSign envelope is a side effect that must not run twice for the
 * same logical job. Network failures make that hard:
 *
 *   1. We POST "create envelope" to DocuSign.
 *   2. DocuSign creates the envelope successfully.
 *   3. Our HTTP response is lost (timeout, 504, process crash) - we never see
 *      envelopeId, so the job looks failed and the worker retries.
 *
 * A naive retry would create a *second* envelope → duplicate sends, duplicate
 * billing, confused signers.
 *
 * The fix: treat our job.id as an idempotency key that DocuSign itself holds.
 * Every create stamps a text custom field `job_id = <job.id>` on the envelope.
 * Before creating, we search DocuSign for an envelope with that custom field
 * (from the job's created_at so the query stays bounded).
 *
 *   - Found  → reuse it ("we already succeeded; we just lost the receipt").
 *   - Missing → create once, with the same job_id tag for the next attempt.
 *
 * Retries become safe because the authoritative "did we already create?" answer
 * lives on DocuSign's side, not only in our local DB / lost HTTP response.
 * ============================================================================
 */

/**
 * ensureEnvelope - the idempotent DocuSign step
 */
export async function ensureEnvelope(
  job: EnsureEnvelopeJob,
  client: DocuSignClient = getDocuSignClient(),
  ctx?: EnsureEnvelopeContext
): Promise<{ envelopeId: string; envelope: DocuSignEnvelope; reused: boolean }> {
  const lookupDisabled = process.env.DISABLE_LOOKUP === "1";

  const delayMs = Number(process.env.ENSURE_DELAY_MS ?? 0);
  if (delayMs > 0) await sleep(delayMs);

  if (!lookupDisabled) {
    const existing = await client.findEnvelopeByJobId(job.id, job.created_at);
    if (existing) {
      console.log(`reused existing envelope ${existing.envelopeId}`);
      return {
        envelopeId: existing.envelopeId,
        envelope: existing,
        reused: true,
      };
    }

    const pending = await pool.query(
      `SELECT 1 FROM pending_envelopes WHERE job_id = $1`,
      [job.id]
    );
    if ((pending.rowCount ?? 0) > 0) {
      const polls = Number(process.env.SEARCH_POLL_ATTEMPTS ?? 15) || 15;
      const pollMs = Number(process.env.SEARCH_POLL_MS ?? 250) || 250;
      for (let i = 0; i < polls; i++) {
        await sleep(pollMs);
        const found = await client.findEnvelopeByJobId(job.id, job.created_at);
        if (found) {
          console.log(`reused existing envelope ${found.envelopeId}`);
          return {
            envelopeId: found.envelopeId,
            envelope: found,
            reused: true,
          };
        }
      }
    }
  }

  await pool.query(
    `INSERT INTO pending_envelopes (job_id) VALUES ($1)
     ON CONFLICT (job_id) DO NOTHING`,
    [job.id]
  );

  const { envelopeId } = await client.createDraftEnvelope({
    jobId: job.id,
    templateId: job.payload.templateId,
    subject: job.payload.subject,
  });

  // Demo: log create + crash, COMMIT, then exit before worker saves result.
  await maybeCrashAfterCreate(job, envelopeId, ctx);

  return {
    envelopeId,
    envelope: { envelopeId, status: "created" },
    reused: false,
  };
}
