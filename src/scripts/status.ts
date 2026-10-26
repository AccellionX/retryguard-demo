/**
 * Print job table + DocuSign mock duplicate check.
 *
 *   tsx src/scripts/status.ts
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { closePool, pool } from "../db.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface JobStatusRow {
  id: string;
  status: string;
  attempts: number;
  last_step: string | null;
  locked_by: string | null;
  completed_by: string | null;
  result: { envelopeId?: string } | null;
}

interface MockEnvelope {
  envelopeId: string;
  customFields?: {
    textCustomFields?: { name: string; value: string }[];
  };
}

function mockBaseUrl(): string {
  return (process.env.DOCUSIGN_BASE_URL ?? "http://localhost:4000").replace(
    /\/$/,
    ""
  );
}

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n - 1) + "…" : s;
  return t.padEnd(n);
}

function envelopeIdFromResult(result: unknown): string {
  if (result && typeof result === "object" && "envelopeId" in result) {
    const id = (result as { envelopeId?: unknown }).envelopeId;
    if (typeof id === "string") return id.slice(0, 8) + "…";
  }
  return "-";
}

/** Fetch mock store; returns [] if mock is down. */
async function fetchMockEnvelopes(): Promise<MockEnvelope[]> {
  try {
    const res = await fetch(`${mockBaseUrl()}/mock/envelopes`);
    if (!res.ok) return [];
    const json = (await res.json()) as { envelopes?: MockEnvelope[] };
    return json.envelopes ?? [];
  } catch {
    return [];
  }
}

function jobIdOf(env: MockEnvelope): string | null {
  const field = env.customFields?.textCustomFields?.find((f) => f.name === "job_id");
  return field?.value ?? null;
}

/** Render status table + duplicate check to stdout. */
export async function printStatus(): Promise<{ duplicates: number }> {
  const { rows } = await pool.query<JobStatusRow>(
    `SELECT id, status, attempts, last_step, locked_by, completed_by, result
     FROM jobs
     ORDER BY created_at`
  );

  console.log("");
  console.log(
    pad("JOB", 10) +
      pad("STATUS", 10) +
      pad("ATTEMPTS", 10) +
      pad("LAST_STEP", 16) +
      pad("WORKER", 14) +
      "ENVELOPE"
  );
  console.log(DIM + "─".repeat(72) + RESET);

  if (rows.length === 0) {
    console.log("(no jobs)");
  } else {
    for (const j of rows) {
      console.log(
        pad(j.id.slice(0, 8) + "…", 10) +
          pad(j.status, 10) +
          pad(String(j.attempts), 10) +
          pad(j.last_step ?? "-", 16) +
          pad(j.completed_by ?? j.locked_by ?? "-", 14) +
          envelopeIdFromResult(j.result)
      );
    }
  }

  const envelopes = await fetchMockEnvelopes();
  const counts = new Map<string, number>();
  for (const env of envelopes) {
    const jobId = jobIdOf(env);
    if (!jobId) continue;
    counts.set(jobId, (counts.get(jobId) ?? 0) + 1);
  }

  console.log("");
  console.log("Duplicate check (envelopes per job_id from GET /mock/envelopes)");
  console.log(DIM + "─".repeat(72) + RESET);

  if (counts.size === 0) {
    console.log("(no tagged envelopes in mock store)");
  } else {
    const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [jobId, n] of sorted) {
      const label = `${jobId.slice(0, 8)}…  × ${n}`;
      console.log(n > 1 ? `${RED}${label}${RESET}` : label);
    }
  }

  let duplicates = 0;
  for (const n of counts.values()) {
    if (n > 1) duplicates += n - 1;
  }

  const dupLine = `DUPLICATES: ${duplicates}`;
  console.log("");
  console.log(
    duplicates > 0 ? `${RED}${dupLine}${RESET}` : `${GREEN}${dupLine}${RESET}`
  );
  console.log("");

  return { duplicates };
}

async function main(): Promise<void> {
  await printStatus();
  await closePool();
}

const isCli =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isCli) {
  main().catch(async (err) => {
    console.error(err);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
}
