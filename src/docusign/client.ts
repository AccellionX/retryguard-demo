/**
 * DocuSign client used by the worker.
 *
 * DOCUSIGN_MODE=mock → local mock server (DOCUSIGN_BASE_URL).
 * DOCUSIGN_MODE=real → DocuSign demo host + JWT auth from env.
 */
import "dotenv/config";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Shared types (worker-facing)
// ---------------------------------------------------------------------------

/** Minimal envelope shape returned by find / reused by ensureEnvelope. */
export interface DocuSignEnvelope {
  envelopeId: string;
  status: string;
  statusDateTime?: string;
  createdDateTime?: string;
}

export interface CreateDraftEnvelopeArgs {
  jobId: string;
  templateId: string;
  subject: string;
}

/**
 * Single interface the worker depends on - swap mock/real via DOCUSIGN_MODE.
 */
export interface DocuSignClient {
  createDraftEnvelope(args: CreateDraftEnvelopeArgs): Promise<{ envelopeId: string }>;
  findEnvelopeByJobId(
    jobId: string,
    fromDate: Date | string
  ): Promise<DocuSignEnvelope | null>;
}

/** Create calls abort after this many ms (mock hang → timeout on our side). */
export function createTimeoutMs(): number {
  return Number(process.env.DOCUSIGN_CREATE_TIMEOUT_MS ?? 5_000) || 5_000;
}

/** @deprecated prefer createTimeoutMs() - kept for callers that imported the const. */
export const CREATE_TIMEOUT_MS = createTimeoutMs();

const DEMO_REST_BASE = "https://demo.docusign.net";
const DEMO_OAUTH_HOST = "account-d.docusign.com";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function mode(): "mock" | "real" {
  const m = (process.env.DOCUSIGN_MODE ?? "mock").toLowerCase();
  if (m !== "mock" && m !== "real") {
    throw new Error(`DOCUSIGN_MODE must be "mock" or "real" (got ${m})`);
  }
  return m;
}

function accountId(): string {
  return requireEnv("DOCUSIGN_ACCOUNT_ID");
}

function restBaseUrl(): string {
  if (mode() === "mock") {
    return (process.env.DOCUSIGN_BASE_URL ?? "http://localhost:4000").replace(
      /\/$/,
      ""
    );
  }
  // Real demo eSignature host (override only if you know what you're doing).
  return (process.env.DOCUSIGN_BASE_URL ?? DEMO_REST_BASE).replace(/\/$/, "");
}

function envelopesUrl(): string {
  return `${restBaseUrl()}/restapi/v2.1/accounts/${accountId()}/envelopes`;
}

function toIso(fromDate: Date | string): string {
  return fromDate instanceof Date ? fromDate.toISOString() : new Date(fromDate).toISOString();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export class DocuSignHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "DocuSignHttpError";
  }
}

export class DocuSignTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? `DocuSign create timed out after ${createTimeoutMs()}ms`);
    this.name = "DocuSignTimeoutError";
  }
}

async function docusignFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  getAuthHeader: () => Promise<string | undefined>
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const auth = await getAuthHeader();
  if (auth) headers.set("Authorization", auth);

  const timeoutMs = init.timeoutMs;
  const { timeoutMs: _drop, ...fetchInit } = init;
  void _drop;

  let signal = fetchInit.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs != null) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    signal = controller.signal;
  }

  try {
    return await fetch(url, { ...fetchInit, headers, signal });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError")
    ) {
      throw new DocuSignTimeoutError();
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// JWT auth (real mode only)
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: TokenCache | null = null;

/** Compact RS256 JWT for DocuSign JWT Grant (no extra deps). */
function signJwtRs256(
  claims: Record<string, string | number>,
  privateKeyPem: string
): string {
  const b64url = (data: Buffer | string) =>
    Buffer.from(data)
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = b64url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

async function getJwtAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 60_000) {
    return tokenCache.accessToken;
  }

  const integrationKey = requireEnv("DOCUSIGN_INTEGRATION_KEY");
  const userId = requireEnv("DOCUSIGN_USER_ID");
  const keyPath = requireEnv("DOCUSIGN_PRIVATE_KEY_PATH");
  const privateKeyPem = await readFile(keyPath, "utf8");
  const oauthHost = process.env.DOCUSIGN_OAUTH_HOST ?? DEMO_OAUTH_HOST;

  const nowSec = Math.floor(now / 1000);
  const assertion = signJwtRs256(
    {
      iss: integrationKey,
      sub: userId,
      aud: oauthHost,
      iat: nowSec,
      exp: nowSec + 3600,
      scope: "signature impersonation",
    },
    privateKeyPem
  );

  const tokenUrl = `https://${oauthHost}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new DocuSignHttpError(
      `DocuSign JWT token exchange failed (${res.status})`,
      res.status,
      text
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  tokenCache = {
    accessToken: json.access_token,
    expiresAtMs: now + json.expires_in * 1000,
  };
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Client implementation (mock + real share the same REST paths)
// ---------------------------------------------------------------------------

function createClient(getAuthHeader: () => Promise<string | undefined>): DocuSignClient {
  return {
    /** Create a draft; always stamps textCustomField job_id for later lookup. */
    async createDraftEnvelope({ jobId, templateId, subject }) {
      const res = await docusignFetch(
        envelopesUrl(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            emailSubject: subject,
            templateId,
            status: "created",
            customFields: {
              textCustomFields: [{ name: "job_id", value: jobId }],
            },
          }),
          // Client timeout: mock's longer "lost response" becomes an error here,
          // while the envelope may already exist on DocuSign's side.
          timeoutMs: createTimeoutMs(),
        },
        getAuthHeader
      );

      if (!res.ok) {
        throw new DocuSignHttpError(
          `createDraftEnvelope failed (${res.status})`,
          res.status,
          await readErrorBody(res)
        );
      }

      const json = (await res.json()) as { envelopeId: string };
      if (!json.envelopeId) {
        throw new Error("createDraftEnvelope: response missing envelopeId");
      }
      return { envelopeId: json.envelopeId };
    },

    /** Search by custom_field=job_id=<uuid> - the retry safety net. */
    async findEnvelopeByJobId(jobId, fromDate) {
      const params = new URLSearchParams({
        from_date: toIso(fromDate),
        custom_field: `job_id=${jobId}`,
      });
      const res = await docusignFetch(
        `${envelopesUrl()}?${params}`,
        { method: "GET" },
        getAuthHeader
      );

      if (!res.ok) {
        throw new DocuSignHttpError(
          `findEnvelopeByJobId failed (${res.status})`,
          res.status,
          await readErrorBody(res)
        );
      }

      const json = (await res.json()) as { envelopes?: DocuSignEnvelope[] };
      const list = json.envelopes ?? [];
      return list[0] ?? null;
    },
  };
}

/** Factory: picks mock (no auth) or real (JWT Bearer) from DOCUSIGN_MODE. */
export function createDocuSignClient(): DocuSignClient {
  if (mode() === "mock") {
    return createClient(async () => undefined);
  }
  return createClient(async () => `Bearer ${await getJwtAccessToken()}`);
}

/** Default singleton for the worker. */
let defaultClient: DocuSignClient | null = null;

export function getDocuSignClient(): DocuSignClient {
  if (!defaultClient) defaultClient = createDocuSignClient();
  return defaultClient;
}
