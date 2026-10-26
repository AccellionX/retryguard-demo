-- RetryGuard initial schema: durable jobs + append-only logs.
-- gen_random_uuid() is available in PostgreSQL 13+ without extensions.

CREATE TABLE IF NOT EXISTS jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- queued | running | done | failed | dead
  status       text        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 5,
  locked_by    text,
  locked_at    timestamptz,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  last_step    text,
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Workers claim the next runnable job by status + schedule time.
CREATE INDEX IF NOT EXISTS jobs_status_next_run_at_idx
  ON jobs (status, next_run_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id         bigserial   PRIMARY KEY,
  job_id     uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  worker     text,
  step       text,
  message    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_logs_job_id_idx ON job_logs (job_id);
