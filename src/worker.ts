/**
 * Durable job worker.
 *
 *   tsx src/worker.ts --name=A
 *
 * Claims queued jobs, runs create_offer_draft steps, recovers stale locks,
 * and backs off / marks dead on failure. SIGINT stops after the current tick.
 */
import "dotenv/config";
import type pg from "pg";
import {
  DocuSignTimeoutError,
  getDocuSignClient,
} from "./docusign/client.js";
import { closePool, pool } from "./db.js";
import { ensureEnvelope } from "./steps/ensureEnvelope.js";
import { validateCreateOfferDraft } from "./steps/validate.js";

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

function parseName(argv: string[]): string {
  const flag = argv.find((a) => a.startsWith("--name="));
  if (flag) return flag.slice("--name=".length) || "worker";
  const idx = argv.indexOf("--name");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1]!;
  return "worker";
}

const WORKER_NAME = parseName(process.argv.slice(2));
/** Lock TTL before a running job is requeued (tests: WORKER_STALE_SECONDS=3). */
const STALE_SECONDS = Number(process.env.WORKER_STALE_SECONDS ?? 60) || 60;
/** Idle poll interval (tests: WORKER_POLL_MS=100). */
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1_000) || 1_000;
/**
 * Backoff delay = BACKOFF_BASE_MS * 2^attempts (default base 1000 → 2s, 4s, …).
 * Tests set BACKOFF_BASE_MS=200.
 */
const BACKOFF_BASE_MS = Number(process.env.BACKOFF_BASE_MS ?? 1_000) || 1_000;
/** How often to renew locked_at while processing (fencing / anti-stale-steal). */
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 1_000) || 1_000;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function log(message: string): void {
  console.log(`[${WORKER_NAME}] ${message}`);
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  type: string;
  payload: {
    templateId?: string;
    subject?: string;
    [key: string]: unknown;
  };
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  next_run_at: Date;
  last_step: string | null;
  result: unknown;
  error: string | null;
  completed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export class FencingError extends Error {
  constructor(jobId: string) {
    super(`lost lease on job ${jobId} (locked_by no longer ${WORKER_NAME})`);
    this.name = "FencingError";
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function writeJobLog(
  client: pg.PoolClient | typeof pool,
  jobId: string,
  step: string,
  message: string,
  attempt: number | null = null
): Promise<void> {
  await client.query(
    `INSERT INTO job_logs (job_id, worker, step, message, attempt)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, WORKER_NAME, step, message, attempt]
  );
}

async function setLastStep(
  client: pg.PoolClient,
  jobId: string,
  step: string
): Promise<void> {
  await client.query(
    `UPDATE jobs SET last_step = $2, updated_at = now() WHERE id = $1`,
    [jobId, step]
  );
}

/** Renew locked_at so long-running steps are not stolen as "stale". */
async function heartbeat(jobId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET locked_at = now(), updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, WORKER_NAME]
  );
  return (rowCount ?? 0) > 0;
}

function startHeartbeat(jobId: string): () => void {
  const t = setInterval(() => {
    heartbeat(jobId).catch((err) => {
      console.error(`[${WORKER_NAME}] heartbeat error:`, err);
    });
  }, HEARTBEAT_MS);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * requeueStale / recoverStaleJobs
 * -------------------------------
 * If a worker dies mid-job (crash demo), the row stays status='running' forever
 * unless someone clears the lock. Any worker, on each loop, requeues rows whose
 * locked_at is older than WORKER_STALE_SECONDS (default 60; demos use 10).
 * Live workers renew locked_at via heartbeat so healthy long jobs are not stolen.
 */
async function recoverStaleJobs(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE jobs
     SET status = 'queued',
         locked_by = NULL,
         locked_at = NULL,
         updated_at = now()
     WHERE status = 'running'
       AND locked_at < now() - ($1::text || ' seconds')::interval
     RETURNING id`,
    [String(STALE_SECONDS)]
  );

  for (const row of rows) {
    log(`recovered stale job ${shortId(row.id)}…`);
    await pool.query(
      `INSERT INTO job_logs (job_id, worker, step, message, attempt)
       VALUES ($1, $2, 'recover', $3, NULL)`,
      [row.id, WORKER_NAME, `recovered stale lock after ${STALE_SECONDS}s`]
    );
  }
}

/**
 * claimJob
 * --------
 * Atomically take the next due job. FOR UPDATE SKIP LOCKED is the key:
 * this worker locks one row; concurrent workers skip it and take another
 * (no double-processing, no blocking waits). attempts++ happens here so backoff
 * and max_attempts see the attempt that is about to run.
 */
async function claimJob(): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'queued' AND next_run_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );

    const row = rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }

    const { rows: updated } = await client.query<JobRow>(
      `UPDATE jobs
       SET status = 'running',
           locked_by = $2,
           locked_at = now(),
           attempts = attempts + 1,
           error = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id, WORKER_NAME]
    );

    await client.query("COMMIT");
    return updated[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Persist result only if we still hold the lease (fencing token = locked_by). */
async function markDone(
  jobId: string,
  envelopeId: string
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET status = 'done',
         result = $2::jsonb,
         completed_by = $3,
         locked_by = NULL,
         locked_at = NULL,
         error = NULL,
         updated_at = now()
     WHERE id = $1 AND locked_by = $3 AND status = 'running'`,
    [jobId, JSON.stringify({ envelopeId }), WORKER_NAME]
  );
  if ((rowCount ?? 0) === 0) {
    throw new FencingError(jobId);
  }
  await pool.query(`DELETE FROM pending_envelopes WHERE job_id = $1`, [jobId]);
}

