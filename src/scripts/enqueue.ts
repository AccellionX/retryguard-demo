/**
 * Enqueue create_offer_draft jobs with fake property payloads.
 *
 *   tsx src/scripts/enqueue.ts --count=3
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { closePool, pool } from "../db.js";

const STREETS = [
  "Oak Avenue",
  "Maple Street",
  "Pine Road",
  "Cedar Lane",
  "Willow Court",
  "Birch Boulevard",
  "Elm Drive",
  "Ash Way",
];

const TEMPLATE_ID = "offer-template-demo";

function parseCount(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--count="));
  if (flag) {
    const n = Number(flag.slice("--count=".length));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  }
  const idx = argv.indexOf("--count");
  if (idx >= 0) {
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  }
  return 1;
}

function fakeProperty(i: number): {
  templateId: string;
  subject: string;
  address: string;
  price: number;
  offerAmount: number;
} {
  const street = STREETS[i % STREETS.length]!;
  const number = 100 + i * 17;
  const address = `${number} ${street}`;
  const price = 350_000 + i * 25_000;
  const offerAmount = Math.round(price * 0.97);
  return {
    templateId: TEMPLATE_ID,
    subject: `Offer draft - ${address}`,
    address,
    price,
    offerAmount,
  };
}

/** Insert N create_offer_draft jobs; returns their ids. */
export async function enqueueJobs(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const payload = fakeProperty(i);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status)
       VALUES ('create_offer_draft', $1::jsonb, 'queued')
       RETURNING id`,
      [JSON.stringify(payload)]
    );
    const id = rows[0]!.id;
    ids.push(id);
    console.log(
      `enqueued ${id.slice(0, 8)}…  ${payload.address}` +
        `  list $${payload.price.toLocaleString()}` +
        `  offer $${payload.offerAmount.toLocaleString()}`
    );
  }
  return ids;
}

async function main(): Promise<void> {
  const count = parseCount(process.argv.slice(2));
  console.log(`Enqueueing ${count} create_offer_draft job(s)…`);
  await enqueueJobs(count);
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
