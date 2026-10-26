-- Intent row written before DocuSign create so retries can wait out search lag
-- instead of creating a duplicate when listing is temporarily stale.
CREATE TABLE IF NOT EXISTS pending_envelopes (
  job_id     uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
