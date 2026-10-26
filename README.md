# RetryGuard

RetryGuard is a small TypeScript demo of **durable background jobs** that create DocuSign draft envelopes without duplicating them when workers crash, time out, or lose the HTTP response. Jobs live in Postgres; workers claim them with `FOR UPDATE SKIP LOCKED`; before every create they look up an existing envelope tagged with the job’s id so retries reuse work instead of sending twice.

## Architecture

```
                    ┌─────────────────┐
   enqueue / demo   │   Dashboard     │  :3000
   buttons / CLI ──▶│   (Express UI)  │
                    └────────┬────────┘
                             │ INSERT jobs
                             ▼
                    ┌─────────────────┐
                    │    Postgres     │  :5432
                    │  jobs + job_logs│
                    └────────┬────────┘
                             │ claim (SKIP LOCKED)
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         worker A       worker B       worker …
              │
              │  validate → ensure_envelope → save_result
              ▼
                    ┌─────────────────┐
                    │ DocuSign client │  DOCUSIGN_MODE=
                    │  mock | real    │  mock | real
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
     mock server :4000              demo.docusign.net
     (local eSign shape)            (JWT Grant)
```

## How retries stay safe

DocuSign create is a **side effect**. If the API succeeds but our process dies (or the response times out), a naive retry creates a second envelope.

RetryGuard treats `jobs.id` as an **idempotency key held on DocuSign**:

1. **Tag on create** - every draft gets a text custom field `job_id = <job uuid>`.
2. **Lookup before create** - `ensureEnvelope` calls `findEnvelopeByJobId` first; if one exists, it reuses it and never creates again.
3. **Stale lock recovery** - a crashed worker leaves `status=running`; after `WORKER_STALE_SECONDS` another worker requeues the job (`recoverStaleJobs`) so work continues.
4. **Backoff** - transient failures requeue with `next_run_at = now() + 2^attempts` seconds.
5. **Dead letter** - after `max_attempts`, status becomes `dead` (no more retries); inspect `error` / `job_logs`.

Live walkthrough anchors: `claimJob` and `recoverStaleJobs` in `src/worker.ts`, `ensureEnvelope` in `src/steps/ensureEnvelope.ts`.

## How to run

**Prereqs:** Node 18+, Docker (for Postgres), npm.

```bash
# 1. Env + database
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate

# 2. Mock DocuSign (keep this running)
npm run mock:start

# 3. Dashboard (optional - buttons run demos)
npm run dashboard
# open http://localhost:3000
```

### Demo commands (CLI)

With Postgres + mock already up:

| Command | What it shows |
|---|---|
| `npm run demo:normal` | 1 worker, 3 jobs, clean success |
| `npm run demo:crash` | Crash after create → restart → stale lock → **reuse** envelope |
| `npm run demo:timeout` | Mock “loses” first create response → retry finds existing |
| `npm run demo:concurrent` | Workers A + B on 5 jobs; each job claimed once |

Helpers:

```bash
npm run enqueue -- --count=3
npm run status          # table + DUPLICATES: N
npm run worker -- --name=A
```

## Testing

Automated suite (Vitest) uses a **separate** Postgres database `retryguard_test` and mock DocuSign on port **4001**, so demo data on `:5432/retryguard` + `:4000` is not touched.

```bash
# Postgres must already be up (docker compose up -d)
npm test
```

What the suite covers: happy path, idempotent envelope reuse, crash + stale lock recovery, lost-response timeouts, concurrency / SKIP LOCKED, backoff + dead letter, lease heartbeat/fencing, search-lag handling, negative control (`DISABLE_LOOKUP=1` must produce duplicates), data integrity, dashboard API, and demo scripts.

Test knobs (defaults applied by the harness): `WORKER_STALE_SECONDS=3`, `BACKOFF_BASE_MS=200`, `DOCUSIGN_CREATE_TIMEOUT_MS=800`.

## Switching to real DocuSign (`DOCUSIGN_MODE=real`)

Same client interface; set env and point at the demo host:

```bash
DOCUSIGN_MODE=real
DOCUSIGN_BASE_URL=https://demo.docusign.net
DOCUSIGN_OAUTH_HOST=account-d.docusign.com
DOCUSIGN_ACCOUNT_ID=<your-api-account-id>
DOCUSIGN_INTEGRATION_KEY=<integration-key / client id>
DOCUSIGN_USER_ID=<user guid to impersonate>
DOCUSIGN_PRIVATE_KEY_PATH=./secrets/docusign-private.key
```

Grant JWT consent for the integration key once in the DocuSign admin UI. Create calls still use a **5s** client timeout; templates/custom fields must exist on the account (`job_id` text custom field on envelopes).

## Known limitations / what production adds

This repo is a teaching demo, not a production worker fleet.

| Demo | Production typically adds |
|---|---|
| Console logs + dashboard | Metrics (queue depth, attempt histograms), structured logs, tracing |
| Silent `dead` rows | Alerts / paging on dead-letter growth |
| Fixed `2^attempts` backoff | Jitter + **rate-limit-aware** backoff (honor `Retry-After` / 429) |
| Single-region Postgres | HA queue, outbox patterns, poison-pill tooling |
| Mock or manual JWT | Secret rotation, scoped IAM, audit of every DocuSign call |
| Stale lock TTL heuristic | Heartbeats / lease renewal so long steps don’t look “stale” |

## Project map

```
src/worker.ts              claim / stale recover / run steps
src/steps/ensureEnvelope.ts idempotent DocuSign step
src/docusign/client.ts      mock + real API client
src/mock-docusign/          local eSign stub (:4000)
src/dashboard/              UI + API (:3000)
src/scripts/                enqueue, status, demo scenarios
migrations/001_init.sql     jobs + job_logs
```
