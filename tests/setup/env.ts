/**
 * Runs before each test file. Forces test DB + mock port so .env does not
 * point workers at the demo database.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://retryguard:change-me@localhost:5432/retryguard_test";
process.env.DOCUSIGN_MODE = "mock";
process.env.DOCUSIGN_BASE_URL =
  process.env.TEST_DOCUSIGN_BASE_URL ?? "http://localhost:4001";
process.env.DOCUSIGN_ACCOUNT_ID = "demo-account";
process.env.WORKER_STALE_SECONDS = process.env.WORKER_STALE_SECONDS ?? "3";
process.env.WORKER_POLL_MS = process.env.WORKER_POLL_MS ?? "100";
process.env.BACKOFF_BASE_MS = process.env.BACKOFF_BASE_MS ?? "200";
process.env.DOCUSIGN_CREATE_TIMEOUT_MS =
  process.env.DOCUSIGN_CREATE_TIMEOUT_MS ?? "800";
process.env.MOCK_TIMEOUT_MS = process.env.MOCK_TIMEOUT_MS ?? "2000";
process.env.CRASH_FLAG_PATH =
  process.env.CRASH_FLAG_PATH ??
  `${process.cwd()}/data/test-crashed.flag`;
process.env.MOCK_STORE_PATH =
  process.env.MOCK_STORE_PATH ??
  `${process.cwd()}/data/test-mock-envelopes.json`;
