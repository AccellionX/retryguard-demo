/**
 * Mock DocuSign eSignature REST API (v2.1) for local RetryGuard demos.
 *
 * Mimics create + list envelopes, persists to data/mock-envelopes.json,
 * and can simulate lost responses (504 after save) or hard failures (500).
 *
 * Start: npm run mock:start  (listens on port 4000 by default)
 */
import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TextCustomField {
  name: string;
  value: string;
}

interface Envelope {
  envelopeId: string;
  accountId: string;
  status: string;
  emailSubject?: string;
  templateId?: string;
  createdDateTime: string;
  statusDateTime: string;
  customFields?: {
    textCustomFields?: TextCustomField[];
  };
  /** ISO time when this envelope becomes visible to list/search (search lag). */
  searchVisibleAt?: string;
}

interface MockConfig {
  failRate: number;
  timeoutRate: number;
  timeoutOnce: boolean;
  /** Hide newly created envelopes from search for this many ms. */
  searchLagMs: number;
}

interface CreateEnvelopeBody {
  emailSubject?: string;
  templateId?: string;
  status?: string;
  customFields?: {
    textCustomFields?: TextCustomField[];
  };
}

// ---------------------------------------------------------------------------
// Paths & defaults
// ---------------------------------------------------------------------------

const STORE_PATH =
  process.env.MOCK_STORE_PATH ??
  join(process.cwd(), "data", "mock-envelopes.json");
const PORT = Number(process.env.MOCK_DOCUSIGN_PORT ?? 4000);
const TIMEOUT_MS = Number(process.env.MOCK_TIMEOUT_MS ?? 10_000) || 10_000;

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function clampRate(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const config: MockConfig = {
  failRate: clampRate(process.env.MOCK_FAIL_RATE, 0),
  timeoutRate: clampRate(process.env.MOCK_TIMEOUT_RATE, 0),
  timeoutOnce: false,
  searchLagMs: Number(process.env.MOCK_SEARCH_LAG_MS ?? 0) || 0,
};

/** In-memory envelope list; mirrored to STORE_PATH on every write. */
let envelopes: Envelope[] = [];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function loadStore(): Promise<void> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      envelopes = parsed as Envelope[];
      console.log(`[store] loaded ${envelopes.length} envelope(s) from ${STORE_PATH}`);
    } else {
      console.warn("[store] unexpected JSON shape; starting empty");
      envelopes = [];
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log("[store] no existing file; starting empty");
      envelopes = [];
      return;
    }
    throw err;
  }
}

async function saveStore(): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(envelopes, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chance(rate: number): boolean {
  return rate > 0 && Math.random() < rate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function customFieldValue(env: Envelope, name: string): string | undefined {
  return env.customFields?.textCustomFields?.find((f) => f.name === name)?.value;
}

function parseCustomFieldFilter(raw: unknown): { name: string; value: string } | null {
  if (typeof raw !== "string" || !raw.includes("=")) return null;
  const eq = raw.indexOf("=");
  const name = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!name) return null;
  return { name, value };
}

function stamp(): string {
  return new Date().toISOString();
}

function isSearchVisible(env: Envelope): boolean {
  if (!env.searchVisibleAt) return true;
  return Date.now() >= Date.parse(env.searchVisibleAt);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  const bodyPreview =
    req.method === "GET" || req.method === "HEAD"
      ? ""
      : ` body=${JSON.stringify(req.body)}`;
  console.log(`[${stamp()}] ${req.method} ${req.originalUrl}${bodyPreview}`);
  next();
});

