-- 012 — circular checks recorded like exchange pulls, and issues created from them.
--
-- Three things:
--   1. every check is a row, so "when did we last see NSE answer?" is answerable
--      months later rather than only until the next poll overwrites the state;
--   2. consecutive failures are counted, so a blocked poller backs off instead of
--      knocking on NSE's door every fifteen minutes for a week;
--   3. an issue created automatically from a circular is marked as such, because it
--      is INCOMPLETE - the floor price and windows live in the PDF - and must never
--      be biddable until a person has finished it.

CREATE TABLE IF NOT EXISTS ofs.ofs_circular_run (
  id           bigserial   PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  trigger      text        NOT NULL DEFAULT 'manual',   -- manual | schedule | startup
  actor        text,
  status       text        NOT NULL DEFAULT 'ok',       -- ok | unchanged | failed
  http_status  int,
  duration_ms  int,
  items        int         NOT NULL DEFAULT 0,          -- circulars in the feed
  matched      int         NOT NULL DEFAULT 0,          -- looked like an OFS
  inserted     int         NOT NULL DEFAULT 0,          -- new to us
  issues_made  int         NOT NULL DEFAULT 0,          -- provisional issues created
  alerted      int         NOT NULL DEFAULT 0,
  bytes        int,
  steps        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error        text,
  CONSTRAINT ofs_circular_run_status_ck  CHECK (status IN ('ok','unchanged','failed')),
  CONSTRAINT ofs_circular_run_trigger_ck CHECK (trigger IN ('manual','schedule','startup'))
);
CREATE INDEX IF NOT EXISTS ofs_circular_run_started_ix ON ofs.ofs_circular_run (started_at DESC);

-- Backoff state. Reset to 0 on any successful answer.
ALTER TABLE ofs.ofs_feed_state ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE ofs.ofs_feed_state ADD COLUMN IF NOT EXISTS next_poll_at timestamptz;

-- An issue the app created from a circular, before anyone has checked it.
ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS review_note text;
CREATE INDEX IF NOT EXISTS ofs_issue_review_ix ON ofs.ofs_issue (needs_review) WHERE needs_review;

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('circulars_autocreate', '1',
   'Create a provisional (non-biddable) issue automatically when an OFS circular is found')
ON CONFLICT (key) DO NOTHING;
