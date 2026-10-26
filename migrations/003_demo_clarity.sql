-- completed_by: who finished the job (shown in dashboard Worker column when done)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS completed_by text;

-- attempt: which claim/attempt produced this log line (shown as #1, #2 in live log)
ALTER TABLE job_logs
  ADD COLUMN IF NOT EXISTS attempt int;