app.post(
  "/restapi/v2.1/accounts/:accountId/envelopes",
  async (req: Request, res: Response) => {
    const accountId = param(req.params.accountId!);
    const body = (req.body ?? {}) as CreateEnvelopeBody;

    if (chance(config.failRate)) {
      console.log(
        `[create] FAIL simulated (failRate=${config.failRate}) - no envelope stored`
      );
      res.status(500).json({
        errorCode: "MOCK_FAIL",
        message: "Simulated DocuSign failure before create",
      });
      return;
    }

    const now = stamp();
    const lag = config.searchLagMs;
    const envelope: Envelope = {
      envelopeId: randomUUID(),
      accountId,
      status: body.status === "sent" ? "sent" : "created",
      emailSubject: body.emailSubject,
      templateId: body.templateId,
      createdDateTime: now,
      statusDateTime: now,
      customFields: body.customFields,
      searchVisibleAt:
        lag > 0 ? new Date(Date.now() + lag).toISOString() : undefined,
    };

    envelopes.push(envelope);
    await saveStore();
    console.log(
      `[create] saved envelopeId=${envelope.envelopeId} accountId=${accountId}` +
        ` job_id=${customFieldValue(envelope, "job_id") ?? "(none)"}` +
        (lag > 0 ? ` searchLagMs=${lag}` : "")
    );

    if (chance(config.timeoutRate)) {
      if (config.timeoutOnce) {
        config.timeoutRate = 0;
        config.timeoutOnce = false;
        console.log(
          "[create] timeoutOnce consumed - later creates return normally"
        );
      }
      console.log(
        `[create] TIMEOUT simulated - waiting ${TIMEOUT_MS}ms then 504` +
          ` (envelope already saved)`
      );
      await sleep(TIMEOUT_MS);
      res.status(504).json({
        errorCode: "MOCK_TIMEOUT",
        message:
          "Simulated lost DocuSign response after successful create (gateway timeout)",
        envelopeId: envelope.envelopeId,
      });
      return;
    }

    res.status(201).json({
      envelopeId: envelope.envelopeId,
      status: envelope.status,
      statusDateTime: envelope.statusDateTime,
    });
  }
);

app.get(
  "/restapi/v2.1/accounts/:accountId/envelopes",
  (req: Request, res: Response) => {
    const accountId = param(req.params.accountId!);
    const fromDate =
      typeof req.query.from_date === "string" ? req.query.from_date : undefined;
    const cf = parseCustomFieldFilter(req.query.custom_field);

    // Search lag: hide envelopes until searchVisibleAt.
    let list = envelopes.filter(
      (e) => e.accountId === accountId && isSearchVisible(e)
    );

    if (fromDate) {
      const fromMs = Date.parse(fromDate);
      if (!Number.isNaN(fromMs)) {
        list = list.filter((e) => Date.parse(e.createdDateTime) >= fromMs);
      }
    }

    if (cf) {
      list = list.filter((e) => customFieldValue(e, cf.name) === cf.value);
    }

    console.log(
      `[list] accountId=${accountId} from_date=${fromDate ?? "(any)"}` +
        ` custom_field=${cf ? `${cf.name}=${cf.value}` : "(any)"} → ${list.length}`
    );

    res.json({ envelopes: list });
  }
);

/** Full store (ignores search lag) for dashboard / duplicate checks. */
app.get("/mock/envelopes", (_req: Request, res: Response) => {
  console.log(`[mock] list all → ${envelopes.length}`);
  res.json({ envelopes });
});

app.post("/mock/reset", async (_req: Request, res: Response) => {
  envelopes = [];
  await saveStore();
  config.failRate = 0;
  config.timeoutRate = 0;
  config.timeoutOnce = false;
  config.searchLagMs = 0;
  console.log("[mock] store cleared");
  res.json({ ok: true, envelopes: 0 });
});

app.post("/mock/config", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<MockConfig>;
  if (body.failRate !== undefined) {
    config.failRate = clampRate(body.failRate, config.failRate);
  }
  if (body.timeoutRate !== undefined) {
    config.timeoutRate = clampRate(body.timeoutRate, config.timeoutRate);
  }
  if (body.timeoutOnce !== undefined) {
    config.timeoutOnce = Boolean(body.timeoutOnce);
  }
  if (body.searchLagMs !== undefined) {
    const n = Number(body.searchLagMs);
    config.searchLagMs = Number.isFinite(n) && n >= 0 ? n : config.searchLagMs;
  }
  console.log(
    `[mock] config → failRate=${config.failRate}` +
      ` timeoutRate=${config.timeoutRate} timeoutOnce=${config.timeoutOnce}` +
      ` searchLagMs=${config.searchLagMs}`
  );
  res.json({ ...config });
});

app.get("/mock/config", (_req: Request, res: Response) => {
  res.json({ ...config });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);
  res.status(500).json({
    errorCode: "MOCK_INTERNAL",
    message: err instanceof Error ? err.message : "Internal error",
  });
});

await loadStore();

app.listen(PORT, () => {
  console.log(
    `[mock-docusign] listening on http://localhost:${PORT}` +
      `  failRate=${config.failRate} timeoutRate=${config.timeoutRate}` +
      ` timeoutMs=${TIMEOUT_MS}`
  );
  console.log(`[mock-docusign] store file: ${STORE_PATH}`);
});