/**
 * On error: clear the lock, then either dead-letter (attempts >= max_attempts)
 * or requeue with exponential backoff next_run_at = now() + BACKOFF_BASE_MS * 2^attempts.
 */
async function markFailure(job: JobRow, err: unknown): Promise<void> {
  if (err instanceof FencingError) {
    log(`fencing: abandoned job ${shortId(job.id)}… (${err.message})`);
    await writeJobLog(pool, job.id, "fencing", err.message, job.attempts);
    return;
  }

  let message = err instanceof Error ? err.message : String(err);
  // Clearer live-log story for the timeout / lost-response demo.
  if (
    err instanceof DocuSignTimeoutError ||
    /timed out|timeout/i.test(message)
  ) {
    message = "create timed out after 5s (envelope may exist)";
  }

  const attempts = job.attempts;
  const dead = attempts >= job.max_attempts;

  if (dead) {
    await pool.query(
      `UPDATE jobs
       SET status = 'dead',
           error = $2,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [job.id, message]
    );
    log(`job ${shortId(job.id)}… dead after ${attempts} attempt(s): ${message}`);
  } else {
    const delayMs = BACKOFF_BASE_MS * 2 ** attempts;
    await pool.query(
      `UPDATE jobs
       SET status = 'queued',
           error = $2,
           next_run_at = now() + ($3::text || ' milliseconds')::interval,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [job.id, message, String(delayMs)]
    );
    log(
      `job ${shortId(job.id)}… failed (attempt ${attempts}/${job.max_attempts}),` +
        ` retry in ${delayMs}ms: ${message}`
    );
  }

  await writeJobLog(pool, job.id, "error", message, attempts);
}

// ---------------------------------------------------------------------------
// Steps: create_offer_draft
// ---------------------------------------------------------------------------

async function runCreateOfferDraft(job: JobRow): Promise<void> {
  const client = await pool.connect();
  const stopHeartbeat = startHeartbeat(job.id);
  try {
    const attempt = job.attempts;

    // --- validate ---
    validateCreateOfferDraft(job);
    await setLastStep(client, job.id, "validate");
    await writeJobLog(client, job.id, "validate", "payload ok", attempt);
    log(`validate: ok`);

    // --- ensure_envelope (may process.exit under CRASH_AFTER_CREATE) ---
    const ensured = await ensureEnvelope(
      {
        id: job.id,
        created_at: job.created_at,
        payload: {
          templateId: job.payload.templateId!,
          subject: job.payload.subject!,
        },
      },
      getDocuSignClient(),
      { worker: WORKER_NAME, attempt }
    );

    // Fencing: still our lease?
    if (!(await heartbeat(job.id))) {
      throw new FencingError(job.id);
    }

    await setLastStep(client, job.id, "ensure_envelope");
    const ensureMsg = ensured.reused
      ? `reused existing envelope ${ensured.envelopeId}`
      : `created envelope ${ensured.envelopeId}`;
    await writeJobLog(client, job.id, "ensure_envelope", ensureMsg, attempt);
    log(
      ensured.reused
        ? `ensure_envelope: reused env ${shortId(ensured.envelopeId)}…`
        : `ensure_envelope: created env ${shortId(ensured.envelopeId)}…`
    );

    // --- save_result (fenced) ---
    const save = await client.query(
      `UPDATE jobs
       SET result = $2::jsonb,
           last_step = 'save_result',
           updated_at = now()
       WHERE id = $1 AND locked_by = $3 AND status = 'running'`,
      [
        job.id,
        JSON.stringify({ envelopeId: ensured.envelopeId }),
        WORKER_NAME,
      ]
    );
    if ((save.rowCount ?? 0) === 0) {
      throw new FencingError(job.id);
    }
    await writeJobLog(
      client,
      job.id,
      "save_result",
      `result.envelopeId=${ensured.envelopeId}`,
      attempt
    );
    log(`save_result: envelopeId=${shortId(ensured.envelopeId)}…`);

    await markDone(job.id, ensured.envelopeId);
    log(`done job ${shortId(job.id)}… → envelope ${shortId(ensured.envelopeId)}…`);
  } finally {
    stopHeartbeat();
    client.release();
  }
}

async function processJob(job: JobRow): Promise<void> {
  log(`claimed job ${shortId(job.id)}… (attempt ${job.attempts})`);

  try {
    if (job.type === "create_offer_draft") {
      await runCreateOfferDraft(job);
    } else {
      throw new Error(`unknown job type: ${job.type}`);
    }
  } catch (err) {
    await markFailure(job, err);
  }
}

// ---------------------------------------------------------------------------
// Main loop + graceful shutdown
// ---------------------------------------------------------------------------

let stopping = false;

async function main(): Promise<void> {
  log(
    `starting (stale=${STALE_SECONDS}s poll=${POLL_MS}ms backoffBase=${BACKOFF_BASE_MS}ms)`
  );

  while (!stopping) {
    try {
      await recoverStaleJobs();
      const job = await claimJob();
      if (job) {
        await processJob(job);
        continue;
      }
    } catch (err) {
      console.error(`[${WORKER_NAME}] tick error:`, err);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log("shutting down…");
  await closePool();
  log("bye");
}

function requestStop(signal: string): void {
  if (stopping) return;
  log(`received ${signal}, will stop after current work…`);
  stopping = true;
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

main().catch(async (err) => {
  console.error(`[${WORKER_NAME}] fatal:`, err);
  await closePool().catch(() => undefined);
  process.exitCode = 1;
});
